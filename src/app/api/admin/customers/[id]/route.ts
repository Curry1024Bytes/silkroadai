import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { quotaToCny } from '@/lib/newapi/client';

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
        },
    });
    if (!user) return NextResponse.json({ error: '客户不存在' }, { status: 404 });

    const usageStart = new Date(Date.now() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1_000);

    const [keys, usageByModel, recharges] = await Promise.all([
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
    ]);

    return NextResponse.json({
        customer: {
            id: user.id,
            email: user.email,
            nickname: user.nickname,
            status: user.status,
            created_at: user.created_at,
            last_login_at: user.last_login_at,
            balance_cny: Math.max(0, quotaToCny(Number(user.newapi_quota_cache ?? 0))),
            used_cny: quotaToCny(Number(user.newapi_used_quota_cache ?? 0)),
            balance_cached_at: user.newapi_cached_at,
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
        usage_window_days: USAGE_WINDOW_DAYS,
    });
}
