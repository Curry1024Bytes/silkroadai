/**
 * W6 D4 — per-token usage cache.
 *
 * Mirrors the W4-2 D6 `quota-cache` 4-path pattern (hit / miss + write-back
 * / stale-fallback / hard-fail) but at the NewApiToken row level instead
 * of User. Per-key usage is derived from new-api log entries summed by
 * `token_id`.
 *
 * Why a separate cache (vs reading on every render): /keys server-renders
 * one lookup per active key (per-user key cap removed 2026-07-25, so this
 * count is unbounded in principle). The 60s row cache means a token that
 * was refreshed within the window costs zero upstream round-trips.
 *
 * ⚠️ 注意这【不是】批量的:每个 token 各有各的 `cached_used_at`,过期时刻
 * 互相错开,所以一次 /keys 渲染最坏是 N 发 `GET /api/log/`(N = 活跃 key 数)。
 * 上游那条 `/api/log/` 会触发 new-api 的分页 `count(*)`,在 3600 万行的
 * logs 表上是重活 —— 想砍上游压力要从减少 N 或拉长 TTL 入手,别指望这里
 * 会自动合并请求。(2026-08-15:此前本注释声称 "≤1 round-trip per tab",
 * 与实现不符,已更正。)
 *
 * Limits:
 *   - We pull the most recent `LOG_PAGE_SIZE` entries via queryLogs and
 *     sum within. For a moderately-active token this captures the full
 *     consumption window. Power users with > LOG_PAGE_SIZE consume rows
 *     since their last cache write would underestimate; that's an
 *     acceptable approximation for the "at-a-glance" dashboard. Settlement
 *     uses the raw new-api log API directly.
 *   - new-api's log endpoint may not honor `token_id` server-side
 *     filtering on older builds (see `queryLogs` doc). Callers MUST
 *     post-filter — `getTokenUsageWithCache` does so unconditionally.
 */
import 'server-only';
import { prisma } from '@/lib/db';
import { queryLogs } from './client';

/** TTL for the row cache. Mirrors W4-2 D6 `quota-cache`. */
const TTL_MS = 60_000;
/** How many recent log rows to pull per token-usage refresh. */
const LOG_PAGE_SIZE = 1000;

export interface TokenUsageSnapshot {
    /** Sum of consume-type log quotas attributable to this token. Raw quota
     *  units (callers should `quotaToCny` for display). */
    used_quota: bigint;
    /** Most-recent consume timestamp (Date) or null if the token was never
     *  used. Computed from `max(log.created_at)` over the same log set. */
    last_used_at: Date | null;
    /** Source of the numbers — drives UI "data may be stale" hints. */
    source: 'cache' | 'live' | 'fallback';
}

/**
 * Fetch a token's recent consumption snapshot, going through the row cache.
 *
 * @param prismaTokenId  NewApiToken.id (UUID, portal-side primary key)
 * @param newapiUserId   User.newapi_user_id — the upstream new-api int id
 *                       used to scope the log query
 * @param newapiTokenId  NewApiToken.newapi_token_id — used to post-filter
 *                       the log set down to the requested token
 *
 * @throws if both cache miss AND new-api fetch fails (hard-fail). The
 *         caller's `try/catch` should render an error state.
 */
export async function getTokenUsageWithCache(args: {
    prismaTokenId: string;
    newapiUserId: number;
    newapiTokenId: number;
    now?: Date;
    /** 调用方【已经】读到的缓存两列(如 /keys 的列表查询)。给了就跳过这里
     *  的 findUnique —— 否则 N 个 token 会重复 N 次刚查过的单行读。
     *  不给则维持原行为(自己读),proxy 热路径等单点调用方不受影响。 */
    cachedRow?: { cached_used_quota: bigint; cached_used_at: Date | null };
}): Promise<TokenUsageSnapshot> {
    const now = args.now ?? new Date();

    const row =
        args.cachedRow ??
        (await prisma.newApiToken.findUnique({
            where: { id: args.prismaTokenId },
            select: {
                cached_used_quota: true,
                cached_used_at: true,
            },
        }));
    if (!row) {
        throw new Error(`token ${args.prismaTokenId} not found`);
    }

    const cacheAge = row.cached_used_at !== null ? now.getTime() - row.cached_used_at.getTime() : Infinity;
    const hasCache = row.cached_used_at !== null;
    const cacheFresh = hasCache && cacheAge < TTL_MS;

    if (cacheFresh) {
        return {
            used_quota: row.cached_used_quota,
            // The cache doesn't store last_used_at — rendering it from the
            // cache row would require a third column. For now, we surface
            // `cached_used_at` as a coarse proxy ("we saw activity around
            // here") which is honest for a 60s-fresh cache.
            last_used_at: row.cached_used_at,
            source: 'cache',
        };
    }

    // Miss / stale — fetch live. Try, fall back to stale on failure.
    try {
        const live = await fetchLiveUsage(args.newapiUserId, args.newapiTokenId);
        // Write back; failures here aren't fatal (we still return live).
        await prisma.newApiToken
            .update({
                where: { id: args.prismaTokenId },
                data: {
                    cached_used_quota: live.used_quota,
                    cached_used_at: now,
                },
            })
            .catch((err) => {
                console.warn(`[token-usage] failed to write-back cache for token ${args.prismaTokenId}:`, err);
            });
        return { ...live, source: 'live' };
    } catch (err) {
        if (hasCache) {
            console.warn(
                `[token-usage] new-api unreachable, returning stale cache for token ${args.prismaTokenId} (age=${Math.round(cacheAge / 1000)}s):`,
                err,
            );
            return {
                used_quota: row.cached_used_quota,
                last_used_at: row.cached_used_at,
                source: 'fallback',
            };
        }
        throw new Error(
            `token usage fetch failed for ${args.prismaTokenId}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

/** Live new-api fetch — extracted so tests can target it independently
 *  of the cache pre/post logic. */
async function fetchLiveUsage(
    newapiUserId: number,
    newapiTokenId: number,
): Promise<{ used_quota: bigint; last_used_at: Date | null }> {
    const { items } = await queryLogs({
        user_id: newapiUserId,
        token_id: newapiTokenId,
        type: 2, // consume only — refunds (6) handled separately when we add them
        page_size: LOG_PAGE_SIZE,
    });

    // POST-filter unconditionally. new-api may forward token_id (newer
    // builds) or ignore it (older); either way summing only matching
    // rows is correct.
    let usedQuota = BigInt(0);
    let maxCreatedAtUnix = 0;
    for (const log of items) {
        if (log.token_id !== newapiTokenId) continue;
        usedQuota += BigInt(log.quota);
        if (log.created_at > maxCreatedAtUnix) {
            maxCreatedAtUnix = log.created_at;
        }
    }

    return {
        used_quota: usedQuota,
        last_used_at: maxCreatedAtUnix > 0 ? new Date(maxCreatedAtUnix * 1000) : null,
    };
}
