/**
 * PATCH /api/portal/keys/[id] — rename a key's alias.
 *
 * Mirrors delete-reveal.test.ts: cookie auth + IDOR + revoked + new-api
 * failure ordering (new-api first, Prisma only on success).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

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

const mockNewapiDeleteToken = vi.fn();
const mockNewapiRenameToken = vi.fn();
const mockNewapiUpdateToken = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    deleteToken: (...args: unknown[]) => mockNewapiDeleteToken(...args),
    renameToken: (...args: unknown[]) => mockNewapiRenameToken(...args),
    updateTokenForCustomer: (...args: unknown[]) => mockNewapiUpdateToken(...args),
}));
import { cnyToQuota } from '@/lib/newapi/quota-units';

import { PATCH } from '@/app/api/portal/keys/[id]/route';

const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_USER_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const NEWAPI_USER_ID = 7;
const NEWAPI_ACCESS_TOKEN = 'access-token-32chars';
const SESSION_USER = {
    id: PORTAL_USER_ID,
    email: 'happy@silkroadai.io',
    newapi_user_id: NEWAPI_USER_ID,
    newapi_access_token: NEWAPI_ACCESS_TOKEN,
};
const TOKEN_ID = 'tok-aaaa';
const ACTIVE_TOKEN = {
    id: TOKEN_ID,
    user_id: PORTAL_USER_ID,
    newapi_token_id: 99,
    status: 'active',
    key_alias: 'old-name',
};

function makeReq(body: unknown, raw = false): NextRequest {
    return new NextRequest(`http://localhost/api/portal/keys/${TOKEN_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: raw ? (body as string) : JSON.stringify(body),
    });
}
const params = Promise.resolve({ id: TOKEN_ID });

beforeEach(() => {
    vi.clearAllMocks();
    mockTokenUpdate.mockResolvedValue({});
    mockNewapiRenameToken.mockResolvedValue(undefined);
    mockNewapiUpdateToken.mockResolvedValue(undefined);
});

describe('PATCH /api/portal/keys/[id]', () => {
    it('401 when no session', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        const res = await PATCH(makeReq({ alias: 'x' }), { params });
        expect(res.status).toBe(401);
        expect(mockNewapiRenameToken).not.toHaveBeenCalled();
        expect(mockTokenUpdate).not.toHaveBeenCalled();
    });

    it('400 invalid_json on a non-JSON body', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        const res = await PATCH(makeReq('not json', true), { params });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('invalid_json');
        expect(mockTokenFindUnique).not.toHaveBeenCalled();
    });

    it.each([
        ['empty', { alias: '' }],
        ['whitespace only', { alias: '   ' }],
        ['over 50 chars', { alias: 'a'.repeat(51) }],
        ['reserved portal-internal prefix', { alias: 'portal-internal-official' }],
        ['missing alias', {}],
    ])('400 validation_error when alias is %s', async (_label, body) => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        const res = await PATCH(makeReq(body), { params });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('validation_error');
        expect(mockTokenFindUnique).not.toHaveBeenCalled();
        expect(mockNewapiRenameToken).not.toHaveBeenCalled();
    });

    it('404 not_found when token does not exist', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue(null);
        const res = await PATCH(makeReq({ alias: 'new-name' }), { params });
        expect(res.status).toBe(404);
        expect(mockNewapiRenameToken).not.toHaveBeenCalled();
    });

    it('401 (not 403) when token belongs to a different user — IDOR defense', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue({ ...ACTIVE_TOKEN, user_id: OTHER_USER_ID });
        const res = await PATCH(makeReq({ alias: 'new-name' }), { params });
        expect(res.status).toBe(401);
        expect((await res.json()).error).toBe('invalid_credentials');
        expect(mockNewapiRenameToken).not.toHaveBeenCalled();
        expect(mockTokenUpdate).not.toHaveBeenCalled();
    });

    it('410 token_revoked when status is disabled', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue({ ...ACTIVE_TOKEN, status: 'disabled' });
        const res = await PATCH(makeReq({ alias: 'new-name' }), { params });
        expect(res.status).toBe(410);
        expect((await res.json()).error).toBe('token_revoked');
        expect(mockNewapiRenameToken).not.toHaveBeenCalled();
    });

    it('no-op when alias is unchanged: 200 without touching new-api or Prisma', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue(ACTIVE_TOKEN);
        const res = await PATCH(makeReq({ alias: '  old-name ' }), { params });
        expect(res.status).toBe(200);
        expect((await res.json()).key_alias).toBe('old-name');
        expect(mockNewapiRenameToken).not.toHaveBeenCalled();
        expect(mockTokenUpdate).not.toHaveBeenCalled();
    });

    it('happy: renames on new-api first, then updates Prisma key_alias (trimmed)', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue(ACTIVE_TOKEN);

        const res = await PATCH(makeReq({ alias: '  prod-claude  ' }), { params });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ ok: true, key_alias: 'prod-claude' });
        expect(mockNewapiRenameToken).toHaveBeenCalledWith(
            { accessToken: NEWAPI_ACCESS_TOKEN, userId: NEWAPI_USER_ID },
            99,
            'prod-claude',
        );
        expect(mockTokenUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: TOKEN_ID }, data: { key_alias: 'prod-claude' } }),
        );
        // ordering: new-api before Prisma
        const renameOrder = mockNewapiRenameToken.mock.invocationCallOrder[0];
        const updateOrder = mockTokenUpdate.mock.invocationCallOrder[0];
        expect(renameOrder).toBeLessThan(updateOrder);
    });

    it('502 newapi_update_failed + Prisma untouched when new-api rename throws', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue(ACTIVE_TOKEN);
        mockNewapiRenameToken.mockRejectedValue(new Error('new-api 503'));

        const res = await PATCH(makeReq({ alias: 'prod-claude' }), { params });
        expect(res.status).toBe(502);
        expect((await res.json()).error).toBe('newapi_update_failed');
        expect(mockTokenUpdate).not.toHaveBeenCalled();
    });

    it('500 account_not_provisioned when the user has no new-api linkage', async () => {
        mockGetCurrentUser.mockResolvedValue({ ...SESSION_USER, newapi_access_token: null });
        const res = await PATCH(makeReq({ alias: 'prod-claude' }), { params });
        expect(res.status).toBe(500);
        expect((await res.json()).error).toBe('account_not_provisioned');
    });
});

describe('PATCH /api/portal/keys/[id] — 额度上限 / 到期时间(2026-10-22)', () => {
    const FUTURE = '2030-01-01T00:00:00.000Z';
    const CUSTOMER_AUTH = { accessToken: NEWAPI_ACCESS_TOKEN, userId: NEWAPI_USER_ID };

    beforeEach(() => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue(ACTIVE_TOKEN);
    });

    it('400 validation_error on an empty body (nothing to update)', async () => {
        const res = await PATCH(makeReq({}), { params });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('validation_error');
    });

    it.each([
        ['quotaCny 0', { quotaCny: 0 }],
        ['quotaCny negative', { quotaCny: -5 }],
        ['quotaCny 3 decimals', { quotaCny: 1.234 }],
        ['quotaCny over max', { quotaCny: 1_000_001 }],
        ['expiresAt in the past', { expiresAt: '2020-01-01T00:00:00.000Z' }],
        ['expiresAt garbage', { expiresAt: 'tomorrow-ish' }],
    ])('400 validation_error when %s', async (_label, body) => {
        const res = await PATCH(makeReq(body), { params });
        expect(res.status).toBe(400);
        expect(mockNewapiUpdateToken).not.toHaveBeenCalled();
        expect(mockNewapiRenameToken).not.toHaveBeenCalled();
    });

    it('set quota: full GET→PUT via updateTokenForCustomer with unlimited_quota=false + remain_quota=cnyToQuota(absolute)', async () => {
        const res = await PATCH(makeReq({ quotaCny: 100 }), { params });
        expect(res.status).toBe(200);
        expect(mockNewapiUpdateToken).toHaveBeenCalledWith(CUSTOMER_AUTH, 99, {
            unlimited_quota: false,
            remain_quota: cnyToQuota(100),
        });
        expect(mockNewapiRenameToken).not.toHaveBeenCalled();
        expect(mockTokenUpdate).not.toHaveBeenCalled(); // alias unchanged → Prisma untouched
        expect(await res.json()).toEqual({ ok: true, key_alias: 'old-name', quota_unlimited: false, remainCny: 100 });
    });

    it('cancel quota (null): only unlimited_quota=true, remain_quota NOT sent (new-api keeps stored value)', async () => {
        const res = await PATCH(makeReq({ quotaCny: null }), { params });
        expect(res.status).toBe(200);
        expect(mockNewapiUpdateToken).toHaveBeenCalledWith(CUSTOMER_AUTH, 99, { unlimited_quota: true });
        expect(await res.json()).toEqual({ ok: true, key_alias: 'old-name', quota_unlimited: true, remainCny: null });
    });

    it('set expiry: expired_time = floor(unix seconds); null → -1', async () => {
        await PATCH(makeReq({ expiresAt: FUTURE }), { params });
        expect(mockNewapiUpdateToken).toHaveBeenCalledWith(CUSTOMER_AUTH, 99, {
            expired_time: Math.floor(Date.parse(FUTURE) / 1000),
        });
        mockNewapiUpdateToken.mockClear();
        const res = await PATCH(makeReq({ expiresAt: null }), { params });
        expect(mockNewapiUpdateToken).toHaveBeenCalledWith(CUSTOMER_AUTH, 99, { expired_time: -1 });
        expect(await res.json()).toEqual({ ok: true, key_alias: 'old-name', expires_at: null });
    });

    it('alias + quota + expiry together → ONE PUT carrying name, then Prisma alias update', async () => {
        const res = await PATCH(makeReq({ alias: 'renamed', quotaCny: 25.5, expiresAt: FUTURE }), { params });
        expect(res.status).toBe(200);
        expect(mockNewapiUpdateToken).toHaveBeenCalledTimes(1);
        expect(mockNewapiUpdateToken).toHaveBeenCalledWith(CUSTOMER_AUTH, 99, {
            name: 'renamed',
            unlimited_quota: false,
            remain_quota: cnyToQuota(25.5),
            expired_time: Math.floor(Date.parse(FUTURE) / 1000),
        });
        expect(mockNewapiRenameToken).not.toHaveBeenCalled();
        expect(mockTokenUpdate).toHaveBeenCalledWith({ where: { id: TOKEN_ID }, data: { key_alias: 'renamed' } });
        expect(await res.json()).toEqual({
            ok: true,
            key_alias: 'renamed',
            quota_unlimited: false,
            remainCny: 25.5,
            expires_at: FUTURE,
        });
    });

    it('502 newapi_update_failed when the PUT fails; Prisma untouched', async () => {
        mockNewapiUpdateToken.mockRejectedValue(new Error('new-api 503'));
        const res = await PATCH(makeReq({ alias: 'renamed', quotaCny: 10 }), { params });
        expect(res.status).toBe(502);
        expect((await res.json()).error).toBe('newapi_update_failed');
        expect(mockTokenUpdate).not.toHaveBeenCalled();
    });

    it('IDOR / revoked guards still apply to budget updates', async () => {
        mockTokenFindUnique.mockResolvedValue({ ...ACTIVE_TOKEN, user_id: OTHER_USER_ID });
        expect((await PATCH(makeReq({ quotaCny: 10 }), { params })).status).toBe(401);
        mockTokenFindUnique.mockResolvedValue({ ...ACTIVE_TOKEN, status: 'disabled' });
        expect((await PATCH(makeReq({ quotaCny: 10 }), { params })).status).toBe(410);
        expect(mockNewapiUpdateToken).not.toHaveBeenCalled();
    });
});
