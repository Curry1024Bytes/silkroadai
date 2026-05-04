/**
 * W4-2 D5 — GET + POST /api/portal/keys
 *
 * GET: list current user's active keys, mask sk- in payload
 * POST: 3-step new-api flow + Prisma persist + ONE-TIME full sk- in response
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockTokenFindMany = vi.fn();
const mockTokenCount = vi.fn();
const mockTokenCreate = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        newApiToken: {
            findMany: (...args: unknown[]) => mockTokenFindMany(...args),
            count: (...args: unknown[]) => mockTokenCount(...args),
            create: (...args: unknown[]) => mockTokenCreate(...args),
        },
    },
}));

const mockCreateTokenForCustomer = vi.fn();
const mockListTokensForCustomer = vi.fn();
const mockGetTokenKey = vi.fn();
const mockNewapiDeleteToken = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    createTokenForCustomer: (...args: unknown[]) => mockCreateTokenForCustomer(...args),
    listTokensForCustomer: (...args: unknown[]) => mockListTokensForCustomer(...args),
    getTokenKey: (...args: unknown[]) => mockGetTokenKey(...args),
    deleteToken: (...args: unknown[]) => mockNewapiDeleteToken(...args),
}));

import { GET, POST, MAX_TOKENS_PER_USER } from '@/app/api/portal/keys/route';

const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NEWAPI_USER_ID = 7;
const NEWAPI_ACCESS_TOKEN = 'access-token-32chars';
const SESSION_USER = {
    id: PORTAL_USER_ID,
    email: 'happy@silkroadai.io',
    newapi_user_id: NEWAPI_USER_ID,
    newapi_access_token: NEWAPI_ACCESS_TOKEN,
};

function makeReq(opts: { method: string; body?: unknown } = { method: 'GET' }): NextRequest {
    return new NextRequest('http://localhost/api/portal/keys', {
        method: opts.method,
        ...(opts.body !== undefined && {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(opts.body),
        }),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('GET /api/portal/keys', () => {
    it('401 invalid_credentials when no session', async () => {
        mockGetCurrentUser.mockResolvedValue(null);

        const res = await GET(makeReq({ method: 'GET' }));
        expect(res.status).toBe(401);
        expect((await res.json()).error).toBe('invalid_credentials');
        expect(mockTokenFindMany).not.toHaveBeenCalled();
    });

    it('200 + masked tokens for current user only (where: status=active scopes server-side)', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindMany.mockResolvedValue([
            {
                id: 'tok-1',
                key_alias: 'production',
                newapi_token_value: 'sk-1234567abcdefgh1234567xxxxYYYY',
                created_at: new Date('2026-05-01T10:00:00Z'),
            },
        ]);

        const res = await GET(makeReq({ method: 'GET' }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.tokens).toHaveLength(1);
        expect(body.tokens[0]).toEqual({
            id: 'tok-1',
            key_alias: 'production',
            masked_key: 'sk-1234****YYYY',
            created_at: '2026-05-01T10:00:00.000Z',
        });
        // Critical: never leaks newapi_token_value or other internal fields
        expect(JSON.stringify(body)).not.toContain('sk-1234567abcdefgh');
        // Query scoped to (user_id, status='active')
        expect(mockTokenFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { user_id: PORTAL_USER_ID, status: 'active' },
            }),
        );
    });

    it('200 + empty list when user has no active keys', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindMany.mockResolvedValue([]);

        const res = await GET(makeReq({ method: 'GET' }));
        expect(res.status).toBe(200);
        expect((await res.json()).tokens).toEqual([]);
    });
});

describe('POST /api/portal/keys', () => {
    it('401 when no session', async () => {
        mockGetCurrentUser.mockResolvedValue(null);

        const res = await POST(makeReq({ method: 'POST', body: { alias: 'prod' } }));
        expect(res.status).toBe(401);
        expect(mockCreateTokenForCustomer).not.toHaveBeenCalled();
    });

    it('400 invalid_input when alias missing / empty', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);

        const res = await POST(makeReq({ method: 'POST', body: { alias: '' } }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('invalid_input');
        expect(mockCreateTokenForCustomer).not.toHaveBeenCalled();
    });

    it('400 invalid_input when alias > 50 chars', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);

        const res = await POST(
            makeReq({ method: 'POST', body: { alias: 'a'.repeat(51) } }),
        );
        expect(res.status).toBe(400);
    });

    it('400 token_limit_reached when user already has MAX_TOKENS_PER_USER active', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenCount.mockResolvedValue(MAX_TOKENS_PER_USER);

        const res = await POST(makeReq({ method: 'POST', body: { alias: 'prod' } }));
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe('token_limit_reached');
        expect(body.max).toBe(MAX_TOKENS_PER_USER);
        expect(mockCreateTokenForCustomer).not.toHaveBeenCalled();
    });

    it('happy: creates new-api token + returns full sk- ONCE in response', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenCount.mockResolvedValue(0);
        mockCreateTokenForCustomer.mockResolvedValue(undefined);
        mockListTokensForCustomer.mockResolvedValue({
            items: [
                { id: 42, name: 'prod' },
                { id: 7, name: 'other-key' },
            ],
            total: 2,
        });
        mockGetTokenKey.mockResolvedValue('sk-NEWLY-MINTED-FULL-VALUE-xxxx');
        mockTokenCreate.mockResolvedValue({
            id: 'tok-new',
            key_alias: 'prod',
            created_at: new Date('2026-05-04T10:00:00Z'),
        });

        const res = await POST(makeReq({ method: 'POST', body: { alias: 'prod' } }));
        expect(res.status).toBe(200);
        const body = await res.json();
        // New-api flow shape
        expect(mockCreateTokenForCustomer).toHaveBeenCalledWith(
            { accessToken: NEWAPI_ACCESS_TOKEN, userId: NEWAPI_USER_ID },
            expect.objectContaining({
                name: 'prod',
                unlimited_quota: true, // gotcha #12
                expired_time: -1,
            }),
        );
        expect(mockGetTokenKey).toHaveBeenCalledWith(
            { accessToken: NEWAPI_ACCESS_TOKEN, userId: NEWAPI_USER_ID },
            42,
        );
        // Prisma row created with the right shape
        expect(mockTokenCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    user_id: PORTAL_USER_ID,
                    newapi_token_id: 42,
                    newapi_token_value: 'sk-NEWLY-MINTED-FULL-VALUE-xxxx',
                    key_alias: 'prod',
                    status: 'active',
                }),
            }),
        );
        // Response includes the FULL key (one-time reveal)
        expect(body).toEqual({
            id: 'tok-new',
            key_alias: 'prod',
            key: 'sk-NEWLY-MINTED-FULL-VALUE-xxxx',
            created_at: '2026-05-04T10:00:00.000Z',
        });
    });

    it('502 newapi_create_failed + Prisma row NOT written when createTokenForCustomer throws', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenCount.mockResolvedValue(0);
        mockCreateTokenForCustomer.mockRejectedValue(new Error('new-api 503'));
        // Cleanup pass also runs — nothing to find since create itself failed
        mockListTokensForCustomer.mockResolvedValue({ items: [], total: 0 });

        const res = await POST(makeReq({ method: 'POST', body: { alias: 'prod' } }));
        expect(res.status).toBe(502);
        expect((await res.json()).error).toBe('newapi_create_failed');
        // CRITICAL: no orphan Prisma row when new-api flow fails
        expect(mockTokenCreate).not.toHaveBeenCalled();
    });

    it('500 + new-api rollback when Prisma create fails after new-api succeeds', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenCount.mockResolvedValue(0);
        mockCreateTokenForCustomer.mockResolvedValue(undefined);
        mockListTokensForCustomer.mockResolvedValue({
            items: [{ id: 99, name: 'prod' }],
            total: 1,
        });
        mockGetTokenKey.mockResolvedValue('sk-orphan-xxxx');
        mockTokenCreate.mockRejectedValue(new Error('DB transient'));
        mockNewapiDeleteToken.mockResolvedValue(undefined);

        const res = await POST(makeReq({ method: 'POST', body: { alias: 'prod' } }));
        expect(res.status).toBe(500);
        // new-api side cleaned up (no orphan token left upstream)
        expect(mockNewapiDeleteToken).toHaveBeenCalledWith(
            { accessToken: NEWAPI_ACCESS_TOKEN, userId: NEWAPI_USER_ID },
            99,
        );
    });

    it('500 account_not_provisioned when user has no newapi_user_id (legacy / un-provisioned account)', async () => {
        mockGetCurrentUser.mockResolvedValue({ ...SESSION_USER, newapi_user_id: null });

        const res = await POST(makeReq({ method: 'POST', body: { alias: 'prod' } }));
        expect(res.status).toBe(500);
        expect((await res.json()).error).toBe('account_not_provisioned');
        expect(mockCreateTokenForCustomer).not.toHaveBeenCalled();
    });
});
