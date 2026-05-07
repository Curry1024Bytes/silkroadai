/**
 * W4-2 D5 — DELETE /api/portal/keys/[id] (revoke)
 *           GET    /api/portal/keys/[id]/key (reveal full sk)
 *
 * Both routes share the same auth + ownership pattern; tests cover
 * happy / not-found / IDOR (token belongs to another user) / new-api fail.
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
vi.mock('@/lib/newapi/client', () => ({
    deleteToken: (...args: unknown[]) => mockNewapiDeleteToken(...args),
}));

import { DELETE } from '@/app/api/portal/keys/[id]/route';
import { GET as GET_KEY } from '@/app/api/portal/keys/[id]/key/route';

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

function makeReq(): NextRequest {
    return new NextRequest(`http://localhost/api/portal/keys/${TOKEN_ID}`, {
        method: 'DELETE',
    });
}
const params = Promise.resolve({ id: TOKEN_ID });

beforeEach(() => {
    vi.clearAllMocks();
    mockTokenUpdate.mockResolvedValue({});
});

describe('DELETE /api/portal/keys/[id]', () => {
    it('401 when no session', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        const res = await DELETE(makeReq(), { params });
        expect(res.status).toBe(401);
        expect(mockNewapiDeleteToken).not.toHaveBeenCalled();
        expect(mockTokenUpdate).not.toHaveBeenCalled();
    });

    it('404 not_found when token does not exist', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue(null);

        const res = await DELETE(makeReq(), { params });
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe('not_found');
        expect(mockNewapiDeleteToken).not.toHaveBeenCalled();
    });

    it('401 (not 403) when token belongs to a different user — IDOR defense', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue({
            id: TOKEN_ID,
            user_id: OTHER_USER_ID, // different from session
            newapi_token_id: 99,
            status: 'active',
        });

        const res = await DELETE(makeReq(), { params });
        expect(res.status).toBe(401);
        // 401 (not 403/404) so attackers can't differentiate "exists but
        // not yours" from "doesn't exist"
        expect((await res.json()).error).toBe('invalid_credentials');
        expect(mockNewapiDeleteToken).not.toHaveBeenCalled();
        expect(mockTokenUpdate).not.toHaveBeenCalled();
    });

    it('idempotent: already-revoked token returns 200 ok=true,already=true without calling new-api', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue({
            id: TOKEN_ID,
            user_id: PORTAL_USER_ID,
            newapi_token_id: 99,
            status: 'disabled',
        });

        const res = await DELETE(makeReq(), { params });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.already).toBe(true);
        expect(mockNewapiDeleteToken).not.toHaveBeenCalled();
        expect(mockTokenUpdate).not.toHaveBeenCalled();
    });

    it('happy: revokes new-api side then flips Prisma status to disabled', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue({
            id: TOKEN_ID,
            user_id: PORTAL_USER_ID,
            newapi_token_id: 99,
            status: 'active',
        });
        mockNewapiDeleteToken.mockResolvedValue(undefined);

        const res = await DELETE(makeReq(), { params });
        expect(res.status).toBe(200);
        expect((await res.json()).ok).toBe(true);
        // new-api invoked first
        expect(mockNewapiDeleteToken).toHaveBeenCalledWith(
            { accessToken: NEWAPI_ACCESS_TOKEN, userId: NEWAPI_USER_ID },
            99,
        );
        // Prisma soft-delete (status flip, not row delete)
        expect(mockTokenUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: TOKEN_ID },
                data: { status: 'disabled' },
            }),
        );
    });

    it('502 + Prisma untouched when new-api delete throws', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue({
            id: TOKEN_ID,
            user_id: PORTAL_USER_ID,
            newapi_token_id: 99,
            status: 'active',
        });
        mockNewapiDeleteToken.mockRejectedValue(new Error('new-api 503'));

        const res = await DELETE(makeReq(), { params });
        expect(res.status).toBe(502);
        expect((await res.json()).error).toBe('newapi_delete_failed');
        // CRITICAL: Prisma stays at 'active' so the user can retry — they
        // shouldn't see the key disappear from UI but still work upstream
        expect(mockTokenUpdate).not.toHaveBeenCalled();
    });
});

describe('GET /api/portal/keys/[id]/key', () => {
    it('401 when no session', async () => {
        mockGetCurrentUser.mockResolvedValue(null);

        const res = await GET_KEY(
            new NextRequest(`http://localhost/api/portal/keys/${TOKEN_ID}/key`, { method: 'GET' }),
            { params },
        );
        expect(res.status).toBe(401);
    });

    it('404 when token not found', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue(null);

        const res = await GET_KEY(
            new NextRequest(`http://localhost/api/portal/keys/${TOKEN_ID}/key`, { method: 'GET' }),
            { params },
        );
        expect(res.status).toBe(404);
    });

    it('401 (IDOR) when token belongs to another user', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue({
            user_id: OTHER_USER_ID,
            newapi_token_value: 'sk-someone-elses-key',
            status: 'active',
        });

        const res = await GET_KEY(
            new NextRequest(`http://localhost/api/portal/keys/${TOKEN_ID}/key`, { method: 'GET' }),
            { params },
        );
        expect(res.status).toBe(401);
        // CRITICAL: never leak the key value
        const body = await res.json();
        expect(JSON.stringify(body)).not.toContain('sk-someone-elses-key');
    });

    it('410 token_revoked when status is disabled', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue({
            user_id: PORTAL_USER_ID,
            newapi_token_value: 'sk-revoked-no-show',
            status: 'disabled',
        });

        const res = await GET_KEY(
            new NextRequest(`http://localhost/api/portal/keys/${TOKEN_ID}/key`, { method: 'GET' }),
            { params },
        );
        expect(res.status).toBe(410);
        const body = await res.json();
        expect(body.error).toBe('token_revoked');
        expect(JSON.stringify(body)).not.toContain('sk-revoked-no-show');
    });

    it('happy: returns full sk- from Prisma (does NOT call new-api)', async () => {
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue({
            user_id: PORTAL_USER_ID,
            newapi_token_value: 'sk-FULL-VALUE-XYZ',
            status: 'active',
        });

        const res = await GET_KEY(
            new NextRequest(`http://localhost/api/portal/keys/${TOKEN_ID}/key`, { method: 'GET' }),
            { params },
        );
        expect(res.status).toBe(200);
        expect((await res.json()).key).toBe('sk-FULL-VALUE-XYZ');
        // CRITICAL: this endpoint must NOT touch new-api
        // (POST /api/token/{id}/key has potentially-rotating semantics
        //  on some upstream variants — see W2 D6 / gotcha #11)
        expect(mockNewapiDeleteToken).not.toHaveBeenCalled();
    });

    it('W7 D4 PR-H: prefix-adds sk- when DB stores the bare 48-char id', async () => {
        // This is the prod-state shape — Stage 1 PR-H diagnosis
        // confirmed live new-api stores values without the `sk-` prefix
        // (length=48 raw). Reveal endpoint must prepend the prefix at
        // the response boundary so customers paste a working
        // Authorization header.
        const RAW = 'Bc4UOPZdTYBS56MMFE1XrOXf5ILtXXXDPsWgqqgecvS5dezb';
        expect(RAW.length).toBe(48);
        mockGetCurrentUser.mockResolvedValue(SESSION_USER);
        mockTokenFindUnique.mockResolvedValue({
            user_id: PORTAL_USER_ID,
            newapi_token_value: RAW,
            status: 'active',
        });

        const res = await GET_KEY(
            new NextRequest(`http://localhost/api/portal/keys/${TOKEN_ID}/key`, { method: 'GET' }),
            { params },
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        // Prefix MUST be added; 51-char total
        expect(body.key).toBe(`sk-${RAW}`);
        expect((body.key as string).length).toBe(51);
        expect((body.key as string).startsWith('sk-')).toBe(true);
    });
});
