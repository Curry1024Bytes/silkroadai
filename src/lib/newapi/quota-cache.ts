/**
 * Portal-side quota cache (W4-2 D6 first implementation).
 *
 * new-api's `quota` and `used_quota` per user are the source of truth, but
 * hitting `getUser` on every /balance render is wasteful (HTTP RTT + extra
 * load on new-api). This helper interposes a 60-second Prisma-row cache:
 *
 *   - Hit  (cache fresh < TTL_MS): return cache fast.
 *   - Miss (no cache OR stale): call new-api, write back, return live.
 *   - Fallback (new-api unreachable but stale cache exists): return stale
 *     with `source: 'fallback'` so the UI can show a "data may be slightly
 *     out of date" hint.
 *   - Hard fail (no cache AND new-api dead): throw.
 *
 * Cache invalidation:
 *   - `executeRecharge` (W4-1 D1) nullifies the three cache fields inside
 *     its commit transaction so the next /balance read forces live.
 *   - When customer activity (chat completions etc.) consumes quota on
 *     new-api side, our cache shows STALE used_quota until the 60s window
 *     elapses. That's an accepted UX gap — the customer can hard-refresh
 *     to force-bust, or wait at most a minute.
 */
import 'server-only';
import { prisma } from '@/lib/db';
import { getUser as newapiGetUser } from './client';

/** Field names on Portal User row. The brief used a different naming
 *  convention; the actual schema (W2 D4) named these with the `newapi_`
 *  prefix to match the rest of the new-api integration columns. */
const USER_CACHE_FIELDS = {
    quota: 'newapi_quota_cache',
    usedQuota: 'newapi_used_quota_cache',
    cachedAt: 'newapi_cached_at',
} as const;

const TTL_MS = 60_000;

export interface QuotaSnapshot {
    remain_quota: number;
    used_quota: number;
    /** Where the numbers came from. UI uses this to show a "data may be
     *  stale" hint on `fallback`, and to decide whether to render a
     *  "synced N seconds ago" indicator on `cache`. */
    source: 'cache' | 'live' | 'fallback';
}

/**
 * Fetch quota for a portal user, going through the row cache.
 *
 * @throws if the portal user has no `newapi_user_id` linkage (the upstream
 *         account was never provisioned — this is a fatal misconfig that
 *         needs admin attention).
 * @throws if there's no cache AND new-api is unreachable.
 */
export async function getQuotaWithCache(portalUserId: string): Promise<QuotaSnapshot> {
    const user = await prisma.user.findUnique({
        where: { id: portalUserId },
        select: {
            id: true,
            newapi_user_id: true,
            newapi_quota_cache: true,
            newapi_used_quota_cache: true,
            newapi_cached_at: true,
        },
    });
    if (!user) {
        throw new Error(`portal user ${portalUserId} not found`);
    }
    if (user.newapi_user_id == null) {
        throw new Error(`portal user ${portalUserId} has no newapi_user_id (provisionNewCustomer never ran)`);
    }

    const now = Date.now();
    const cacheAge = user.newapi_cached_at ? now - user.newapi_cached_at.getTime() : Infinity;
    const hasCache =
        user.newapi_quota_cache !== null && user.newapi_used_quota_cache !== null && user.newapi_cached_at !== null;
    const cacheFresh = hasCache && cacheAge < TTL_MS;

    if (cacheFresh) {
        return {
            remain_quota: Number(user.newapi_quota_cache!),
            used_quota: Number(user.newapi_used_quota_cache!),
            source: 'cache',
        };
    }

    // Miss or stale — try live, fall back to stale on failure.
    try {
        const upstream = await newapiGetUser(user.newapi_user_id);
        // Write back, fire-and-await so the next call sees fresh data.
        // Failure to persist isn't fatal — we still return live.
        await prisma.user
            .update({
                where: { id: portalUserId },
                data: {
                    [USER_CACHE_FIELDS.quota]: BigInt(upstream.quota),
                    [USER_CACHE_FIELDS.usedQuota]: BigInt(upstream.used_quota),
                    [USER_CACHE_FIELDS.cachedAt]: new Date(now),
                },
            })
            .catch((err) => {
                console.warn(
                    `[quota-cache] failed to write-back cache for user ${portalUserId} (returning live anyway):`,
                    err,
                );
            });
        return {
            remain_quota: upstream.quota,
            used_quota: upstream.used_quota,
            source: 'live',
        };
    } catch (err) {
        if (hasCache) {
            console.warn(
                `[quota-cache] new-api unreachable, returning stale cache for user ${portalUserId} (age=${Math.round(cacheAge / 1000)}s):`,
                err,
            );
            return {
                remain_quota: Number(user.newapi_quota_cache!),
                used_quota: Number(user.newapi_used_quota_cache!),
                source: 'fallback',
            };
        }
        // No cache + no live = hard fail; let caller render an error state
        throw new Error(
            `quota fetch failed for user ${portalUserId}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}
