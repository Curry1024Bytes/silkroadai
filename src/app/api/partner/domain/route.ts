import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import dns from 'dns/promises';
import { randomBytes } from 'crypto';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { normalizeHost } from '@/lib/tenant/resolve';

export const runtime = 'nodejs';

/**
 * /api/partner/domain — 代理绑定自有域名。
 *
 * 归属验证用 TXT 记录（`_llmroute-verify.<域名>` = 平台随机 token），CNAME 指向平台只作为
 * 访问链路提示：多数代理会把域名放在 Cloudflare 代理后面，这时 CNAME 查不到。
 * 只有 TXT 验证通过才写进租户域名列表生效；换域名时旧主域名从列表移除。
 */

/** CNAME 目标：代理用户在 DNS 服务商配置 CNAME 时填写的目标 */
const CNAME_TARGET = process.env.PARTNER_CNAME_TARGET ?? 'custom.llmroute.club';
const TXT_PREFIX = '_llmroute-verify';
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const setDomainSchema = z.object({
    domain: z.string().min(4).max(253),
});

async function partnerTenant(request: NextRequest) {
    const admin = await resolveAdmin(request, 'staff');
    if (!admin) return { error: unauthorizedResponse(request) };
    if (!admin.tenant_id || admin.tenant_id === PLATFORM_TENANT_ID) {
        return { error: NextResponse.json({ error: '仅白标代理可访问' }, { status: 403 }) };
    }
    return { tenantId: admin.tenant_id };
}

function txtName(domain: string): string {
    return `${TXT_PREFIX}.${domain}`;
}

function instructions(claim: { domain: string; token: string } | null, cnameTarget: string) {
    if (!claim) return null;
    return {
        domain: claim.domain,
        txt: { host: txtName(claim.domain), type: 'TXT', value: claim.token, ttl: 600 },
        cname: { host: claim.domain, type: 'CNAME', value: cnameTarget, ttl: 600 },
    };
}

export async function GET(request: NextRequest) {
    const auth = await partnerTenant(request);
    if (auth.error) return auth.error;
    const tenantId = auth.tenantId!;

    const [tenant, claim] = await Promise.all([
        prisma.tenant.findUnique({ where: { id: tenantId }, select: { primary_domain: true, domains: true } }),
        prisma.partnerDomainClaim.findUnique({ where: { tenant_id: tenantId } }),
    ]);
    if (!tenant) return NextResponse.json({ error: '租户不存在' }, { status: 404 });

    return NextResponse.json({
        primary_domain: tenant.primary_domain,
        domains: tenant.domains,
        cname_target: CNAME_TARGET,
        pending: instructions(claim, CNAME_TARGET),
    });
}

export async function POST(request: NextRequest) {
    const auth = await partnerTenant(request);
    if (auth.error) return auth.error;
    const tenantId = auth.tenantId!;

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }

    // POST { action: 'verify' } — 按待验证的域名核对 TXT（归属）与 CNAME（访问链路）
    if (typeof body === 'object' && body !== null && (body as Record<string, unknown>).action === 'verify') {
        const claim = await prisma.partnerDomainClaim.findUnique({ where: { tenant_id: tenantId } });
        if (!claim) return NextResponse.json({ error: 'no_pending_domain', message: '没有待验证的域名' }, { status: 400 });

        let txtRecords: string[] = [];
        let cnameRecords: string[] = [];
        let txtOk = false;
        try {
            const records = await dns.resolveTxt(txtName(claim.domain));
            txtRecords = records.map((parts) => parts.join(''));
            txtOk = txtRecords.some((value) => value.trim() === claim.token);
        } catch (err) {
            txtRecords = [err instanceof Error ? err.message : String(err)];
        }
        try {
            cnameRecords = await dns.resolveCname(claim.domain);
        } catch {
            cnameRecords = [];
        }
        const cnameOk = cnameRecords.some((value) => normalizeHost(value) === normalizeHost(CNAME_TARGET));
        if (!txtOk) {
            return NextResponse.json({
                verified: false,
                txt_ok: false,
                cname_ok: cnameOk,
                txt_records: txtRecords,
                cname_records: cnameRecords,
                cname_target: CNAME_TARGET,
            });
        }

        // TXT 证明域名归属；再确认没有被别人占用后才写进租户域名列表。
        const conflict = await prisma.tenant.findFirst({
            where: {
                id: { not: tenantId },
                OR: [{ primary_domain: claim.domain }, { domains: { has: claim.domain } }],
            },
            select: { id: true },
        });
        if (conflict) {
            return NextResponse.json({ error: 'domain_taken', message: '该域名已被其他站点使用' }, { status: 409 });
        }
        const platform = await prisma.tenant.findUnique({
            where: { id: PLATFORM_TENANT_ID },
            select: { primary_domain: true, domains: true },
        });
        if (
            platform &&
            (platform.primary_domain === claim.domain || platform.domains.includes(claim.domain))
        ) {
            return NextResponse.json({ error: 'domain_taken', message: '该域名属于平台' }, { status: 409 });
        }

        const updated = await prisma.$transaction(async (tx) => {
            const current = await tx.tenant.findUnique({
                where: { id: tenantId },
                select: { primary_domain: true, domains: true },
            });
            if (!current) throw new Error('tenant missing');
            const oldPrimary = current.primary_domain;
            const domains = current.domains.filter((domain) => domain !== claim.domain && domain !== oldPrimary);
            domains.push(claim.domain);
            const tenant = await tx.tenant.update({
                where: { id: tenantId },
                data: { primary_domain: claim.domain, domains },
                select: { primary_domain: true, domains: true },
            });
            await tx.partnerDomainClaim.delete({ where: { tenant_id: tenantId } });
            return tenant;
        });

        return NextResponse.json({
            verified: true,
            txt_ok: true,
            cname_ok: cnameOk,
            cname_records: cnameRecords,
            cname_target: CNAME_TARGET,
            primary_domain: updated.primary_domain,
            domains: updated.domains,
            pending: null,
        });
    }

    // POST { domain } — 生成待验证的域名与 TXT token（不生效）
    const parsed = setDomainSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten().fieldErrors }, { status: 400 });
    }
    const normalized = normalizeHost(parsed.data.domain);
    if (!DOMAIN_RE.test(normalized)) {
        return NextResponse.json({ error: 'invalid_domain', message: '域名格式无效' }, { status: 400 });
    }

    const [conflict, platform, claimedByOther] = await Promise.all([
        prisma.tenant.findFirst({
            where: {
                id: { not: tenantId },
                OR: [{ primary_domain: normalized }, { domains: { has: normalized } }],
            },
            select: { id: true },
        }),
        prisma.tenant.findUnique({
            where: { id: PLATFORM_TENANT_ID },
            select: { primary_domain: true, domains: true },
        }),
        prisma.partnerDomainClaim.findFirst({ where: { domain: normalized, tenant_id: { not: tenantId } }, select: { tenant_id: true } }),
    ]);
    if (conflict || claimedByOther || (platform && (platform.primary_domain === normalized || platform.domains.includes(normalized)))) {
        return NextResponse.json({ error: 'domain_taken', message: '该域名已被其他站点使用' }, { status: 409 });
    }

    const token = randomBytes(16).toString('hex');
    const claim = await prisma.partnerDomainClaim.upsert({
        where: { tenant_id: tenantId },
        create: { tenant_id: tenantId, domain: normalized, token },
        update: { domain: normalized, token, created_at: new Date() },
        select: { domain: true, token: true },
    });

    return NextResponse.json({ pending: instructions(claim, CNAME_TARGET), cname_target: CNAME_TARGET });
}
