/**
 * P6a: OAuth branch-4 (brand-new email → create user) must attribute the new
 * customer to the request-domain's tenant (tenantId passed by the callback).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockOAuthFindUnique = vi.fn();
const mockUserFindUnique = vi.fn();
const mockUserCreate = vi.fn();
const mockUserDelete = vi.fn();
const mockTokenCreate = vi.fn();
const mockTransaction = vi.fn();
const mockProvision = vi.fn();
const mockGetOrCreateSystemToken = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        oAuthAccount: { findUnique: (...a: unknown[]) => mockOAuthFindUnique(...a) },
        user: {
            findUnique: (...a: unknown[]) => mockUserFindUnique(...a),
            create: (...a: unknown[]) => mockUserCreate(...a),
            update: vi.fn(),
            delete: (...a: unknown[]) => mockUserDelete(...a),
        },
        newApiToken: { create: (...a: unknown[]) => mockTokenCreate(...a) },
        $transaction: (...a: unknown[]) => mockTransaction(...a),
    },
}));
vi.mock('@/lib/newapi/client', () => ({
    provisionNewCustomer: (...a: unknown[]) => mockProvision(...a),
    deleteUser: vi.fn(),
    searchUser: vi.fn(),
}));
vi.mock('@/lib/newapi/system-token', () => ({
    getOrCreateSystemToken: (...a: unknown[]) => mockGetOrCreateSystemToken(...a),
}));

import { linkOrCreateOAuthUser } from '@/lib/auth/oauth/account-link';

const IDENTITY = { provider: 'github', providerAccountId: 'gh-1', email: 'new@example.com', nameHint: 'New' };

beforeEach(() => {
    vi.clearAllMocks();
    mockOAuthFindUnique.mockResolvedValue(null); // no existing link
    mockUserFindUnique.mockResolvedValue(null); // brand new email → branch 4
    mockUserCreate.mockResolvedValue({ id: 'u1' });
    mockProvision.mockResolvedValue({
        newapi_user_id: 42,
        newapi_username: 'c-u1',
        newapi_access_token: 'acc',
        newapi_token_id: 7,
        newapi_token_value: 'sk-xxx',
    });
    mockTransaction.mockResolvedValue([]);
    mockGetOrCreateSystemToken.mockResolvedValue(undefined);
});

describe('linkOrCreateOAuthUser — tenant attribution (branch 4)', () => {
    it('stamps tenant_id from the passed tenantId on the new user', async () => {
        const out = await linkOrCreateOAuthUser(IDENTITY, 'tenant-7');
        expect(out).toEqual({ ok: true, userId: 'u1', branch: 4 });
        expect(mockUserCreate.mock.calls[0][0].data.tenant_id).toBe('tenant-7');
    });

    it('no tenantId → tenant_id null (back-compat)', async () => {
        await linkOrCreateOAuthUser(IDENTITY);
        expect(mockUserCreate.mock.calls[0][0].data.tenant_id).toBeNull();
    });

    it('existing link (branch 1) → does NOT create a user (no re-attribution)', async () => {
        mockOAuthFindUnique.mockResolvedValue({ user: { id: 'existing', status: 'active' } });
        const out = await linkOrCreateOAuthUser(IDENTITY, 'tenant-7');
        expect(out).toEqual({ ok: true, userId: 'existing', branch: 1 });
        expect(mockUserCreate).not.toHaveBeenCalled();
    });
});
