import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { quotaToCny } from '@/lib/newapi/client';
import { getQuotaWithCache } from '@/lib/newapi/quota-cache';

export const runtime = 'nodejs';

/**
 * GET /api/admin/customers/[id] — P6b-2 只读客户详情(tenant-scoped + IDOR 校验)。
 *
 * ⚠️ IDOR 防护:按 id 查 user **必带** `tenantScope(admin)` —— partner admin 查别租户
 * 的 user → findFirst 拿不到 → 404(死线 §6)。详情内容全部 tenant-derived(key/用量/
 * 充值都经 user_id 关联,而该 user 已确认属于本租户)。**纯只读,不显示 sk 明文**
 * (gotcha #11/#13:只读 Prisma,不调 new-api `GET /api/user/token`)。
 */
const USAGE_WINDOW_DAYS = 30;
const RECHARGE_LIMIT = 50;
const LEDGER_LIMIT = 20; // P4c-1: recent ¥账本 entries shown on the detail page

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;

    const user = await prisma.user.findFirst({
        where: { id, ...tenantScope(admin) },
        select: {
            id: true,
            email: true,
            nickname: true,
            status: true,
            created_at: true,
            last_login_at: true,
            newapi_quota_cache: true,
            newapi_used_quota_cache: true,
            newapi_cached_at: true,
            billing_mode: true, // P4c-4: 决定显示「迁移到 portal」还是「回滚到 newapi」
        },
    });
    if (!user) return NextResponse.json({ error: '客户不存在' }, { status: 404 });

    // 头部「余额 / 累计消费」走 live-refetch-on-miss(getQuotaWithCache,镜像客户端
    // /balance):缓存新鲜→读缓存,缓存空/过期→打 new-api 刷新并写回。直接读
    // newapi_quota_cache 列会把 null 当 ¥0 显示 —— 而充值 / 迁移翻号都会把缓存清成
    // null(executeRecharge + billing-migration),于是头部显示 ¥0 但客户真实有余额
    // (2026-06-13 实操踩坑:migrate-out 后真实 ¥3653 头部却 ¥0)。new-api 不可达且
    // 无缓存兜底 → 优雅回落到缓存列(很可能是 0),不让详情页 500。
    let balanceCny = Math.max(0, quotaToCny(Number(user.newapi_quota_cache ?? 0)));
    let usedCny = quotaToCny(Number(user.newapi_used_quota_cache ?? 0));
    let balanceCachedAt: Date | null = user.newapi_cached_at;
    try {
        const snap = await getQuotaWithCache(user.id);
        balanceCny = Math.max(0, quotaToCny(snap.remain_quota));
        usedCny = quotaToCny(snap.used_quota);
        if (snap.source !== 'fallback') balanceCachedAt = new Date();
    } catch (err) {
        console.warn(
            '[admin/customers/[id]] live quota refetch failed, showing cached column:',
            err instanceof Error ? err.message : err,
        );
    }

    const usageStart = new Date(Date.now() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1_000);

    const [keys, usageByModel, recharges, account] = await Promise.all([
        prisma.newApiToken.findMany({
            where: { user_id: id },
            orderBy: { created_at: 'desc' },
            select: { id: true, key_alias: true, tier: true, status: true, created_at: true },
        }),
        prisma.usageRecord.groupBy({
            by: ['model_slug', 'tier'],
            where: { user_id: id, log_created_at: { gte: usageStart } },
            _sum: { cost_cny: true },
            _count: { _all: true },
        }),
        prisma.rechargeLog.findMany({
            where: { user_id: id },
            orderBy: { created_at: 'desc' },
            take: RECHARGE_LIMIT,
            select: { id: true, amount: true, source: true, note: true, created_at: true },
        }),
        // P4c-1 portal ¥账本(零客户影响:多数客户无 Account 行 → null → 余额 0)。
        prisma.account.findUnique({
            where: { user_id: id },
            select: {
                balance_cny: true,
                entries: {
                    orderBy: { created_at: 'desc' },
                    take: LEDGER_LIMIT,
                    select: {
                        id: true,
                        kind: true,
                        amount_cny: true,
                        balance_after: true,
                        ref: true,
                        note: true,
                        created_at: true,
                    },
                },
            },
        }),
    ]);

    return NextResponse.json({
        customer: {
            id: user.id,
            email: user.email,
            nickname: user.nickname,
            status: user.status,
            created_at: user.created_at,
            last_login_at: user.last_login_at,
            balance_cny: balanceCny,
            used_cny: usedCny,
            balance_cached_at: balanceCachedAt,
            billing_mode: user.billing_mode, // P4c-4: 'newapi' | 'portal'
        },
        keys: keys.map((k) => ({
            id: k.id,
            key_alias: k.key_alias,
            tier: k.tier,
            status: k.status,
            created_at: k.created_at,
        })),
        usage_by_model: usageByModel
            .map((g) => ({
                model_slug: g.model_slug,
                tier: g.tier,
                calls: g._count._all,
                cost_cny: Number(g._sum.cost_cny ?? 0),
            }))
            .sort((a, b) => b.calls - a.calls),
        recharges: recharges.map((r) => ({
            id: r.id,
            amount: Number(r.amount),
            source: r.source,
            note: r.note,
            created_at: r.created_at,
        })),
        // P4c-1 portal ¥账本(权威 = Account.balance_cny;无 Account → ¥0)。
        ledger: {
            balance_cny: Number(account?.balance_cny ?? 0),
            entries: (account?.entries ?? []).map((e) => ({
                id: e.id,
                kind: e.kind,
                amount_cny: Number(e.amount_cny),
                balance_after: Number(e.balance_after),
                ref: e.ref,
                note: e.note,
                created_at: e.created_at,
            })),
        },
        usage_window_days: USAGE_WINDOW_DAYS,
    });
}
