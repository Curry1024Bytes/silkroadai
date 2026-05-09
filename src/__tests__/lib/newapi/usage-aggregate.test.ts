/**
 * W6 D5 — getUsageAggregate unit tests.
 *
 * 4-path cache mirror plus paging-correctness coverage. Mirrors the
 * W4-2 D6 quota-cache + W6 D4 token-usage test patterns.
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

const mockQueryLogs = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    queryLogs: (...args: unknown[]) => mockQueryLogs(...args),
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

function makeLog(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: 1,
        type: 2,
        // W7 D4 PR-J Bug 2: aggregator now post-filters on user_id matching
        // — fixtures default to NEWAPI_USER_ID so existing happy-path tests
        // pass through the filter unchanged.
        user_id: NEWAPI_USER_ID,
        username: NEWAPI_USERNAME,
        quota: 100,
        model_name: 'gpt-4o',
        token_id: 1,
        created_at: 1715000000,
        ...overrides,
    };
}

describe('periodToTimeRange (W6 D5)', () => {
    const NOW = new Date('2026-05-05T12:30:00Z');

    it('all → start=0, end=now', () => {
        const r = periodToTimeRange('all', NOW);
        expect(r.start).toBe(0);
        expect(r.end).toBe(Math.floor(NOW.getTime() / 1000));
    });

    it('7d → trailing 7×86400 seconds', () => {
        const r = periodToTimeRange('7d', NOW);
        expect(r.end - r.start).toBe(7 * 86_400);
    });

    it('30d → trailing 30×86400 seconds', () => {
        const r = periodToTimeRange('30d', NOW);
        expect(r.end - r.start).toBe(30 * 86_400);
    });

    it('last_month → previous calendar month UTC (start=Apr 1, end=May 1)', () => {
        const r = periodToTimeRange('last_month', NOW);
        const aprilFirst = Math.floor(Date.UTC(2026, 3, 1, 0, 0, 0) / 1000);
        const mayFirst = Math.floor(Date.UTC(2026, 4, 1, 0, 0, 0) / 1000);
        expect(r.start).toBe(aprilFirst);
        expect(r.end).toBe(mayFirst);
    });

    it('last_month rolls into previous year for January now', () => {
        // On Jan 5 2026, last_month should be December 1 2025 → Jan 1 2026
        const jan2026 = new Date('2026-01-05T12:00:00Z');
        const r = periodToTimeRange('last_month', jan2026);
        expect(r.start).toBe(Math.floor(Date.UTC(2025, 11, 1, 0, 0, 0) / 1000));
        expect(r.end).toBe(Math.floor(Date.UTC(2026, 0, 1, 0, 0, 0) / 1000));
    });
});

describe('getUsageAggregate — cache paths', () => {
    const NOW = new Date('2026-05-05T12:00:00Z');

    it('HIT (computed_at within 5min) → returns cached payload, no live fetch', async () => {
        mockCacheFindUnique.mockResolvedValue({
            user_id: PORTAL_USER_ID,
            period: '30d',
            computed_at: new Date(NOW.getTime() - 60_000), // 1min ago
            payload: {
                totalUsedQuota: 100_000,
                totalCalls: 42,
                byModel: [
                    { model: 'gpt-4o', calls: 30, quota: 80_000 },
                    { model: 'claude-opus-4-7', calls: 12, quota: 20_000 },
                ],
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
        expect(r.byModel).toHaveLength(2);
        expect(r.pagesFetched).toBe(0);
        expect(mockQueryLogs).not.toHaveBeenCalled();
        expect(mockCacheUpsert).not.toHaveBeenCalled();
    });

    it('MISS (no cache row) → fetches live + writes back + source=live', async () => {
        mockCacheFindUnique.mockResolvedValue(null);
        mockQueryLogs.mockResolvedValue({
            items: [
                makeLog({ quota: 100, model_name: 'gpt-4o' }),
                makeLog({ quota: 50, model_name: 'gpt-4o' }),
                makeLog({ quota: 200, model_name: 'claude-opus' }),
            ],
            total: 3,
        });

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: '7d',
            now: NOW,
        });

        expect(r.source).toBe('live');
        expect(r.totalCalls).toBe(3);
        expect(r.totalUsedQuota).toBe(350);
        // Sorted desc by quota — claude (200) before gpt-4o (150)
        expect(r.byModel).toEqual([
            { model: 'claude-opus', calls: 1, quota: 200 },
            { model: 'gpt-4o', calls: 2, quota: 150 },
        ]);

        // W7 D4 PR-J Bug 2: filter on `username` (admin auth ignores
        // `user_id`, gotcha #15). The `user_id` field is now used only
        // by the in-process post-filter, never sent to new-api.
        expect(mockQueryLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                username: NEWAPI_USERNAME,
                type: 2,
                page_size: 1000,
            }),
        );
        expect(mockQueryLogs).not.toHaveBeenCalledWith(expect.objectContaining({ user_id: expect.anything() }));
        expect(mockCacheUpsert).toHaveBeenCalledTimes(1);
    });

    it('STALE (computed_at > 5min) → fetches live + writes back', async () => {
        mockCacheFindUnique.mockResolvedValue({
            user_id: PORTAL_USER_ID,
            period: 'all',
            computed_at: new Date(NOW.getTime() - (TTL_MS + 60_000)),
            payload: { totalUsedQuota: 50, totalCalls: 1, byModel: [] },
        });
        mockQueryLogs.mockResolvedValue({ items: [], total: 0 });

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: 'all',
            now: NOW,
        });

        expect(r.source).toBe('live');
        expect(r.totalCalls).toBe(0); // fresh fetch returned empty
        expect(mockCacheUpsert).toHaveBeenCalled();
    });

    it('FALLBACK: live fail with stale cache → return stale + source=fallback', async () => {
        mockCacheFindUnique.mockResolvedValue({
            user_id: PORTAL_USER_ID,
            period: 'last_month',
            computed_at: new Date(NOW.getTime() - 30 * 60_000), // 30min stale
            payload: {
                totalUsedQuota: 12345,
                totalCalls: 99,
                byModel: [{ model: 'gpt-4', calls: 99, quota: 12345 }],
            },
        });
        mockQueryLogs.mockRejectedValue(new Error('ECONNREFUSED'));
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
        expect(r.totalUsedQuota).toBe(12345);
        expect(mockCacheUpsert).not.toHaveBeenCalled(); // no fresh data to write
        expect(mockSentryCapture).not.toHaveBeenCalled(); // fallback isn't Sentry-worthy
        warnSpy.mockRestore();
    });

    it('HARD-FAIL: no cache + live fail → throw + Sentry capture', async () => {
        mockCacheFindUnique.mockResolvedValue(null);
        mockQueryLogs.mockRejectedValue(new Error('new-api 502'));

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
        mockQueryLogs.mockResolvedValue({
            items: [makeLog({ quota: 10 })],
            total: 1,
        });
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

describe('getUsageAggregate — paging across multiple pages', () => {
    const NOW = new Date('2026-05-05T12:00:00Z');

    it('paginates 3 pages (1000+1000+500) when total exceeds first page', async () => {
        mockCacheFindUnique.mockResolvedValue(null);
        // Simulate 2500-row period: page 1 = 1000, page 2 = 1000, page 3 = 500
        const fullPage = Array.from({ length: 1000 }, (_, i) => makeLog({ id: i, quota: 1, model_name: 'gpt-4o' }));
        const halfPage = Array.from({ length: 500 }, (_, i) =>
            makeLog({ id: i + 2000, quota: 1, model_name: 'claude-opus' }),
        );
        mockQueryLogs
            .mockResolvedValueOnce({ items: fullPage, total: 2500 })
            .mockResolvedValueOnce({ items: fullPage, total: 2500 })
            .mockResolvedValueOnce({ items: halfPage, total: 2500 });

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: 'all',
            now: NOW,
        });

        expect(r.source).toBe('live');
        expect(r.pagesFetched).toBe(3);
        expect(r.totalCalls).toBe(2500);
        expect(r.totalUsedQuota).toBe(2500);
        // by_model: gpt-4o (2000) before claude-opus (500)
        expect(r.byModel).toEqual([
            { model: 'gpt-4o', calls: 2000, quota: 2000 },
            { model: 'claude-opus', calls: 500, quota: 500 },
        ]);
    });

    it('early-exit when items.length < page_size on first page', async () => {
        mockCacheFindUnique.mockResolvedValue(null);
        mockQueryLogs.mockResolvedValueOnce({
            items: Array.from({ length: 50 }, () => makeLog({ quota: 10 })),
            total: 50,
        });

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: '30d',
            now: NOW,
        });

        expect(r.pagesFetched).toBe(1);
        expect(r.totalCalls).toBe(50);
        expect(mockQueryLogs).toHaveBeenCalledTimes(1);
    });

    it('caps at MAX_PAGES (50) — hard limit on pathologically heavy windows', async () => {
        mockCacheFindUnique.mockResolvedValue(null);
        // Always return 1000 rows + total=999_999 so the loop never gets the
        // "we've covered everything" early-exit. MAX_PAGES kicks in.
        mockQueryLogs.mockResolvedValue({
            items: Array.from({ length: 1000 }, () => makeLog({ quota: 1 })),
            total: 999_999,
        });

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: 'all',
            now: NOW,
        });

        expect(r.pagesFetched).toBe(50);
        expect(r.totalCalls).toBe(50 * 1000);
        expect(mockQueryLogs).toHaveBeenCalledTimes(50);
    });

    it('Bug 2 — defensive cross-user post-filter excludes rows with mismatched user_id', async () => {
        // Simulates a future regression where new-api's username filter
        // loosens (or admin auth dumps everything again, like gotcha #15).
        // Aggregator must not pollute the cache with other users' rows
        // even if upstream returns them.
        mockCacheFindUnique.mockResolvedValue(null);
        mockQueryLogs.mockResolvedValue({
            items: [
                makeLog({ user_id: NEWAPI_USER_ID, quota: 100, model_name: 'mine' }),
                makeLog({ user_id: NEWAPI_USER_ID + 1, quota: 999, model_name: 'theirs' }),
                makeLog({ user_id: NEWAPI_USER_ID, quota: 50, model_name: 'mine' }),
                makeLog({ user_id: 999, quota: 9999, model_name: 'rogue' }),
            ],
            total: 4,
        });

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: '7d',
            now: new Date('2026-05-05T12:00:00Z'),
        });

        // Only my 2 rows count; cross-user rows are scrubbed entirely.
        expect(r.totalCalls).toBe(2);
        expect(r.totalUsedQuota).toBe(150);
        expect(r.byModel).toEqual([{ model: 'mine', calls: 2, quota: 150 }]);
    });

    it('filters non-type=2 rows defensively (refunds / manage rows excluded)', async () => {
        mockCacheFindUnique.mockResolvedValue(null);
        mockQueryLogs.mockResolvedValue({
            items: [
                makeLog({ type: 2, quota: 100 }),
                makeLog({ type: 6, quota: 50 }), // refund — must be excluded
                makeLog({ type: 1, quota: 999 }), // topup — must be excluded
                makeLog({ type: 2, quota: 200 }),
            ],
            total: 4,
        });

        const r = await getUsageAggregate({
            portalUserId: PORTAL_USER_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiUsername: NEWAPI_USERNAME,
            period: 'all',
            now: NOW,
        });

        expect(r.totalCalls).toBe(2); // only type=2 entries
        expect(r.totalUsedQuota).toBe(300);
    });
});

describe('getUsageAggregate — payload defensiveness', () => {
    const NOW = new Date('2026-05-05T12:00:00Z');

    it('sanitizes malformed payload (missing fields → defaults) on cache hit', async () => {
        mockCacheFindUnique.mockResolvedValue({
            user_id: PORTAL_USER_ID,
            period: '7d',
            computed_at: new Date(NOW.getTime() - 60_000),
            payload: {
                // Old-format row missing some fields
                totalCalls: 5,
                // totalUsedQuota missing
                // byModel missing
            },
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
        expect(r.totalUsedQuota).toBe(0); // defaulted
        expect(r.byModel).toEqual([]);
    });
});

describe('USAGE_PERIODS contract', () => {
    it('exports the 4 supported period keys', async () => {
        const m = await import('@/lib/newapi/usage-aggregate');
        expect(m.USAGE_PERIODS).toEqual(['7d', '30d', 'all', 'last_month']);
        // Type-system check — if the assertion below fails the type changed
        // and call sites need to be updated.
        const _periodCheck: UsagePeriod = '7d';
        expect(_periodCheck).toBe('7d');
    });
});
