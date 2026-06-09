/**
 * GET /api/portal/balance/quota — current user's balance/spend snapshot.
 *
 * P4c-3.5: dispatches by billing_mode via `getCustomerBalance` — portal
 * customers read the portal ¥ ledger (Account.balance_cny), newapi
 * customers read new-api quota (getQuotaWithCache, unchanged). Used by
 * /image's CostPreview to gate the generate button when balance < cost
 * (reads remain_cny).
 *
 * Response shape:
 *   { remain_cny, used_cny, remain_usd, used_usd, remain_quota, used_quota,
 *     source: 'portal'|'newapi', stale, cached_at_iso }
 *   (remain_quota/used_quota are 0 for portal — its new-api quota is the dumb gate, not a balance.)
 *
 * Rate-class: cheap. The cache is 60s TTL on Prisma row read, so a
 * client polling at 10s only hits new-api once per 60s window.
 *
 * Cache-Control: no-store on the response — we want the client to
 * always re-ask through SWR, and the server-side cache is what does
 * the actual upstream throttling.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getCustomerBalance } from '@/lib/billing/customer-balance';
import { USD_TO_CNY_RATE } from '@/lib/newapi/quota-units';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
    const user = await getCurrentUser(req);
    if (!user) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    try {
        // P4c-3.5: portal 客户读 ¥账本(Account);newapi 照旧 getQuotaWithCache。
        const bal = await getCustomerBalance(user.id);
        return NextResponse.json(
            {
                // ¥ 统一口径(portal=Account.balance_cny;newapi=quotaToCny)。USD = ¥ / FX。
                remain_cny: bal.balanceCny,
                used_cny: bal.spentCny,
                remain_usd: bal.balanceCny / USD_TO_CNY_RATE,
                used_usd: bal.spentCny / USD_TO_CNY_RATE,
                // raw quota 仅 newapi 有意义;portal 的 new-api quota 是哑门开关,不暴露(0)。
                remain_quota: bal.quota?.remain ?? 0,
                used_quota: bal.quota?.used ?? 0,
                source: bal.source, // 'portal' | 'newapi'
                stale: bal.stale, // newapi:new-api 不可达 → true("数据稍滞后")
                cached_at_iso: null,
            },
            {
                status: 200,
                headers: { 'Cache-Control': 'no-store, must-revalidate' },
            },
        );
    } catch (err) {
        console.error(`[portal/balance/quota] read failed for ${user.id}:`, err);
        return NextResponse.json({ error: 'quota_unavailable' }, { status: 503 });
    }
}
