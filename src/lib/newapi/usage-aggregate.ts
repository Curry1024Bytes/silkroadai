/**
 * W6 D5 — Server-side usage aggregator over new-api logs.
 *
 * Replaces the W4-2 D7 client-side `page_size=200` aggregate (W3 D2 F3:
 * power users with > 200 logs in the window get a long-tail-truncated
 * total). This helper paginates the full window (up to 50 pages × 1000
 * rows = 50k rows) and caches the rolled-up result for 5 minutes in
 * `usage_aggregate_cache`.
 *
 * 4-path mirror of W4-2 D6 quota-cache + W6 D4 token-usage:
 *   - HIT  (computed_at < TTL): return cached payload, source='cache'
 *   - MISS / STALE: fetch live, write back, source='live'
 *   - FALLBACK: live fail with stale cache → return cache, source='fallback'
 *   - HARD-FAIL: live fail + no cache → throw
 *
 * 5-minute TTL is intentional. /balance and /keys use 60s because they're
 * single-row fetches; here we're paginating up to 50 pages and the
 * underlying numbers are coarse-grained (a few minutes of staleness on
 * "上月消费" is invisible to the customer).
 *
 * No new endpoint — both /dashboard and /usage call the helper directly
 * from their server components.
 */
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { queryLogs } from './client';

const TTL_MS = 5 * 60 * 1_000;
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

/** Period values accepted by the aggregator + the cache row's `period`
 *  column. Two naming styles coexist for backward-compat with the
 *  pre-D5 `/usage` page tabs ('7d' / '30d' / 'all'); the dashboard uses
 *  the explicit names where it matters ('last_month'). */
export type UsagePeriod = '7d' | '30d' | 'all' | 'last_month';

export const USAGE_PERIODS: readonly UsagePeriod[] = ['7d', '30d', 'all', 'last_month'] as const;

export interface UsageAggregate {
    totalUsedQuota: number;
    totalCalls: number;
    byModel: Array<{ model: string; calls: number; quota: number }>;
}

export interface UsageAggregateSnapshot extends UsageAggregate {
    period: UsagePeriod;
    computedAt: Date;
    /** Where the numbers came from. UI uses this to show staleness hints. */
    source: 'cache' | 'live' | 'fallback';
    /** Number of new-api log pages fetched (0 on cache hit). Surfaced for
     *  ops grep — high value (> 10) on a single render means the user has
     *  unusually heavy traffic and the next live refresh will be slow. */
    pagesFetched: number;
}

/**
 * Resolve a period to a unix-second window.
 *
 * - `'7d'` / `'30d'`: trailing N×86400 seconds ending at `nowSec`.
 * - `'all'`: start=0, end=nowSec.
 * - `'last_month'`: previous *calendar* month in UTC. E.g. on May 5
 *   2026 returns April 1 0:00:00 UTC ≤ t < May 1 0:00:00 UTC.
 *   `Date.UTC(y, -1, 1)` correctly rolls back into December of the
 *   previous year when the current month is January.
 */
export function periodToTimeRange(
    period: UsagePeriod,
    now: Date = new Date(),
): { start: number; end: number } {
    const nowSec = Math.floor(now.getTime() / 1000);
    if (period === 'all') return { start: 0, end: nowSec };
    if (period === '7d') return { start: nowSec - 7 * 86_400, end: nowSec };
    if (period === '30d') return { start: nowSec - 30 * 86_400, end: nowSec };
    // last_month
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const startOfThisMonth = Math.floor(Date.UTC(y, m, 1, 0, 0, 0) / 1000);
    const startOfPrevMonth = Math.floor(Date.UTC(y, m - 1, 1, 0, 0, 0) / 1000);
    return { start: startOfPrevMonth, end: startOfThisMonth };
}

/**
 * Get the aggregate. Throws on hard-fail (no cache + new-api dead).
 */
export async function getUsageAggregate(args: {
    portalUserId: string;
    newapiUserId: number;
    period: UsagePeriod;
    now?: Date;
}): Promise<UsageAggregateSnapshot> {
    const now = args.now ?? new Date();

    const cached = await prisma.usageAggregateCache.findUnique({
        where: {
            user_id_period: {
                user_id: args.portalUserId,
                period: args.period,
            },
        },
    });

    const cacheAge = cached ? now.getTime() - cached.computed_at.getTime() : Infinity;
    const cacheFresh = cached !== null && cacheAge < TTL_MS;

    if (cacheFresh) {
        return {
            ...readPayload(cached!.payload),
            period: args.period,
            computedAt: cached!.computed_at,
            source: 'cache',
            pagesFetched: 0,
        };
    }

    // Miss / stale — try live, fall back to stale on failure.
    try {
        const { aggregate, pagesFetched } = await fetchLiveAggregate({
            newapiUserId: args.newapiUserId,
            period: args.period,
            now,
        });
        // Write-back. Failures here aren't fatal — we still return live.
        await prisma.usageAggregateCache
            .upsert({
                where: {
                    user_id_period: {
                        user_id: args.portalUserId,
                        period: args.period,
                    },
                },
                update: {
                    payload: aggregate as unknown as Parameters<
                        typeof prisma.usageAggregateCache.upsert
                    >[0]['update']['payload'],
                    computed_at: now,
                },
                create: {
                    user_id: args.portalUserId,
                    period: args.period,
                    payload: aggregate as unknown as Parameters<
                        typeof prisma.usageAggregateCache.upsert
                    >[0]['create']['payload'],
                    computed_at: now,
                },
            })
            .catch((err) => {
                console.warn(
                    `[usage-aggregate] write-back failed for user ${args.portalUserId} period=${args.period}:`,
                    err,
                );
            });
        return {
            ...aggregate,
            period: args.period,
            computedAt: now,
            source: 'live',
            pagesFetched,
        };
    } catch (err) {
        if (cached) {
            console.warn(
                `[usage-aggregate] new-api unreachable, returning stale cache for user ${args.portalUserId} period=${args.period} (age=${Math.round(cacheAge / 1000)}s):`,
                err,
            );
            return {
                ...readPayload(cached.payload),
                period: args.period,
                computedAt: cached.computed_at,
                source: 'fallback',
                pagesFetched: 0,
            };
        }
        // Hard fail — surface to caller for an error-state render.
        Sentry.captureException(err, {
            tags: { area: 'usage-aggregate', period: args.period },
        });
        throw new Error(
            `usage aggregate fetch failed for user ${args.portalUserId} period=${args.period}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

/** Defensive payload reader — Prisma JsonValue is `unknown` for type
 *  safety, so we narrow + sanitize here. Callers don't trust the JSON
 *  shape blindly even though we wrote it ourselves (forward-compat: old
 *  cache rows after a payload schema bump should at least not crash). */
function readPayload(payload: unknown): UsageAggregate {
    const p = payload as Partial<UsageAggregate> & { byModel?: unknown };
    const byModel = Array.isArray(p.byModel)
        ? (p.byModel as Array<{ model?: unknown; calls?: unknown; quota?: unknown }>)
              .filter(
                  (m): m is { model: string; calls: number; quota: number } =>
                      typeof m.model === 'string' &&
                      typeof m.calls === 'number' &&
                      typeof m.quota === 'number',
              )
              .map((m) => ({ model: m.model, calls: m.calls, quota: m.quota }))
        : [];
    return {
        totalUsedQuota: typeof p.totalUsedQuota === 'number' ? p.totalUsedQuota : 0,
        totalCalls: typeof p.totalCalls === 'number' ? p.totalCalls : 0,
        byModel,
    };
}

/** Live fetch: paginate queryLogs over the requested window, accumulate
 *  total / by-model. Stops early when (page * page_size) ≥ total OR
 *  the page returns fewer rows than page_size. Hard-caps at MAX_PAGES
 *  to bound the worst-case latency. */
async function fetchLiveAggregate(args: {
    newapiUserId: number;
    period: UsagePeriod;
    now: Date;
}): Promise<{ aggregate: UsageAggregate; pagesFetched: number }> {
    const range = periodToTimeRange(args.period, args.now);

    let totalUsedQuota = 0;
    let totalCalls = 0;
    const byModelMap = new Map<string, { calls: number; quota: number }>();
    let pagesFetched = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await queryLogs({
            user_id: args.newapiUserId,
            type: 2, // consume only — refunds (6) etc. excluded
            // 0 means start-of-time; queryLogs forwards as-is and new-api
            // accepts. We could omit but explicit is clearer for Sentry.
            start_timestamp: range.start || undefined,
            end_timestamp: range.end,
            page,
            page_size: PAGE_SIZE,
        });
        pagesFetched++;

        for (const log of r.items) {
            // Defensive re-filter — new-api respects type=2 but a future
            // upstream change shouldn't double-count refunds if the filter
            // ever loosens.
            if (log.type !== 2) continue;
            totalCalls++;
            totalUsedQuota += log.quota;
            const key = log.model_name || '<unknown>';
            const slot = byModelMap.get(key) ?? { calls: 0, quota: 0 };
            slot.calls++;
            slot.quota += log.quota;
            byModelMap.set(key, slot);
        }

        // Early-exit conditions:
        // - this page returned fewer rows than page_size → last page
        // - we've accounted for all matching rows per `total`
        if (r.items.length < PAGE_SIZE) break;
        if (page * PAGE_SIZE >= r.total) break;
    }

    const byModel = Array.from(byModelMap.entries())
        .map(([model, agg]) => ({ model, ...agg }))
        .sort((a, b) => b.quota - a.quota);

    return {
        aggregate: { totalUsedQuota, totalCalls, byModel },
        pagesFetched,
    };
}
