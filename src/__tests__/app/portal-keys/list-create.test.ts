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

// P3: POST resolves 档次 → new-api group via listEnabledChannelGroups.
const mockListEnabledChannelGroups = vi.fn();
vi.mock('@/lib/channel-group', () => ({
    listEnabledChannelGroups: (...args: unknown[]) => mockListEnabledChannelGroups(...args),
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
    // P3 default: tenant has pool (default) + official tiers.
    mockListEnabledChannelGroups.mockResolvedValue([
        { key: 'pool', newapi_group: 'default', is_default: true },
        { key: 'official', newapi_group: 'official', is_default: false },
    ]);
});

describe('GET /api/portal/keys', () => {
    it('401 invalid_credentials when no session', async () => {
        mockGetCurrentUser.mockResolvedValue(null);

        const res = await GET(makeReq({ method: 'GET' }));
        expect(res.status).toBe(401);
        expect((await res.json()).error).toBe('invalid_credentials');
        expect(mockTokenFindMany).not.toHaveBeenCalled();
    });

    it('200 + masked tokens for current user only (where: status=active scopes server-side) with W6 D4 usage cache fields', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindMany.mockResolvedValue([
            {
                id: 'tok-1',
                key_alias: 'production',
                newapi_token_value: 'sk-1234567abcdefgh1234567xxxxYYYY',
                created_at: new Date('2026-05-01T10:00:00Z'),
                cached_used_quota: BigInt(150_000),
                cached_used_at: new Date('2026-05-04T08:00:00Z'),
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
            // W6 D4: BigInt serialized as string for client-side precision safety
            cached_used_quota: '150000',
            cached_used_at: '2026-05-04T08:00:00.000Z',
        });
        // Critical: never leaks newapi_token_value or other internal fields
        expect(JSON.stringify(body)).not.toContain('sk-1234567abcdefgh');
        // Query scoped to (user_id, status='active'); PR-T1 Phase 0e
        // also defensively excludes the reserved `portal-internal` alias.
        expect(mockTokenFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    user_id: PORTAL_USER_ID,
                    status: 'active',
                    key_alias: { not: 'portal-internal' },
                },
            }),
        );
    });

    it('200 W6 D4: cached_used_at null serializes to null (token never synced)', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindMany.mockResolvedValue([
            {
                id: 'tok-fresh',
                key_alias: 'just-created',
                newapi_token_value: 'sk-aaaa****bbbb-padding-1234567890',
                created_at: new Date('2026-05-05T10:00:00Z'),
                cached_used_quota: BigInt(0),
                cached_used_at: null,
            },
        ]);

        const res = await GET(makeReq({ method: 'GET' }));
        const body = await res.json();
        expect(body.tokens[0].cached_used_quota).toBe('0');
        expect(body.tokens[0].cached_used_at).toBeNull();
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

        const res = await POST(makeReq({ method: 'POST', body: { alias: 'a'.repeat(51) } }));
        expect(res.status).toBe(400);
    });

    it('400 token_limit_reached when user already has MAX_TOKENS_PER_USER (10) active', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenCount.mockResolvedValue(MAX_TOKENS_PER_USER);

        const res = await POST(makeReq({ method: 'POST', body: { alias: 'prod' } }));
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe('token_limit_reached');
        expect(body.max).toBe(MAX_TOKENS_PER_USER);
        expect(MAX_TOKENS_PER_USER).toBe(10); // W6 D4 — bumped from 5
        expect(mockCreateTokenForCustomer).not.toHaveBeenCalled();
    });

    it('W6 D4: 6th-9th keys still proceed past the count check (was blocked under W4-2 D5 cap of 5)', async () => {
        // count=9 is below the W6 D4 cap of 10 → request should proceed
        // through to the new-api flow (which we mock as success).
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenCount.mockResolvedValue(9);
        mockCreateTokenForCustomer.mockResolvedValue(undefined);
        mockListTokensForCustomer.mockResolvedValue({
            items: [{ id: 100, name: 'tenth-key' }],
            total: 1,
        });
        mockGetTokenKey.mockResolvedValue('sk-tenth-mint-1234');
        mockTokenCreate.mockResolvedValue({
            id: 'tok-tenth',
            key_alias: 'tenth-key',
            created_at: new Date('2026-05-05T10:00:00Z'),
        });

        const res = await POST(makeReq({ method: 'POST', body: { alias: 'tenth-key' } }));
        expect(res.status).toBe(200);
        expect(mockCreateTokenForCustomer).toHaveBeenCalled();
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
            tier: 'pool',
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
        expect(mockGetTokenKey).toHaveBeenCalledWith({ accessToken: NEWAPI_ACCESS_TOKEN, userId: NEWAPI_USER_ID }, 42);
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
            tier: 'pool',
            key: 'sk-NEWLY-MINTED-FULL-VALUE-xxxx',
            created_at: '2026-05-04T10:00:00.000Z',
        });
    });

    it('W7 D4 PR-H: prefix-adds sk- when getTokenKey returns the bare 48-char id', async () => {
        // Stage 1 PR-H diagnosis: live new-api returns the raw 48-char
        // value (no `sk-` prefix) from POST /api/token/{id}/key. Portal
        // stores it raw + must prepend the prefix at the response
        // boundary so the customer's first paste lands a working
        // Authorization header.
        const RAW = 'Bc4UOPZdTYBS56MMFE1XrOXf5ILtXXXDPsWgqqgecvS5dezb';
        expect(RAW.length).toBe(48);
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenCount.mockResolvedValue(0);
        mockCreateTokenForCustomer.mockResolvedValue(undefined);
        mockListTokensForCustomer.mockResolvedValue({
            items: [{ id: 99, name: 'prod' }],
            total: 1,
        });
        mockGetTokenKey.mockResolvedValue(RAW);
        mockTokenCreate.mockResolvedValue({
            id: 'tok-new',
            key_alias: 'prod',
            created_at: new Date('2026-05-07T10:00:00.000Z'),
        });

        const res = await POST(makeReq({ method: 'POST', body: { alias: 'prod' } }));
        expect(res.status).toBe(200);
        const body = await res.json();
        // Prisma row keeps the bare 48-char value (mirrors new-api
        // canonical storage) — DB stays clean
        expect(mockTokenCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ newapi_token_value: RAW }),
            }),
        );
        // Response carries the prefixed wire-format value (51 chars)
        expect(body.key).toBe(`sk-${RAW}`);
        expect((body.key as string).length).toBe(51);
        expect((body.key as string).startsWith('sk-')).toBe(true);
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
