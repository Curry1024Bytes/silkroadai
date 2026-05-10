/**
 * GET /api/portal/balance/quota — current user's quota snapshot.
 *
 * Thin wrapper over `getQuotaWithCache` so client-side components can
 * SWR the live balance without re-implementing the cache logic. Used
 * by /image's CostPreview to gate the generate button when balance is
 * less than the predicted cost.
 *
 * Response shape:
 *   { remain_quota, used_quota, remain_cny, used_cny, remain_usd,
 *     used_usd, source, cached_at_iso }
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
import { getQuotaWithCache } from '@/lib/newapi/quota-cache';
import { quotaToCny, quotaToUsd } from '@/lib/newapi/client';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
    const user = await getCurrentUser(req);
    if (!user) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    try {
        const snap = await getQuotaWithCache(user.id);
        return NextResponse.json(
            {
                remain_quota: Number(snap.remain_quota),
                used_quota: Number(snap.used_quota),
                remain_cny: quotaToCny(Number(snap.remain_quota)),
                used_cny: quotaToCny(Number(snap.used_quota)),
                remain_usd: quotaToUsd(Number(snap.remain_quota)),
                used_usd: quotaToUsd(Number(snap.used_quota)),
                source: snap.source,
                // QuotaSnapshot doesn't expose a cached_at timestamp; the
                // /balance page surfaces "可能已是缓存" via the source
                // field directly. Keep the contract field but always null
                // until cache-cache exposes the timestamp.
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
