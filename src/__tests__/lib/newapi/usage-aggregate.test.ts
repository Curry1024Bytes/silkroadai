/**
 * getUsageAggregate unit tests.
 *
 * Source is now new-api's `/api/data/` (getUsageDashboard) — pre-aggregated
 * (day × model) buckets, one call, no page_size=100 cap. Tests cover the
 * 4-path cache mirror + the roll-up (count / quota / token_used → totals +
 * byModel + byDay + chartModels) + the legacy-payload token fallback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCacheFindUnique = vi.fn();
const mockCacheUpsert = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        usageAggregateCache: {
            findUnique: (...args: unknown[]) => mockCacheFindUnique(...args),
            upsert: (...args: unknown[]) => mockCacheUpsert(...args),
        },
    },
}));

const mockGetUsageDashboard = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    getUsageDashboard: (...args: unknown[]) => mockGetUsageDashboard(...args),
}));

const mockSentryCapture = vi.fn();
vi.mock('@sentry/nextjs', () => ({
    captureException: (...args: unknown[]) => mockSentryCapture(...args),
}));

import { getUsageAggregate, periodToTimeRange, type UsagePeriod } from '@/lib/newapi/usage-aggregate';

const PORTAL_USER_ID = 'aaaa1111-1111-4111-8111-111111111111';
const NEWAPI_USER_ID = 7;
const NEWAPI_USERNAME = 'c-aaaa1111';
const TTL_MS = 5 * 60 * 1_000;

beforeEach(() => {
    vi.clearAllMocks();
    mockCacheUpsert.mockResolvedValue({});
});

/** One `/api/data/` bucket (day × model). */
function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        user_id: NEWAPI_USER_ID,
        username: NEWAPI_USERNAME,
        model_name: 'gpt-4o',
        created_at: 1715000000,
        count: 1,
        quota: 100,
        token_used: 30,
        ...overrides,
    };
}

describe('periodToTimeRange', () => {
    const NOW = new Date('2026-05-05T12:30:00Z');

    it('all → start=0, end=now', () => {
        const r = periodToTimeRange('all', NOW);
        expect(r.start).toBe(0);
        expect(r.end).toBe(Math.floor(NOW.getTime() / 1000));
    });

    it('7d → trailing 7×86400 seconds', () => {
        expect(periodToTimeRange('7d', NOW).end - periodToTimeRange('7d', NOW).start).toBe(7 * 86_400);
    });

    it('30d → trailing 30×86400 seconds', () => {
        expect(periodToTimeRange('30d', NOW).end - periodToTimeRange('30d', NOW).start).toBe(30 * 86_400);
    });

    it('last_month → previous calendar month UTC (Apr 1 → May 1)', () => {
        const r = periodToTimeRange('last_month', NOW);
        expect(r.start).toBe(Math.floor(Date.UTC(2026, 3, 1) / 1000));
        expect(r.end).toBe(Math.floor(Date.UTC(2026, 4, 1) / 1000));
    });

    it('last_month rolls into previous year for January now', () => {
        const r = periodToTimeRange('last_month', new Date('2026-01-05T12:00:00Z'));
        expect(r.start).toBe(Math.floor(Date.UTC(2025, 11, 1) / 1000));
        expect(r.end).toBe(Math.floor(Date.UTC(2026, 0, 1) / 1000));
    });
});

describe('getUsageAggregate — cache paths', () => {
    const NOW = new Date('2026-05-05T12:00:00Z');

    it('HIT (computed_at within TTL) → cached payload, no live fetch', async () => {
        mockCacheFindUnique.mockResolvedValue({
            user_id: PORTAL_USER_ID,
            period: '30d',
            computed_at: new Date(NOW.getTime() - 60_000),
            payload: {
                totalUsedQuota: 100_000,
                totalCalls: 42,
                totalTokens: 9999,
                byModel: [{ model: 'gpt-4o', calls: 42, quota: 100_000 }],
                byDay: [],
                chartModels: ['gpt-4o'],
            },
        });

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: '30d',
            now: NOW,
        });

        expect(r.source).toBe('cache');
        expect(r.totalCalls).toBe(42);
        expect(r.totalUsedQuota).toBe(100_000);
        expect(r.totalTokens).toBe(9999);
        expect(mockGetUsageDashboard).not.toHaveBeenCalled();
        expect(mockCacheUpsert).not.toHaveBeenCalled();
    });

    it('MISS → fetch live via /api/data/ (username + time window, NO user_id) + write back', async () => {
        mockCacheFindUnique.mockResolvedValue(null);
        mockGetUsageDashboard.mockResolvedValue([
            makeRow({ model_name: 'gpt-4o', count: 2, quota: 150, token_used: 300 }),
            makeRow({ model_name: 'claude-opus', count: 1, quota: 200, token_used: 50 }),
        ]);

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: '7d',
            now: NOW,
        });

        expect(r.source).toBe('live');
        expect(r.totalCalls).toBe(3); // Σ count = 2 + 1
        expect(r.totalUsedQuota).toBe(350);
        expect(r.totalTokens).toBe(350);
        // sorted desc by quota
        expect(r.byModel).toEqual([
            { model: 'claude-opus', calls: 1, quota: 200 },
            { model: 'gpt-4o', calls: 2, quota: 150 },
        ]);
        // filtered on username, time window forwarded, never user_id
        const callArgs = mockGetUsageDashboard.mock.calls[0][0];
        expect(callArgs.username).toBe(NEWAPI_USERNAME);
        expect(callArgs.end_timestamp).toBe(Math.floor(NOW.getTime() / 1000));
        expect(callArgs).not.toHaveProperty('user_id');
        expect(mockGetUsageDashboard).toHaveBeenCalledTimes(1); // no pagination
        expect(mockCacheUpsert).toHaveBeenCalledTimes(1);
    });

    it('STALE (computed_at > TTL) → fetch live + write back', async () => {
        mockCacheFindUnique.mockResolvedValue({
            user_id: PORTAL_USER_ID,
            period: 'all',
            computed_at: new Date(NOW.getTime() - (TTL_MS + 60_000)),
            payload: { totalUsedQuota: 50, totalCalls: 1, totalTokens: 5, byModel: [], byDay: [], chartModels: [] },
        });
        mockGetUsageDashboard.mockResolvedValue([]);

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: 'all',
            now: NOW,
        });

        expect(r.source).toBe('live');
        expect(r.totalCalls).toBe(0);
        expect(mockCacheUpsert).toHaveBeenCalled();
    });

    it('FALLBACK: live fail with stale cache → return stale + source=fallback', async () => {
        mockCacheFindUnique.mockResolvedValue({
            user_id: PORTAL_USER_ID,
            period: 'last_month',
            computed_at: new Date(NOW.getTime() - 30 * 60_000),
            payload: {
                totalUsedQuota: 12345,
                totalCalls: 99,
                totalTokens: 8888,
                byModel: [{ model: 'gpt-4', calls: 99, quota: 12345 }],
                byDay: [],
                chartModels: ['gpt-4'],
            },
        });
        mockGetUsageDashboard.mockRejectedValue(new Error('ECONNREFUSED'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: 'last_month',
            now: NOW,
        });

        expect(r.source).toBe('fallback');
        expect(r.totalCalls).toBe(99);
        expect(r.totalTokens).toBe(8888);
        expect(mockCacheUpsert).not.toHaveBeenCalled();
        expect(mockSentryCapture).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('HARD-FAIL: no cache + live fail → throw + Sentry capture', async () => {
        mockCacheFindUnique.mockResolvedValue(null);
        mockGetUsageDashboard.mockRejectedValue(new Error('new-api 502'));

        await expect(
            getUsageAggregate({
                portalUserId: PORTAL_USER_ID,
                newapiUserId: NEWAPI_USER_ID,
                newapiUsername: NEWAPI_USERNAME,
                period: '7d',
                now: NOW,
            }),
        ).rejects.toThrow(/usage aggregate fetch failed/);

        expect(mockSentryCapture).toHaveBeenCalledWith(
            expect.any(Error),
            expect.objectContaining({ tags: expect.objectContaining({ area: 'usage-aggregate' }) }),
        );
        expect(mockCacheUpsert).not.toHaveBeenCalled();
    });

    it('write-back failure tolerated — still returns live snapshot', async () => {
        mockCacheFindUnique.mockResolvedValue(null);
        mockGetUsageDashboard.mockResolvedValue([makeRow({ quota: 10, count: 1 })]);
        mockCacheUpsert.mockRejectedValue(new Error('DB transient'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: '7d',
            now: NOW,
        });

        expect(r.source).toBe('live');
        expect(r.totalCalls).toBe(1);
        warnSpy.mockRestore();
    });
});

describe('getUsageAggregate — roll-up (count / quota / tokens / byModel / byDay)', () => {
    const NOW = new Date('2026-06-05T12:00:00Z');

    it('sums count / quota / token_used across buckets', async () => {
        mockCacheFindUnique.mockResolvedValue(null);
        mockGetUsageDashboard.mockResolvedValue([
            makeRow({ count: 100, quota: 5000, token_used: 1_000_000 }),
            makeRow({ count: 50, quota: 2500, token_used: 500_000 }),
        ]);

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: '30d',
            now: NOW,
        });

        expect(r.totalCalls).toBe(150);
        expect(r.totalUsedQuota).toBe(7500);
        expect(r.totalTokens).toBe(1_500_000);
    });

    it('buckets byDay by Asia/Shanghai date, stacked per model', async () => {
        mockCacheFindUnique.mockResolvedValue(null);
        const jun1 = Math.floor(Date.UTC(2026, 5, 1, 2, 0, 0) / 1000); // 2026-06-01 Shanghai
        const jun2 = Math.floor(Date.UTC(2026, 5, 1, 20, 0, 0) / 1000); // 2026-06-02 Shanghai (rollover)
        mockGetUsageDashboard.mockResolvedValue([
            makeRow({ created_at: jun1, model_name: 'gpt-5.4', quota: 300, count: 3 }),
            makeRow({ created_at: jun1, model_name: 'claude-opus-4-8', quota: 100, count: 1 }),
            makeRow({ created_at: jun2, model_name: 'gpt-5.4', quota: 50, count: 1 }),
        ]);

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: '30d',
            now: NOW,
        });

        expect(r.byDay).toEqual([
            { date: '2026-06-01', values: { 'gpt-5.4': 300, 'claude-opus-4-8': 100 } },
            { date: '2026-06-02', values: { 'gpt-5.4': 50 } },
        ]);
        expect(r.chartModels).toEqual(['gpt-5.4', 'claude-opus-4-8']);
    });

    it('collapses models beyond the top 6 into 其他', async () => {
        mockCacheFindUnique.mockResolvedValue(null);
        const day = Math.floor(Date.UTC(2026, 5, 3, 2, 0, 0) / 1000);
        mockGetUsageDashboard.mockResolvedValue(
            Array.from({ length: 8 }, (_, i) =>
                makeRow({ created_at: day, model_name: `m${i + 1}`, quota: 1000 - i * 100, count: 1 }),
            ),
        );

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: 'all',
            now: NOW,
        });

        expect(r.chartModels).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', '其他']);
        expect(r.byDay).toHaveLength(1);
        expect(r.byDay[0].values['其他']).toBe(700); // m7(400) + m8(300)
        expect(r.byDay[0].values['m7']).toBeUndefined();
    });

    it('defensive cross-user post-filter excludes mismatched user_id buckets', async () => {
        mockCacheFindUnique.mockResolvedValue(null);
        mockGetUsageDashboard.mockResolvedValue([
            makeRow({ user_id: NEWAPI_USER_ID, quota: 100, count: 1, model_name: 'mine' }),
            makeRow({ user_id: NEWAPI_USER_ID + 1, quota: 999, count: 9, model_name: 'theirs' }),
            makeRow({ user_id: NEWAPI_USER_ID, quota: 50, count: 1, model_name: 'mine' }),
        ]);

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: '7d',
            now: NOW,
        });

        expect(r.totalCalls).toBe(2);
        expect(r.totalUsedQuota).toBe(150);
        expect(r.byModel).toEqual([{ model: 'mine', calls: 2, quota: 150 }]);
    });
});

describe('getUsageAggregate — payload defensiveness', () => {
    const NOW = new Date('2026-05-05T12:00:00Z');

    it('malformed cache payload (missing fields) → safe defaults on HIT', async () => {
        mockCacheFindUnique.mockResolvedValue({
            user_id: PORTAL_USER_ID,
            period: '7d',
            computed_at: new Date(NOW.getTime() - 60_000),
            payload: { totalCalls: 5 }, // everything else missing
        });

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: '7d',
            now: NOW,
        });

        expect(r.source).toBe('cache');
        expect(r.totalCalls).toBe(5);
        expect(r.totalUsedQuota).toBe(0);
        expect(r.totalTokens).toBe(0);
        expect(r.byModel).toEqual([]);
        expect(r.byDay).toEqual([]);
        expect(r.chartModels).toEqual([]);
    });

    it('legacy payload (W6 D5 prompt+completion split, no totalTokens) → summed as fallback', async () => {
        mockCacheFindUnique.mockResolvedValue({
            user_id: PORTAL_USER_ID,
            period: '30d',
            computed_at: new Date(NOW.getTime() - 60_000),
            payload: { totalCalls: 3, totalPromptTokens: 100, totalCompletionTokens: 200, byModel: [] },
        });

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: '30d',
            now: NOW,
        });

        expect(r.totalTokens).toBe(300); // 100 + 200
    });
});

describe('USAGE_PERIODS contract', () => {
    it('exports the 4 supported period keys', async () => {
        const m = await import('@/lib/newapi/usage-aggregate');
        expect(m.USAGE_PERIODS).toEqual(['7d', '30d', 'all', 'last_month']);
        const _periodCheck: UsagePeriod = '7d';
        expect(_periodCheck).toBe('7d');
    });
});
