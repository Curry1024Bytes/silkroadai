/**
 * W4-2 D6 — getQuotaWithCache helper
 *
 * Covers cache hit / miss / stale-refresh / fallback / hard-fail / write-back
 * resilience.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUserFindUnique = vi.fn();
const mockUserUpdate = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        user: {
            findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
            update: (...args: unknown[]) => mockUserUpdate(...args),
        },
    },
}));

const mockNewapiGetUser = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    getUser: (...args: unknown[]) => mockNewapiGetUser(...args),
}));

import { getQuotaWithCache } from '@/lib/newapi/quota-cache';

const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NEWAPI_USER_ID = 7;

beforeEach(() => {
    vi.clearAllMocks();
    mockUserUpdate.mockResolvedValue({});
});

describe('getQuotaWithCache', () => {
    it('cache hit (fresh < 60s) returns source="cache" + does NOT call new-api', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            newapi_user_id: NEWAPI_USER_ID,
            newapi_quota_cache: BigInt(500_000),
            newapi_used_quota_cache: BigInt(100_000),
            newapi_cached_at: new Date(Date.now() - 30_000), // 30s old
        });

        const r = await getQuotaWithCache(PORTAL_USER_ID);
        expect(r).toEqual({
            remain_quota: 500_000,
            used_quota: 100_000,
            source: 'cache',
        });
        expect(mockNewapiGetUser).not.toHaveBeenCalled();
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('cache miss (no cached_at) → fetch live + write-back + source="live"', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            newapi_user_id: NEWAPI_USER_ID,
            newapi_quota_cache: null,
            newapi_used_quota_cache: null,
            newapi_cached_at: null,
        });
        mockNewapiGetUser.mockResolvedValue({ id: NEWAPI_USER_ID, quota: 800_000, used_quota: 50_000 });

        const r = await getQuotaWithCache(PORTAL_USER_ID);
        expect(r).toEqual({ remain_quota: 800_000, used_quota: 50_000, source: 'live' });
        expect(mockNewapiGetUser).toHaveBeenCalledWith(NEWAPI_USER_ID);
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: PORTAL_USER_ID },
                data: expect.objectContaining({
                    newapi_quota_cache: BigInt(800_000),
                    newapi_used_quota_cache: BigInt(50_000),
                    newapi_cached_at: expect.any(Date),
                }),
            }),
        );
    });

    it('stale cache (>60s) → refetch live and write back', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            newapi_user_id: NEWAPI_USER_ID,
            newapi_quota_cache: BigInt(100),
            newapi_used_quota_cache: BigInt(50),
            newapi_cached_at: new Date(Date.now() - 120_000), // 2 min old
        });
        mockNewapiGetUser.mockResolvedValue({ id: NEWAPI_USER_ID, quota: 999, used_quota: 111 });

        const r = await getQuotaWithCache(PORTAL_USER_ID);
        expect(r).toEqual({ remain_quota: 999, used_quota: 111, source: 'live' });
        expect(mockNewapiGetUser).toHaveBeenCalledTimes(1);
        expect(mockUserUpdate).toHaveBeenCalledTimes(1);
    });

    it('fallback: stale cache + new-api throws → returns stale source="fallback" + warns', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            newapi_user_id: NEWAPI_USER_ID,
            newapi_quota_cache: BigInt(700),
            newapi_used_quota_cache: BigInt(33),
            newapi_cached_at: new Date(Date.now() - 5 * 60_000), // 5 min old
        });
        mockNewapiGetUser.mockRejectedValue(new Error('new-api 503'));

        const r = await getQuotaWithCache(PORTAL_USER_ID);
        expect(r).toEqual({ remain_quota: 700, used_quota: 33, source: 'fallback' });
        // No write-back when live fetch failed
        expect(mockUserUpdate).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
        const lines = warnSpy.mock.calls
            .map((c) => c.map((a) => (typeof a === 'string' ? a : '')).join(' '))
            .join('\n');
        expect(lines).toMatch(/quota-cache.*unreachable/);
    });

    it('hard fail: no cache + new-api throws → throws', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            newapi_user_id: NEWAPI_USER_ID,
            newapi_quota_cache: null,
            newapi_used_quota_cache: null,
            newapi_cached_at: null,
        });
        mockNewapiGetUser.mockRejectedValue(new Error('new-api 503'));

        await expect(getQuotaWithCache(PORTAL_USER_ID)).rejects.toThrow(/quota fetch failed/);
    });

    it('user not found → throws', async () => {
        mockUserFindUnique.mockResolvedValue(null);
        await expect(getQuotaWithCache('does-not-exist')).rejects.toThrow(/not found/);
        expect(mockNewapiGetUser).not.toHaveBeenCalled();
    });

    it('user has no newapi_user_id (un-provisioned) → throws', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            newapi_user_id: null,
            newapi_quota_cache: null,
            newapi_used_quota_cache: null,
            newapi_cached_at: null,
        });
        await expect(getQuotaWithCache(PORTAL_USER_ID)).rejects.toThrow(/newapi_user_id/);
        expect(mockNewapiGetUser).not.toHaveBeenCalled();
    });

    it('write-back failure does NOT poison the live response', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            newapi_user_id: NEWAPI_USER_ID,
            newapi_quota_cache: null,
            newapi_used_quota_cache: null,
            newapi_cached_at: null,
        });
        mockNewapiGetUser.mockResolvedValue({ id: NEWAPI_USER_ID, quota: 1000, used_quota: 200 });
        mockUserUpdate.mockRejectedValue(new Error('DB transient'));

        const r = await getQuotaWithCache(PORTAL_USER_ID);
        // Still returns live data
        expect(r).toEqual({ remain_quota: 1000, used_quota: 200, source: 'live' });
        expect(warnSpy).toHaveBeenCalled();
    });

    it('partial cache state (one of three fields null) treated as "no cache"', async () => {
        // newapi_cached_at present but quota fields null → treated as miss
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            newapi_user_id: NEWAPI_USER_ID,
            newapi_quota_cache: null,
            newapi_used_quota_cache: BigInt(50),
            newapi_cached_at: new Date(),
        });
        mockNewapiGetUser.mockResolvedValue({ id: NEWAPI_USER_ID, quota: 100, used_quota: 50 });

        const r = await getQuotaWithCache(PORTAL_USER_ID);
        expect(r.source).toBe('live');
    });
});
