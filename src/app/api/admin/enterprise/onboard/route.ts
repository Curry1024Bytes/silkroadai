import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { applyLedgerEntry } from '@/lib/billing/ledger';
import { encryptUpstreamKey } from '@/lib/enterprise/crypto';
import { generateEnterpriseKey } from '@/lib/enterprise/keys';

export const runtime = 'nodejs';

/**
 * POST /api/admin/enterprise/onboard — 独立门户大客户手工开户(P1,决策 Q5:admin 先行)。
 *
 * 一次做完:User(billing_mode='portal',无密码,邮箱视为已验证)+ 独立上游 key(AES 加密存)
 * + 第一把 sk-ent- key(明文只在本响应返一次)+ 可选首笔入账(¥账本 recharge)。
 *
 * 守门:superadmin(资金/开户敏感;break-glass x-admin-token 也过,VPS 本机 curl 用)。
 * User+上游key+客户key 三件套一个事务原子建;入账在事务外(applyLedgerEntry 自带事务),
 * 入账失败不回滚开户 —— 响应里如实报 credit_error,再单独调 credit 端点补。
 *
 * ⚠️ 不碰 new-api:不 provisionNewCustomer、无 newapi_user_id —— 独立门户全链路脱离 new-api(决策①)。
 */
const onboardSchema = z.object({
    email: z.string().trim().email().max(50),
    name: z.string().trim().min(1).max(50).optional(), // 客户名(nickname + key 名前缀)
    upstream_key: z.string().trim().min(8).max(200), // 该客户国内版上游 key(token.xinhankr)
    upstream_note: z.string().trim().max(200).optional(), // 上游侧对账备注
    // 海外上游 key(2026-07-24):global 与 promax 两渠道同 base 同 key(ai.artsmcp),
    // 填一把即同时写 global + promax 两行(各自独立折扣,默认 1)。可空 = 只开国内。
    overseas_upstream_key: z.string().trim().min(8).max(200).optional(),
    overseas_note: z.string().trim().max(200).optional(),
    credit_cny: z.number().positive().max(1_000_000).optional(), // 首笔入账(可选)
    note: z.string().trim().max(500).optional(), // 入账备注
});

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = onboardSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { email, name, upstream_key, upstream_note, overseas_upstream_key, overseas_note, credit_cny, note } =
        parsed.data;

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
        return NextResponse.json({ error: 'email_exists', user_id: existing.id }, { status: 409 });
    }

    // 加密先行(env 未配 → 明确报错,不建半套账户)
    let upstreamEnc: string;
    let overseasEnc: string | null = null;
    try {
        upstreamEnc = encryptUpstreamKey(upstream_key);
        if (overseas_upstream_key) overseasEnc = encryptUpstreamKey(overseas_upstream_key);
    } catch (e) {
        return NextResponse.json({ error: 'enc_key_not_configured', detail: String(e) }, { status: 500 });
    }

    const generated = generateEnterpriseKey();
    const user = await prisma.$transaction(async (tx) => {
        const u = await tx.user.create({
            data: {
                email,
                password_hash: null, // P2 dashboard 上线前无登录;届时走 forgot-password 设密
                email_verified: true,
                email_verified_at: new Date(),
                nickname: name ?? null,
                billing_mode: 'portal', // 余额唯一真相 = Account ¥账本(决策①,不碰 new-api)
            },
            select: { id: true, tenant_id: true },
        });
        await tx.enterpriseUpstreamKey.create({
            data: { user_id: u.id, region: 'cn', upstream_key_enc: upstreamEnc, note: upstream_note ?? null },
        });
        if (overseasEnc) {
            // global 与 promax 同 base 同 key,一把写两行(折扣各自独立,默认 1)
            for (const region of ['global', 'promax'] as const) {
                await tx.enterpriseUpstreamKey.create({
                    data: {
                        user_id: u.id,
                        region,
                        upstream_key_enc: overseasEnc,
                        note: overseas_note ?? '海外(global+proMax 共用)',
                    },
                });
            }
        }
        await tx.enterpriseKey.create({
            data: {
                user_id: u.id,
                tenant_id: u.tenant_id,
                key_hash: generated.hash,
                key_prefix: generated.prefix,
                name: name ? `${name}-default` : 'default',
            },
        });
        return u;
    });

    let balanceAfter: string | null = null;
    let creditError: string | null = null;
    if (credit_cny) {
        try {
            const r = await applyLedgerEntry(user.id, {
                kind: 'recharge',
                amount_cny: credit_cny,
                ref: null, // 手工入账不去重(同客户可多笔);对账靠 note + LedgerEntry 流水
                note: note ?? 'enterprise onboard credit',
                createdBy: admin.user?.id ?? null,
                tenantId: user.tenant_id,
            });
            balanceAfter = r.balance_after.toFixed(2);
        } catch (e) {
            creditError = e instanceof Error ? e.message : String(e);
            console.error('[enterprise-onboard] credit failed (account created, retry via credit endpoint)', e);
        }
    }

    return NextResponse.json({
        user_id: user.id,
        email,
        regions: overseasEnc ? ['cn', 'global', 'promax'] : ['cn'],
        // ⚠️ 明文 key 只在这里返回一次(DB 只存 sha256)—— 保存后即无法找回,只能重发。
        key: generated.key,
        key_prefix: generated.prefix,
        balance_after: balanceAfter,
        credit_error: creditError,
    });
}
