import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── prisma mock ──
const mockOAuthFindUnique = vi.fn();
const mockOAuthCreate = vi.fn();
const mockUserFindUnique = vi.fn();
const mockUserCreate = vi.fn();
const mockUserUpdate = vi.fn();
const mockUserDelete = vi.fn();
const mockTokenCreate = vi.fn();
const mockTransaction = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        oAuthAccount: {
            findUnique: (...args: unknown[]) => mockOAuthFindUnique(...args),
            create: (...args: unknown[]) => mockOAuthCreate(...args),
        },
        user: {
            findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
            create: (...args: unknown[]) => mockUserCreate(...args),
            update: (...args: unknown[]) => mockUserUpdate(...args),
            delete: (...args: unknown[]) => mockUserDelete(...args),
        },
        newApiToken: {
            create: (...args: unknown[]) => mockTokenCreate(...args),
        },
        $transaction: (...args: unknown[]) => mockTransaction(...args),
    },
}));

// ── new-api client mock ──
const mockProvision = vi.fn();
const mockSearchUser = vi.fn();
const mockDeleteUser = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    provisionNewCustomer: (...args: unknown[]) => mockProvision(...args),
    searchUser: (...args: unknown[]) => mockSearchUser(...args),
    deleteUser: (...args: unknown[]) => mockDeleteUser(...args),
}));

import { linkOrCreateOAuthUser } from '../account-link';

const PROVIDER = 'github';
const ACCOUNT_ID = '12345678';
const EMAIL = 'happy@example.com';
const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

describe('linkOrCreateOAuthUser (5-branch policy)', () => {
    it('Branch 1: existing oauth_account → return that user without touching anything else', async () => {
        mockOAuthFindUnique.mockResolvedValue({
            user: { id: PORTAL_USER_ID, status: 'active' },
        });

        const result = await linkOrCreateOAuthUser({
            provider: PROVIDER,
            providerAccountId: ACCOUNT_ID,
            email: EMAIL,
        });

        expect(result).toEqual({ ok: true, userId: PORTAL_USER_ID, branch: 1 });
        // No further DB writes — pure login path
        expect(mockOAuthCreate).not.toHaveBeenCalled();
        expect(mockUserCreate).not.toHaveBeenCalled();
        expect(mockUserUpdate).not.toHaveBeenCalled();
        expect(mockProvision).not.toHaveBeenCalled();
    });

    it('Branch 1 (banned variant): existing link to disabled account → account_disabled', async () => {
        mockOAuthFindUnique.mockResolvedValue({
            user: { id: PORTAL_USER_ID, status: 'banned' },
        });

        const result = await linkOrCreateOAuthUser({
            provider: PROVIDER,
            providerAccountId: ACCOUNT_ID,
            email: EMAIL,
        });

        expect(result).toEqual({ ok: false, error: 'account_disabled' });
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('Branch 2 (link-verified): existing user with email_verified=true → silent oauth_account create, no transaction', async () => {
        mockOAuthFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            status: 'active',
            email_verified: true,
        });
        mockOAuthCreate.mockResolvedValue({ id: 'oauth-row-1' });

        const result = await linkOrCreateOAuthUser({
            provider: PROVIDER,
            providerAccountId: ACCOUNT_ID,
            email: EMAIL,
        });

        expect(result).toEqual({ ok: true, userId: PORTAL_USER_ID, branch: 2 });
        expect(mockOAuthCreate).toHaveBeenCalledWith({
            data: {
                user_id: PORTAL_USER_ID,
                provider: PROVIDER,
                provider_account_id: ACCOUNT_ID,
            },
        });
        // single create, not a transaction
        expect(mockTransaction).not.toHaveBeenCalled();
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('Branch 3 (bootstrap-unverified): existing user with email_verified=false → flips email_verified + links in one transaction', async () => {
        mockOAuthFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            status: 'active',
            email_verified: false,
        });

        const result = await linkOrCreateOAuthUser({
            provider: PROVIDER,
            providerAccountId: ACCOUNT_ID,
            email: EMAIL,
        });

        expect(result).toEqual({ ok: true, userId: PORTAL_USER_ID, branch: 3 });
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: PORTAL_USER_ID },
                data: expect.objectContaining({
                    email_verified: true,
                    email_verified_at: expect.any(Date),
                }),
            }),
        );
        expect(mockOAuthCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    user_id: PORTAL_USER_ID,
                    provider: PROVIDER,
                    provider_account_id: ACCOUNT_ID,
                }),
            }),
        );
    });

    it('Branch 4 (fresh signup): create user (no password, verified) + provision + link transaction', async () => {
        const NEW_USER_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
        mockOAuthFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue(null);
        mockUserCreate.mockResolvedValue({ id: NEW_USER_ID });
        mockProvision.mockResolvedValue({
            newapi_user_id: 42,
            newapi_username: `c-${NEW_USER_ID.slice(0, 8)}`,
            newapi_access_token: 'access-token-xxx',
            newapi_token_id: 7,
            newapi_token_value: 'sk-real-key',
        });

        const result = await linkOrCreateOAuthUser({
            provider: PROVIDER,
            providerAccountId: ACCOUNT_ID,
            email: 'newbie@example.com',
            nameHint: 'Newbie User',
        });

        expect(result).toEqual({ ok: true, userId: NEW_USER_ID, branch: 4 });
        // user.create with password_hash=null + email_verified=true + nested oauth link
        expect(mockUserCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    email: 'newbie@example.com',
                    password_hash: null,
                    nickname: 'Newbie User',
                    email_verified: true,
                    oauth_accounts: {
                        create: expect.objectContaining({
                            provider: PROVIDER,
                            provider_account_id: ACCOUNT_ID,
                        }),
                    },
                }),
            }),
        );
        expect(mockProvision).toHaveBeenCalledWith(
            expect.objectContaining({
                portal_user_id: NEW_USER_ID,
                email: 'newbie@example.com',
                initial_quota: 0,
            }),
        );
    });

    it('Branch 4 nameHint truncated to 64 chars', async () => {
        mockOAuthFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue(null);
        mockUserCreate.mockResolvedValue({ id: 'newid' });
        mockProvision.mockResolvedValue({
            newapi_user_id: 1,
            newapi_username: 'c-newid',
            newapi_access_token: 'a',
            newapi_token_id: 1,
            newapi_token_value: 'sk',
        });

        const longName = 'x'.repeat(80);
        await linkOrCreateOAuthUser({
            provider: PROVIDER,
            providerAccountId: ACCOUNT_ID,
            email: 'newbie@example.com',
            nameHint: longName,
        });
        expect(mockUserCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ nickname: 'x'.repeat(64) }),
            }),
        );
    });

    it('Branch 4 rollback: provision failure deletes the portal user + cleans new-api orphan', async () => {
        const NEW_USER_ID = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
        mockOAuthFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue(null);
        mockUserCreate.mockResolvedValue({ id: NEW_USER_ID });
        mockProvision.mockRejectedValue(new Error('new-api 500'));
        mockSearchUser.mockResolvedValue({ items: [] }); // no orphan
        mockUserDelete.mockResolvedValue({});

        const result = await linkOrCreateOAuthUser({
            provider: PROVIDER,
            providerAccountId: ACCOUNT_ID,
            email: 'unlucky@example.com',
        });

        expect(result).toEqual({ ok: false, error: 'provisioning_failed' });
        expect(mockUserDelete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: NEW_USER_ID } }));
    });

    it('Branch 4 rollback: linkage transaction failure → deletes new-api user AND portal user', async () => {
        const NEW_USER_ID = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
        mockOAuthFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue(null);
        mockUserCreate.mockResolvedValue({ id: NEW_USER_ID });
        mockProvision.mockResolvedValue({
            newapi_user_id: 99,
            newapi_username: `c-${NEW_USER_ID.slice(0, 8)}`,
            newapi_access_token: 'access-token-xxx',
            newapi_token_id: 3,
            newapi_token_value: 'sk-real-key',
        });
        // Force the linkage transaction to fail
        mockTransaction.mockRejectedValueOnce(new Error('DB transient'));
        mockDeleteUser.mockResolvedValue({});
        mockUserDelete.mockResolvedValue({});

        const result = await linkOrCreateOAuthUser({
            provider: PROVIDER,
            providerAccountId: ACCOUNT_ID,
            email: 'cascade@example.com',
        });

        expect(result).toEqual({ ok: false, error: 'provisioning_failed' });
        expect(mockDeleteUser).toHaveBeenCalledWith(99); // new-api side
        expect(mockUserDelete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: NEW_USER_ID } }));
    });

    it('Branch 5 (link conflict): oauth_account.create throws → link_conflict', async () => {
        mockOAuthFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            status: 'active',
            email_verified: true,
        });
        mockOAuthCreate.mockRejectedValue(new Error('P2002 unique constraint'));

        const result = await linkOrCreateOAuthUser({
            provider: PROVIDER,
            providerAccountId: ACCOUNT_ID,
            email: EMAIL,
        });

        expect(result).toEqual({ ok: false, error: 'link_conflict' });
    });

    it('Banned-by-email: branch 2/3 entry refuses to log in disabled accounts', async () => {
        mockOAuthFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            status: 'banned',
            email_verified: true,
        });

        const result = await linkOrCreateOAuthUser({
            provider: PROVIDER,
            providerAccountId: ACCOUNT_ID,
            email: EMAIL,
        });

        expect(result).toEqual({ ok: false, error: 'account_disabled' });
        expect(mockOAuthCreate).not.toHaveBeenCalled();
    });
});
