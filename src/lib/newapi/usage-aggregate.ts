/**
 * Server-side usage aggregator (客户控制台三合一 汇总卡 + 模型消耗图).
 *
 * Source: new-api's own dashboard endpoint `/api/data/` (getUsageDashboard) —
 * server-side pre-aggregated buckets of (day × model) with count / quota /
 * token_used. ONE request covers the whole window, exact.
 *
 * Why not paginate `/api/log/` like the original W6 D5 version: new-api hard-
 * caps `/api/log/` at page_size=100 (requesting 1000 still returns 100). The
 * old loop did `if (items.length < PAGE_SIZE=1000) break` → bailed after the
 * first 100 rows, pinning 请求次数 at ≤100 and undercounting tokens / spend
 * for any active customer. `/api/data/` has no such cap.
 *
 * Cached 5 minutes in `usage_aggregate_cache`. 4-path mirror of quota-cache:
 *   - HIT  (computed_at < TTL): cached payload, source='cache'
 *   - MISS / STALE: fetch live, write back, source='live'
 *   - FALLBACK: live fail with stale cache → return cache, source='fallback'
 *   - HARD-FAIL: live fail + no cache → throw
 */
import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { fetchUserRefunds, getUsageDashboard } from './client';

const TTL_MS = 5 * 60 * 1_000;
/** How many distinct models get their own stack in the 模型消耗分布图; the
 *  rest collapse into a single '其他' series so the chart + cached payload
 *  stay bounded regardless of how many models a power user touches. */
const CHART_TOP_MODELS = 6;
const OTHER_MODEL_LABEL = '其他';

/** Calendar day (YYYY-MM-DD) of a unix-second timestamp in Asia/Shanghai.
 *  Computed via a fixed +8h offset on the epoch so the bucket is
 *  deterministic regardless of the server's TZ env (gotcha #20) — the same
 *  reason the UI passes `{ timeZone: 'Asia/Shanghai' }` to toLocaleString. */
function shanghaiDay(unixSec: number): string {
    return new Date((unixSec + 8 * 3_600) * 1_000).toISOString().slice(0, 10);
}

/** Period values accepted by the aggregator + the cache row's `period`
 *  column. Two naming styles coexist for backward-compat with the
 *  pre-D5 `/usage` page tabs ('7d' / '30d' / 'all'); the dashboard uses
 *  the explicit names where it matters ('last_month'). */
export type UsagePeriod = '7d' | '30d' | 'all' | 'last_month';

export const USAGE_PERIODS: readonly UsagePeriod[] = ['7d', '30d', 'all', 'last_month'] as const;

/** One day's consumption, split per model (top-N + '其他'). Feeds the
 *  stacked-bar 模型消耗分布图. Values are raw quota (FX-independent — the
 *  page converts to ¥ server-side at render so cached rows don't bake in a
 *  stale rate, and the client chart never touches server-only env). */
export interface UsageDayPoint {
    /** YYYY-MM-DD in Asia/Shanghai. */
    date: string;
    /** model name → quota consumed that day. Keys ⊆ `chartModels`. */
    values: Record<string, number>;
}

export interface UsageAggregate {
    totalUsedQuota: number;
    totalCalls: number;
    /** Σ token_used over the window (prompt+completion combined — what
     *  new-api's /api/data/ reports). Drives the 统计 Tokens card. */
    totalTokens: number;
    byModel: Array<{ model: string; calls: number; quota: number }>;
    /** Daily consumption stacked by model, ascending by date. */
    byDay: UsageDayPoint[];
    /** Ordered stack keys for the chart = top-N model names, with
     *  '其他' appended when models were collapsed. Empty when no consumption. */
    chartModels: string[];
}

export interface UsageAggregateSnapshot extends UsageAggregate {
    period: UsagePeriod;
    computedAt: Date;
    /** Where the numbers came from. UI uses this to show staleness hints. */
    source: 'cache' | 'live' | 'fallback';
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
export function periodToTimeRange(period: UsagePeriod, now: Date = new Date()): { start: number; end: number } {
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
 *
 * Filter dimensions:
 *   - `newapiUsername` is forwarded to `/api/data/` as `username=...` — the
 *     dimension new-api filters on under admin auth (gotcha #15).
 *   - `newapiUserId` is a **defensive post-filter** in `fetchLiveAggregate`
 *     (`if (row.user_id !== newapiUserId) continue`) so a future regression
 *     in the username filter can't leak another user's rows into the cache.
 */
export async function getUsageAggregate(args: {
    portalUserId: string;
    newapiUserId: number;
    newapiUsername: string;
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
        };
    }

    // Miss / stale — try live, fall back to stale on failure.
    try {
        const aggregate = await fetchLiveAggregate({
            newapiUserId: args.newapiUserId,
            newapiUsername: args.newapiUsername,
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
 *  safety, so we narrow + sanitize here. Forward/backward-compat: old cache
 *  rows (pre-/api/data/ shape, e.g. the W6 D5 `totalPromptTokens` +
 *  `totalCompletionTokens` split) should at least not crash — missing
 *  fields default to []/0 and self-heal on the next live refresh (≤ 5min). */
function readPayload(payload: unknown): UsageAggregate {
    const p = payload as Partial<UsageAggregate> & {
        byModel?: unknown;
        byDay?: unknown;
        chartModels?: unknown;
        // legacy (pre-/api/data/) token split — summed as a fallback.
        totalPromptTokens?: unknown;
        totalCompletionTokens?: unknown;
    };
    const byModel = Array.isArray(p.byModel)
        ? (p.byModel as Array<{ model?: unknown; calls?: unknown; quota?: unknown }>)
              .filter(
                  (m): m is { model: string; calls: number; quota: number } =>
                      typeof m.model === 'string' && typeof m.calls === 'number' && typeof m.quota === 'number',
              )
              .map((m) => ({ model: m.model, calls: m.calls, quota: m.quota }))
        : [];
    const byDay = Array.isArray(p.byDay)
        ? (p.byDay as Array<{ date?: unknown; values?: unknown }>)
              .filter((d): d is { date: string; values: Record<string, unknown> } => typeof d.date === 'string')
              .map((d) => {
                  const values: Record<string, number> = {};
                  if (d.values && typeof d.values === 'object') {
                      for (const [k, v] of Object.entries(d.values as Record<string, unknown>)) {
                          if (typeof v === 'number') values[k] = v;
                      }
                  }
                  return { date: d.date, values };
              })
        : [];
    const chartModels = Array.isArray(p.chartModels)
        ? (p.chartModels as unknown[]).filter((m): m is string => typeof m === 'string')
        : [];
    const legacyTokens =
        (typeof p.totalPromptTokens === 'number' ? p.totalPromptTokens : 0) +
        (typeof p.totalCompletionTokens === 'number' ? p.totalCompletionTokens : 0);
    return {
        totalUsedQuota: typeof p.totalUsedQuota === 'number' ? p.totalUsedQuota : 0,
        totalCalls: typeof p.totalCalls === 'number' ? p.totalCalls : 0,
        totalTokens: typeof p.totalTokens === 'number' ? p.totalTokens : legacyTokens,
        byModel,
        byDay,
        chartModels,
    };
}

/** Live fetch: pull the (day × model) buckets from `/api/data/` over the
 *  window and roll them up. No pagination — `/api/data/` returns the full
 *  pre-aggregated set in one call.
 *
 *  Filter:
 *   - Forwards `username=<newapiUsername>` (gotcha #15: admin auth filters by
 *     username, not user_id).
 *   - Post-filters every bucket by `row.user_id === newapiUserId` for
 *     defence-in-depth. */
async function fetchLiveAggregate(args: {
    newapiUserId: number;
    newapiUsername: string;
    period: UsagePeriod;
    now: Date;
}): Promise<UsageAggregate> {
    const range = periodToTimeRange(args.period, args.now);

    const rows = await getUsageDashboard({
        username: args.newapiUsername,
        start_timestamp: range.start || undefined,
        end_timestamp: range.end,
    });

    let totalUsedQuota = 0;
    let totalCalls = 0;
    let totalTokens = 0;
    const byModelMap = new Map<string, { calls: number; quota: number }>();
    // date(YYYY-MM-DD, Shanghai) → model → quota, for the stacked-bar chart.
    const dayModelMap = new Map<string, Map<string, number>>();

    for (const row of rows) {
        // Defensive cross-user post-filter (see fn-doc).
        if (row.user_id !== args.newapiUserId) continue;
        totalCalls += row.count;
        totalUsedQuota += row.quota;
        totalTokens += row.token_used;
        const key = row.model_name || '<unknown>';
        const slot = byModelMap.get(key) ?? { calls: 0, quota: 0 };
        slot.calls += row.count;
        slot.quota += row.quota;
        byModelMap.set(key, slot);
        const day = shanghaiDay(row.created_at);
        const dm = dayModelMap.get(day) ?? new Map<string, number>();
        dm.set(key, (dm.get(key) ?? 0) + row.quota);
        dayModelMap.set(day, dm);
    }

    // /api/data/ 只聚合消费(毛),不含退款。拉 type=6 退款,从【汇总卡 total】与【按模型
    // byModel】扣除 → 净消费(2026-06 客户 zyt:seedance 视频大量失败退款使本期消费虚高)。
    // byDay 图表维持毛趋势:退款发生日常晚于消费日,逐日扣减会跨日失真甚至为负;失败退款
    // 已在汇总卡体现,图仅作分布示意。totalCalls/totalTokens 不减(请求确实发生过)。
    try {
        const refunds = await fetchUserRefunds({
            user_id: args.newapiUserId,
            username: args.newapiUsername,
            start_timestamp: range.start || undefined,
            end_timestamp: range.end,
        });
        for (const r of refunds) {
            totalUsedQuota -= r.quota;
            const slot = byModelMap.get(r.model_name || '<unknown>');
            if (slot) slot.quota -= r.quota;
        }
    } catch (err) {
        console.warn(
            `[usage-aggregate] 退款查询失败 user=${args.newapiUserId} period=${args.period},本期消费暂用毛消费:`,
            err,
        );
    }
    if (totalUsedQuota < 0) totalUsedQuota = 0;

    const byModel = Array.from(byModelMap.entries())
        .map(([model, agg]) => ({ model, calls: agg.calls, quota: Math.max(0, agg.quota) }))
        .sort((a, b) => b.quota - a.quota);

    // Stack keys = top-N models by quota; everything else folds into '其他'.
    const topModels = byModel.slice(0, CHART_TOP_MODELS).map((m) => m.model);
    const topSet = new Set(topModels);
    const hasOther = byModel.length > topModels.length;
    const chartModels = byModel.length === 0 ? [] : hasOther ? [...topModels, OTHER_MODEL_LABEL] : [...topModels];

    const byDay: UsageDayPoint[] = Array.from(dayModelMap.entries())
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, dm]) => {
            const values: Record<string, number> = {};
            let other = 0;
            for (const [model, quota] of dm) {
                if (topSet.has(model)) values[model] = (values[model] ?? 0) + quota;
                else other += quota;
            }
            if (hasOther && other > 0) values[OTHER_MODEL_LABEL] = other;
            return { date, values };
        });

    return { totalUsedQuota, totalCalls, totalTokens, byModel, byDay, chartModels };
}
