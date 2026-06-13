/**
 * PR-T1 Phase 0b — getOrCreateSystemToken unit tests.
 *
 * Exercises:
 *   - fast path: row already has value → no new-api calls
 *   - first-time provision: 3-step new-api flow + DB persist
 *   - race: concurrent callers → only one persists, the loser cleans
 *     its orphan
 *   - failure modes: user_not_found / user_not_provisioned /
 *     newapi_create_failed / newapi_lookup_failed
 *
 * No real network; prisma + new-api client are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUserFindUnique = vi.fn();
const mockUserUpdateMany = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        user: {
            findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
            updateMany: (...args: unknown[]) => mockUserUpdateMany(...args),
        },
    },
}));

const mockCreateToken = vi.fn();
const mockListTokens = vi.fn();
const mockGetTokenKey = vi.fn();
const mockDeleteToken = vi.fn();

vi.mock('@/lib/newapi/client', () => ({
    createTokenForCustomer: (...args: unknown[]) => mockCreateToken(...args),
    listTokensForCustomer: (...args: unknown[]) => mockListTokens(...args),
    getTokenKey: (...args: unknown[]) => mockGetTokenKey(...args),
    deleteToken: (...args: unknown[]) => mockDeleteToken(...args),
}));

import {
    getOrCreateSystemToken,
    PORTAL_INTERNAL_TOKEN_NAME,
    PortalSystemTokenError,
    _resetGroupTokenCacheForTest,
} from '@/lib/newapi/system-token';

const USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function userBase(
    overrides: Partial<{
        newapi_user_id: number | null;
        newapi_access_token: string | null;
        newapi_system_token_value: string | null;
        newapi_system_token_id: string | null;
    }> = {},
) {
    return {
        id: USER_ID,
        status: 'active',
        newapi_user_id: 99,
        newapi_access_token: 'access-stub-32chars-padding-padding',
        newapi_system_token_id: null,
        newapi_system_token_value: null,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    _resetGroupTokenCacheForTest();
});

describe('getOrCreateSystemToken — fast path', () => {
    it('returns the existing prefixed value without hitting new-api when system_token_value is set', async () => {
        mockUserFindUnique.mockResolvedValueOnce(
            userBase({ newapi_system_token_id: '777', newapi_system_token_value: 'a'.repeat(48) }),
        );

        const result = await getOrCreateSystemToken(USER_ID);

        // formatTokenForDisplay prepends sk- to the 48-char raw stored
        // value. The full string must therefore be sk- + 48 chars.
        expect(result).toMatch(/^sk-/);
        expect(result.length).toBe(51);
        expect(mockCreateToken).not.toHaveBeenCalled();
        expect(mockListTokens).not.toHaveBeenCalled();
        expect(mockGetTokenKey).not.toHaveBeenCalled();
    });
});

describe('getOrCreateSystemToken — first-time provision', () => {
    it('runs the 3-step new-api flow and persists the value', async () => {
        mockUserFindUnique.mockResolvedValueOnce(userBase());
        mockCreateToken.mockResolvedValueOnce(undefined);
        mockListTokens.mockResolvedValueOnce({
            items: [
                { id: 100, name: 'something-else' },
                { id: 200, name: PORTAL_INTERNAL_TOKEN_NAME },
            ],
            total: 2,
        });
        mockGetTokenKey.mockResolvedValueOnce('b'.repeat(48));
        mockUserUpdateMany.mockResolvedValueOnce({ count: 1 });

        const result = await getOrCreateSystemToken(USER_ID);

        expect(mockCreateToken).toHaveBeenCalledTimes(1);
        const [authArg, argsArg] = mockCreateToken.mock.calls[0];
        expect(authArg).toEqual({ accessToken: 'access-stub-32chars-padding-padding', userId: 99 });
        expect(argsArg.name).toBe(PORTAL_INTERNAL_TOKEN_NAME);
        expect(argsArg.unlimited_quota).toBe(true);
        expect(argsArg.expired_time).toBe(-1);

        expect(mockListTokens).toHaveBeenCalledTimes(1);
        expect(mockGetTokenKey).toHaveBeenCalledWith(
            { accessToken: 'access-stub-32chars-padding-padding', userId: 99 },
            200,
        );

        // CAS update with WHERE value=null
        expect(mockUserUpdateMany).toHaveBeenCalledWith({
            where: { id: USER_ID, newapi_system_token_value: null },
            data: { newapi_system_token_id: '200', newapi_system_token_value: 'b'.repeat(48) },
        });

        expect(result).toBe('sk-' + 'b'.repeat(48));
    });

    it('picks the most-recent token id when multiple portal-internal entries exist', async () => {
        mockUserFindUnique.mockResolvedValueOnce(userBase());
        mockCreateToken.mockResolvedValueOnce(undefined);
        mockListTokens.mockResolvedValueOnce({
            items: [
                { id: 100, name: PORTAL_INTERNAL_TOKEN_NAME },
                { id: 300, name: PORTAL_INTERNAL_TOKEN_NAME }, // newest
                { id: 200, name: PORTAL_INTERNAL_TOKEN_NAME },
            ],
            total: 3,
        });
        mockGetTokenKey.mockResolvedValueOnce('c'.repeat(48));
        mockUserUpdateMany.mockResolvedValueOnce({ count: 1 });

        await getOrCreateSystemToken(USER_ID);

        expect(mockGetTokenKey).toHaveBeenCalledWith(expect.anything(), 300);
    });
});

describe('getOrCreateSystemToken — race-loss path', () => {
    it('cleans up its orphan token + returns the winner-persisted value', async () => {
        // First findUnique: row has no system token yet (we'll race).
        mockUserFindUnique.mockResolvedValueOnce(userBase());
        mockCreateToken.mockResolvedValueOnce(undefined);
        mockListTokens.mockResolvedValueOnce({
            items: [{ id: 555, name: PORTAL_INTERNAL_TOKEN_NAME }],
            total: 1,
        });
        mockGetTokenKey.mockResolvedValueOnce('d'.repeat(48));

        // updateMany: count=0 (some other caller won the race)
        mockUserUpdateMany.mockResolvedValueOnce({ count: 0 });

        // Second findUnique to read the winner's value
        mockUserFindUnique.mockResolvedValueOnce({
            newapi_system_token_value: 'e'.repeat(48),
        });

        // Loser deletes its orphan token
        mockDeleteToken.mockResolvedValueOnce(undefined);

        const result = await getOrCreateSystemToken(USER_ID);

        expect(mockDeleteToken).toHaveBeenCalledWith(
            { accessToken: 'access-stub-32chars-padding-padding', userId: 99 },
            555,
        );
        expect(result).toBe('sk-' + 'e'.repeat(48));
    });

    it('throws persistence_failed if winner-read still returns null (defensive)', async () => {
        mockUserFindUnique.mockResolvedValueOnce(userBase());
        mockCreateToken.mockResolvedValueOnce(undefined);
        mockListTokens.mockResolvedValueOnce({
            items: [{ id: 9999, name: PORTAL_INTERNAL_TOKEN_NAME }],
            total: 1,
        });
        mockGetTokenKey.mockResolvedValueOnce('f'.repeat(48));
        mockUserUpdateMany.mockResolvedValueOnce({ count: 0 });
        mockUserFindUnique.mockResolvedValueOnce({ newapi_system_token_value: null });
        mockDeleteToken.mockResolvedValueOnce(undefined);

        await expect(getOrCreateSystemToken(USER_ID)).rejects.toThrow(PortalSystemTokenError);
    });
});

describe('getOrCreateSystemToken — failure modes', () => {
    it('throws user_not_found for unknown user', async () => {
        mockUserFindUnique.mockResolvedValueOnce(null);
        await expect(getOrCreateSystemToken(USER_ID)).rejects.toMatchObject({
            code: 'user_not_found',
        });
    });

    it('throws user_not_provisioned for partially-onboarded user', async () => {
        mockUserFindUnique.mockResolvedValueOnce(userBase({ newapi_user_id: null, newapi_access_token: null }));
        await expect(getOrCreateSystemToken(USER_ID)).rejects.toMatchObject({
            code: 'user_not_provisioned',
        });
    });

    it('throws newapi_create_failed when createTokenForCustomer rejects', async () => {
        mockUserFindUnique.mockResolvedValueOnce(userBase());
        mockCreateToken.mockRejectedValueOnce(new Error('500'));
        await expect(getOrCreateSystemToken(USER_ID)).rejects.toMatchObject({
            code: 'newapi_create_failed',
        });
    });

    it('throws newapi_lookup_failed when listTokensForCustomer rejects', async () => {
        mockUserFindUnique.mockResolvedValueOnce(userBase());
        mockCreateToken.mockResolvedValueOnce(undefined);
        mockListTokens.mockRejectedValueOnce(new Error('502'));
        await expect(getOrCreateSystemToken(USER_ID)).rejects.toMatchObject({
            code: 'newapi_lookup_failed',
        });
    });

    it('throws newapi_lookup_failed when no portal-internal token surfaces in list', async () => {
        mockUserFindUnique.mockResolvedValueOnce(userBase());
        mockCreateToken.mockResolvedValueOnce(undefined);
        mockListTokens.mockResolvedValueOnce({
            items: [{ id: 1, name: 'random' }],
            total: 1,
        });
        await expect(getOrCreateSystemToken(USER_ID)).rejects.toMatchObject({
            code: 'newapi_lookup_failed',
        });
    });

    it('throws newapi_lookup_failed when getTokenKey rejects', async () => {
        mockUserFindUnique.mockResolvedValueOnce(userBase());
        mockCreateToken.mockResolvedValueOnce(undefined);
        mockListTokens.mockResolvedValueOnce({
            items: [{ id: 5, name: PORTAL_INTERNAL_TOKEN_NAME }],
            total: 1,
        });
        mockGetTokenKey.mockRejectedValueOnce(new Error('500'));
        await expect(getOrCreateSystemToken(USER_ID)).rejects.toMatchObject({
            code: 'newapi_lookup_failed',
        });
    });
});

describe('getOrCreateSystemToken — per-group token (Path B)', () => {
    const OFFICIAL_NAME = `${PORTAL_INTERNAL_TOKEN_NAME}-official`;
    const groupUser = () => ({
        id: USER_ID,
        newapi_user_id: 99,
        newapi_access_token: 'access-stub-32chars-padding-padding',
    });

    it("'default' group delegates to the primary (User-row cached) path", async () => {
        mockUserFindUnique.mockResolvedValueOnce(userBase({ newapi_system_token_value: 'a'.repeat(48) }));
        const result = await getOrCreateSystemToken(USER_ID, 'default');
        expect(result).toBe('sk-' + 'a'.repeat(48));
        expect(mockCreateToken).not.toHaveBeenCalled();
        expect(mockListTokens).not.toHaveBeenCalled();
    });

    it('creates a group-pinned portal-internal-{group} token when absent', async () => {
        mockUserFindUnique.mockResolvedValueOnce(groupUser());
        mockListTokens.mockResolvedValueOnce({ items: [{ id: 1, name: 'other' }], total: 1 }); // not found
        mockCreateToken.mockResolvedValueOnce(undefined);
        mockListTokens.mockResolvedValueOnce({ items: [{ id: 42, name: OFFICIAL_NAME }], total: 1 });
        mockGetTokenKey.mockResolvedValueOnce('g'.repeat(48));

        const result = await getOrCreateSystemToken(USER_ID, 'official');

        expect(result).toBe('sk-' + 'g'.repeat(48));
        const [, argsArg] = mockCreateToken.mock.calls[0];
        expect(argsArg.name).toBe(OFFICIAL_NAME);
        expect(argsArg.group).toBe('official'); // ← pins routing + billing
        expect(argsArg.unlimited_quota).toBe(true);
        expect(mockGetTokenKey).toHaveBeenCalledWith(expect.anything(), 42);
    });

    it('reuses an existing group token without creating a new one', async () => {
        mockUserFindUnique.mockResolvedValueOnce(groupUser());
        mockListTokens.mockResolvedValueOnce({ items: [{ id: 7, name: OFFICIAL_NAME }], total: 1 });
        mockGetTokenKey.mockResolvedValueOnce('h'.repeat(48));

        const result = await getOrCreateSystemToken(USER_ID, 'official');

        expect(result).toBe('sk-' + 'h'.repeat(48));
        expect(mockCreateToken).not.toHaveBeenCalled();
        expect(mockGetTokenKey).toHaveBeenCalledWith(expect.anything(), 7);
    });

    it('process-caches the group token (no second lookup)', async () => {
        mockUserFindUnique.mockResolvedValueOnce(groupUser());
        mockListTokens.mockResolvedValueOnce({ items: [{ id: 9, name: OFFICIAL_NAME }], total: 1 });
        mockGetTokenKey.mockResolvedValueOnce('i'.repeat(48));

        const first = await getOrCreateSystemToken(USER_ID, 'official');
        const second = await getOrCreateSystemToken(USER_ID, 'official'); // cache hit

        expect(first).toBe(second);
        expect(mockUserFindUnique).toHaveBeenCalledTimes(1);
        expect(mockListTokens).toHaveBeenCalledTimes(1);
    });

    it('throws user_not_provisioned when the customer has no new-api linkage', async () => {
        mockUserFindUnique.mockResolvedValueOnce({ id: USER_ID, newapi_user_id: null, newapi_access_token: null });
        await expect(getOrCreateSystemToken(USER_ID, 'official')).rejects.toMatchObject({
            code: 'user_not_provisioned',
        });
    });
});
