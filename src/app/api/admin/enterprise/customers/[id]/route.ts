import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { ENTERPRISE_TIER } from '@/lib/enterprise/billing';

export const runtime = 'nodejs';

const PatchSchema = z.object({
    // 客户级整体折扣率:0.05~2(>1 = 上浮),1 = 无折扣。挂牌 × discount;单档 override 不受影响。
    discount: z.number().min(0.05).max(2),
    // 版本(2026-07-23):每版本独立折扣,缺省 cn
    region: z.enum(['cn', 'global', 'promax', 'volc']).default('cn'),
});

/** PATCH /api/admin/enterprise/customers/[id] — 设客户级折扣率(按版本)。守门:superadmin。 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const { id } = await params;

    const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_request', detail: 'discount 须为 0.05~2 的数字' }, { status: 400 });
    }
    const updated = await prisma.enterpriseUpstreamKey.updateMany({
        where: { user_id: id, region: parsed.data.region },
        data: { discount: parsed.data.discount },
    });
    if (updated.count === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, region: parsed.data.region, discount: parsed.data.discount });
}

/**
 * DELETE /api/admin/enterprise/customers/[id] — 软删除账号(2026-08-08)。守门:superadmin。
 * 撤销全部访问 + 从客户列表隐藏,但【保留】流水/任务/余额/素材(审计/对账),可人工恢复。
 *   1. enterprise_upstream_keys: 全部行 deleted_at=now(隐藏 + account-level 拒调用)
 *   2. enterprise_keys / enterprise_ak_sk: 全部 status=disabled(sk-ent / AK-SK 立即 401)
 *   3. users.status=disabled(dashboard 登录立即被拒)
 * 幂等:重复删无副作用。
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const { id } = await params;

    // 必须是企业客户(有 upstream key 行);否则 404
    const upCount = await prisma.enterpriseUpstreamKey.count({ where: { user_id: id } });
    if (upCount === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const now = new Date();
    const [ups, keys, aksk] = await prisma.$transaction([
        prisma.enterpriseUpstreamKey.updateMany({
            where: { user_id: id, deleted_at: null },
            data: { deleted_at: now },
        }),
        prisma.enterpriseKey.updateMany({
            where: { user_id: id, status: { not: 'disabled' } },
            data: { status: 'disabled' },
        }),
        prisma.enterpriseAkSk.updateMany({
            where: { user_id: id, status: { not: 'disabled' } },
            data: { status: 'disabled' },
        }),
        prisma.user.updateMany({ where: { id, status: { not: 'disabled' } }, data: { status: 'disabled' } }),
    ]);
    return NextResponse.json({
        ok: true,
        deleted: true,
        upstream_regions_marked: ups.count,
        keys_disabled: keys.count,
        aksk_disabled: aksk.count,
    });
}

/**
 * GET /api/admin/enterprise/customers/[id] — 单客户详情(运营后台):
 * 余额/累计消费 + keys + 议价覆盖 + 最近流水 10 + 最近任务 10。守门:superadmin。
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const { id } = await params;

    const upRows = await prisma.enterpriseUpstreamKey.findMany({
        where: { user_id: id },
        orderBy: { region: 'asc' }, // cn 在前
        select: { region: true, note: true, created_at: true, discount: true },
    });
    const up = upRows.find((r) => r.region === 'cn') ?? upRows[0];
    const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, nickname: true, created_at: true },
    });
    if (!up || !user) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const account = await prisma.account.findUnique({
        where: { user_id: id },
        select: { id: true, balance_cny: true },
    });
    const [spentAgg, keys, overrides, ledger, tasks] = await Promise.all([
        account
            ? prisma.ledgerEntry.aggregate({
                  where: { account_id: account.id, kind: 'charge' },
                  _sum: { amount_cny: true },
              })
            : Promise.resolve(null),
        prisma.enterpriseKey.findMany({
            where: { user_id: id },
            orderBy: { created_at: 'asc' },
            select: {
                id: true,
                name: true,
                key_prefix: true,
                region: true,
                status: true,
                created_at: true,
                last_used_at: true,
            },
        }),
        prisma.enterpriseModelDiscount.findMany({
            where: { user_id: id },
            orderBy: [{ region: 'asc' }, { variant: 'asc' }],
            select: { region: true, variant: true, discount: true },
        }),
        account
            ? prisma.ledgerEntry.findMany({
                  where: { account_id: account.id },
                  orderBy: { created_at: 'desc' },
                  take: 10,
                  select: { kind: true, amount_cny: true, balance_after: true, note: true, created_at: true },
              })
            : Promise.resolve([]),
        prisma.seedanceVideoTask.findMany({
            where: { user_id: id, tier: ENTERPRISE_TIER },
            orderBy: { created_at: 'desc' },
            take: 10,
            select: {
                id: true,
                model: true,
                resolution: true,
                status: true,
                tokens: true,
                cost_cny: true,
                fail_reason: true,
                billed: true,
                created_at: true,
            },
        }),
    ]);

    return NextResponse.json({
        user: { id: user.id, email: user.email, name: user.nickname, created_at: user.created_at.toISOString() },
        upstream_note: up.note,
        discount: Number(up.discount ?? 1),
        // 每版本一行(cn/global):note + 独立折扣率(2026-07-23 海外版)
        upstreams: upRows.map((r) => ({
            region: r.region,
            note: r.note,
            discount: Number(r.discount ?? 1),
        })),
        balance_cny: account ? Number(account.balance_cny) : 0,
        spent_cny: spentAgg?._sum.amount_cny ? Math.abs(Number(spentAgg._sum.amount_cny)) : 0,
        keys: keys.map((k) => ({
            ...k,
            created_at: k.created_at.toISOString(),
            last_used_at: k.last_used_at?.toISOString() ?? null,
        })),
        overrides: overrides.map((o) => ({ region: o.region, variant: o.variant, discount: Number(o.discount) })),
        ledger: ledger.map((l) => ({
            kind: l.kind,
            amount_cny: Number(l.amount_cny),
            balance_after: Number(l.balance_after),
            note: l.note,
            created_at: l.created_at.toISOString(),
        })),
        tasks: tasks.map((t) => ({
            id: t.id,
            model: t.model,
            resolution: t.resolution,
            status: t.status,
            tokens: t.tokens != null ? Number(t.tokens) : null,
            cost_cny: t.cost_cny != null ? Number(t.cost_cny) : null,
            fail_reason: t.fail_reason ?? null,
            billed: t.billed,
            created_at: t.created_at.toISOString(),
        })),
    });
}
