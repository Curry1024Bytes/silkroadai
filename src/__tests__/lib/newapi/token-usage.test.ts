/**
 * W6 D4 — getTokenUsageWithCache unit tests.
 *
 * Mirrors the W4-2 D6 quota-cache test patterns (4 paths: hit / miss-then-
 * write-back / stale-fallback / hard-fail). Prisma + new-api both mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTokenFindUnique = vi.fn();
const mockTokenUpdate = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        newApiToken: {
            findUnique: (...args: unknown[]) => mockTokenFindUnique(...args),
            update: (...args: unknown[]) => mockTokenUpdate(...args),
        },
    },
}));

const mockQueryLogs = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    queryLogs: (...args: unknown[]) => mockQueryLogs(...args),
}));

import { getTokenUsageWithCache } from '@/lib/newapi/token-usage';

const PRISMA_TOKEN_ID = 'tok-uuid-1111';
const NEWAPI_USER_ID = 7;
const NEWAPI_TOKEN_ID = 42;
const TTL_MS = 60_000;
const NOW = new Date('2026-05-05T12:00:00Z');

beforeEach(() => {
    vi.clearAllMocks();
    mockTokenUpdate.mockResolvedValue({});
});

describe('getTokenUsageWithCache — happy paths', () => {
    it('cache HIT (fresh < 60s) → returns cached_used_quota with source=cache, no log fetch', async () => {
        mockTokenFindUnique.mockResolvedValue({
            cached_used_quota: BigInt(1234),
            cached_used_at: new Date(NOW.getTime() - 30_000), // 30s old, fresh
        });

        const r = await getTokenUsageWithCache({
            prismaTokenId: PRISMA_TOKEN_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiTokenId: NEWAPI_TOKEN_ID,
            now: NOW,
        });

        expect(r.source).toBe('cache');
        expect(r.used_quota).toBe(BigInt(1234));
        expect(mockQueryLogs).not.toHaveBeenCalled();
        expect(mockTokenUpdate).not.toHaveBeenCalled();
    });

    it('cache MISS (cached_used_at null) → fetches live + writes back + source=live', async () => {
        mockTokenFindUnique.mockResolvedValue({
            cached_used_quota: BigInt(0),
            cached_used_at: null,
        });
        mockQueryLogs.mockResolvedValue({
            items: [
                { token_id: NEWAPI_TOKEN_ID, quota: 100, created_at: 1715000000 },
                { token_id: NEWAPI_TOKEN_ID, quota: 250, created_at: 1715100000 },
                // Other-token entry — must be filtered out
                { token_id: 999, quota: 9_999_999, created_at: 1715200000 },
            ],
            total: 3,
        });

        const r = await getTokenUsageWithCache({
            prismaTokenId: PRISMA_TOKEN_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiTokenId: NEWAPI_TOKEN_ID,
            now: NOW,
        });

        expect(r.source).toBe('live');
        // Sum of matching token_id only: 100 + 250 = 350
        expect(r.used_quota).toBe(BigInt(350));
        expect(r.last_used_at?.getTime()).toBe(1715100000 * 1000);

        // queryLogs called with token_id forwarded + type=2 (consume)
        expect(mockQueryLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                user_id: NEWAPI_USER_ID,
                token_id: NEWAPI_TOKEN_ID,
                type: 2,
                page_size: 1000,
            }),
        );

        // Write-back called with the fetched values
        expect(mockTokenUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: PRISMA_TOKEN_ID },
                data: expect.objectContaining({
                    cached_used_quota: BigInt(350),
                    cached_used_at: NOW,
                }),
            }),
        );
    });

    it('cache STALE (> 60s) → fetches live + write-back + source=live', async () => {
        mockTokenFindUnique.mockResolvedValue({
            cached_used_quota: BigInt(500),
            cached_used_at: new Date(NOW.getTime() - (TTL_MS + 5_000)),
        });
        mockQueryLogs.mockResolvedValue({ items: [], total: 0 });

        const r = await getTokenUsageWithCache({
            prismaTokenId: PRISMA_TOKEN_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiTokenId: NEWAPI_TOKEN_ID,
            now: NOW,
        });

        expect(r.source).toBe('live');
        expect(r.used_quota).toBe(BigInt(0));
        expect(r.last_used_at).toBeNull();
        expect(mockQueryLogs).toHaveBeenCalledTimes(1);
    });

    it('write-back failure does NOT propagate — still returns live snapshot', async () => {
        mockTokenFindUnique.mockResolvedValue({
            cached_used_quota: BigInt(0),
            cached_used_at: null,
        });
        mockQueryLogs.mockResolvedValue({
            items: [{ token_id: NEWAPI_TOKEN_ID, quota: 50, created_at: 1715000000 }],
            total: 1,
        });
        mockTokenUpdate.mockRejectedValue(new Error('DB write-back transient'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const r = await getTokenUsageWithCache({
            prismaTokenId: PRISMA_TOKEN_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiTokenId: NEWAPI_TOKEN_ID,
            now: NOW,
        });

        expect(r.source).toBe('live');
        expect(r.used_quota).toBe(BigInt(50));
        warnSpy.mockRestore();
    });
});

describe('getTokenUsageWithCache — failure modes', () => {
    it('new-api fail WITH stale cache → fallback returning stale + source=fallback', async () => {
        mockTokenFindUnique.mockResolvedValue({
            cached_used_quota: BigInt(2000),
            cached_used_at: new Date(NOW.getTime() - 5 * 60_000), // 5min old, stale
        });
        mockQueryLogs.mockRejectedValue(new Error('ECONNREFUSED'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const r = await getTokenUsageWithCache({
            prismaTokenId: PRISMA_TOKEN_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiTokenId: NEWAPI_TOKEN_ID,
            now: NOW,
        });

        expect(r.source).toBe('fallback');
        expect(r.used_quota).toBe(BigInt(2000)); // returns stale value
        // The stale cached_used_at is surfaced as last_used_at proxy
        expect(r.last_used_at).toBeInstanceOf(Date);
        // No write-back attempted (we don't have fresh data to write)
        expect(mockTokenUpdate).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('hard fail (no cache + new-api dead) → throws, no write-back', async () => {
        mockTokenFindUnique.mockResolvedValue({
            cached_used_quota: BigInt(0),
            cached_used_at: null, // no cache ever
        });
        mockQueryLogs.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(
            getTokenUsageWithCache({
                prismaTokenId: PRISMA_TOKEN_ID,
                newapiUserId: NEWAPI_USER_ID,
                newapiTokenId: NEWAPI_TOKEN_ID,
                now: NOW,
            }),
        ).rejects.toThrow(/token usage fetch failed/);

        expect(mockTokenUpdate).not.toHaveBeenCalled();
    });

    it('throws when prisma row not found (caller passed bad id)', async () => {
        mockTokenFindUnique.mockResolvedValue(null);

        await expect(
            getTokenUsageWithCache({
                prismaTokenId: 'does-not-exist',
                newapiUserId: NEWAPI_USER_ID,
                newapiTokenId: NEWAPI_TOKEN_ID,
                now: NOW,
            }),
        ).rejects.toThrow(/not found/);

        expect(mockQueryLogs).not.toHaveBeenCalled();
    });
});

describe('getTokenUsageWithCache — log filtering correctness', () => {
    it('post-filter sums ONLY matching token_id (defends against new-api ignoring the filter)', async () => {
        mockTokenFindUnique.mockResolvedValue({
            cached_used_quota: BigInt(0),
            cached_used_at: null,
        });
        // Realistic mixed batch — new-api returns logs for the user across
        // ALL their tokens. Our helper must isolate per token_id.
        mockQueryLogs.mockResolvedValue({
            items: [
                { token_id: NEWAPI_TOKEN_ID, quota: 10, created_at: 100 },
                { token_id: 99, quota: 1_000_000, created_at: 200 },
                { token_id: NEWAPI_TOKEN_ID, quota: 20, created_at: 300 },
                { token_id: 99, quota: 1_000_000, created_at: 400 },
                { token_id: NEWAPI_TOKEN_ID, quota: 30, created_at: 500 },
            ],
            total: 5,
        });

        const r = await getTokenUsageWithCache({
            prismaTokenId: PRISMA_TOKEN_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiTokenId: NEWAPI_TOKEN_ID,
            now: NOW,
        });

        expect(r.used_quota).toBe(BigInt(60)); // 10 + 20 + 30
        // last_used_at picks max created_at among MATCHING entries (500), not 400
        expect(r.last_used_at?.getTime()).toBe(500 * 1000);
    });

    it('no log entries match → used_quota=0, last_used_at=null, still source=live + write-back', async () => {
        mockTokenFindUnique.mockResolvedValue({
            cached_used_quota: BigInt(0),
            cached_used_at: null,
        });
        mockQueryLogs.mockResolvedValue({
            items: [{ token_id: 999, quota: 50, created_at: 100 }],
            total: 1,
        });

        const r = await getTokenUsageWithCache({
            prismaTokenId: PRISMA_TOKEN_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiTokenId: NEWAPI_TOKEN_ID,
            now: NOW,
        });

        expect(r.source).toBe('live');
        expect(r.used_quota).toBe(BigInt(0));
        expect(r.last_used_at).toBeNull();
        // Write-back still runs (legitimate "we know the answer is 0")
        expect(mockTokenUpdate).toHaveBeenCalled();
    });
});

// 2026-08-15:/keys 的 N+1 修复 —— 调用方把列表查询里已经读到的缓存两列
// 直接传进来,不再让本函数对【同一行】重复 findUnique。
describe('getTokenUsageWithCache — cachedRow(省掉重复单行读)', () => {
    it('给了 cachedRow 且新鲜 → 不查 DB、不打上游', async () => {
        const r = await getTokenUsageWithCache({
            prismaTokenId: PRISMA_TOKEN_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiTokenId: NEWAPI_TOKEN_ID,
            now: NOW,
            cachedRow: {
                cached_used_quota: BigInt(555),
                cached_used_at: new Date(NOW.getTime() - 30_000), // fresh
            },
        });

        expect(r).toEqual({
            used_quota: BigInt(555),
            last_used_at: new Date(NOW.getTime() - 30_000),
            source: 'cache',
        });
        expect(mockTokenFindUnique).not.toHaveBeenCalled(); // 这就是被省掉的那次往返
        expect(mockQueryLogs).not.toHaveBeenCalled();
    });

    it('给了 cachedRow 但已过期 → 仍不查 DB,照常打上游 + 写回', async () => {
        mockQueryLogs.mockResolvedValue({
            items: [{ token_id: NEWAPI_TOKEN_ID, quota: 90, created_at: 1767225600, user_id: NEWAPI_USER_ID, type: 2 }],
        });

        const r = await getTokenUsageWithCache({
            prismaTokenId: PRISMA_TOKEN_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiTokenId: NEWAPI_TOKEN_ID,
            now: NOW,
            cachedRow: {
                cached_used_quota: BigInt(1),
                cached_used_at: new Date(NOW.getTime() - TTL_MS - 1), // stale
            },
        });

        expect(r.source).toBe('live');
        expect(r.used_quota).toBe(BigInt(90));
        expect(mockTokenFindUnique).not.toHaveBeenCalled();
        expect(mockTokenUpdate).toHaveBeenCalled();
    });

    it('不给 cachedRow → 维持原行为,自己 findUnique(proxy 热路径等单点调用方不受影响)', async () => {
        mockTokenFindUnique.mockResolvedValue({
            cached_used_quota: BigInt(77),
            cached_used_at: new Date(NOW.getTime() - 30_000),
        });

        const r = await getTokenUsageWithCache({
            prismaTokenId: PRISMA_TOKEN_ID,
            newapiUserId: NEWAPI_USER_ID,
            newapiTokenId: NEWAPI_TOKEN_ID,
            now: NOW,
        });

        expect(r.used_quota).toBe(BigInt(77));
        expect(mockTokenFindUnique).toHaveBeenCalledTimes(1);
    });
});
