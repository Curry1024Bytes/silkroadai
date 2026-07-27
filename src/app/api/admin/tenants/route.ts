import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { normalizeHost } from '@/lib/tenant/resolve';

export const runtime = 'nodejs';

/**
 * /api/admin/tenants — 租户管理(P6a)。**仅 superadmin**(租户管理是平台超管专属,
 * 不是普通 admin —— partner admin 不能建/改租户)。不做定价/计费/预付池扣减(P6c)。
 */

const slugRe = /^[a-z0-9-]+$/;
const colorRe = /^#[0-9a-fA-F]{6}$/;

/** 域名规范化 + 去重(小写、剥端口/尾点),与 resolveTenantByHost 的匹配口径一致。 */
function normalizeDomains(domains: string[] | undefined): string[] {
    if (!domains) return [];
    const seen = new Set<string>();
    for (const d of domains) {
        const n = normalizeHost(d);
        if (n) seen.add(n);
    }
    return Array.from(seen);
}

const createSchema = z.object({
    slug: z
        .string()
        .min(2)
        .max(40)
        .transform((s) => s.trim().toLowerCase())
        .refine((s) => slugRe.test(s), 'slug 只能是小写字母/数字/连字符'),
    brand_name: z.string().min(1).max(100),
    primary_domain: z.string().max(253).nullable().optional(),
    domains: z.array(z.string().max(253)).max(20).optional(),
    logo_url: z.string().url().max(500).nullable().optional(),
    primary_color: z.string().regex(colorRe, '需 #RRGGBB 十六进制色值').nullable().optional(),
    support_email: z.string().email().max(254).nullable().optional(),
    support_wechat: z.string().max(64).nullable().optional(),
    signup_enabled: z.boolean().optional().default(true),
    status: z.enum(['active', 'suspended']).optional().default('active'),
});

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const tenants = await prisma.tenant.findMany({ orderBy: { created_at: 'asc' } });
    return NextResponse.json({ tenants });
}

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const d = parsed.data;

    const dup = await prisma.tenant.findUnique({ where: { slug: d.slug }, select: { id: true } });
    if (dup) return NextResponse.json({ error: `slug "${d.slug}" 已存在` }, { status: 409 });

    const primaryDomain = d.primary_domain ? normalizeHost(d.primary_domain) || null : null;
    const tenant = await prisma.tenant.create({
        data: {
            slug: d.slug,
            brand_name: d.brand_name,
            primary_domain: primaryDomain,
            domains: normalizeDomains(d.domains),
            logo_url: d.logo_url ?? null,
            primary_color: d.primary_color ?? undefined, // undefined → schema default #17201E
            support_email: d.support_email ?? null,
            support_wechat: d.support_wechat ?? null,
            signup_enabled: d.signup_enabled,
            status: d.status,
            // prepaid_balance_cny defaults to 0; pool top-up is P6c, not here.
        },
    });
    return NextResponse.json({ tenant }, { status: 201 });
}
