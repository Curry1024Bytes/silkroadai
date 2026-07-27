import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

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

// ── google OIDC helper mock ──
// vi.mock is hoisted above all other code, so the factory must declare its
// own GoogleOAuthError class — referencing a module-scoped class would hit
// the TDZ. We then `await import(...)` it after the hoist completes so tests
// can construct the same class for `mockRejectedValue`.
const mockExchange = vi.fn();
const mockVerify = vi.fn();
vi.mock('@/lib/auth/oauth/google', () => {
    class GoogleOAuthError extends Error {
        constructor(
            public code: string,
            message: string,
        ) {
            super(message);
            this.name = 'GoogleOAuthError';
        }
    }
    return {
        exchangeCodeForTokens: (...args: unknown[]) => mockExchange(...args),
        verifyGoogleIdToken: (...args: unknown[]) => mockVerify(...args),
        GoogleOAuthError,
    };
});

// ── new-api client mock ──
const mockProvision = vi.fn();
const mockSearchUser = vi.fn();
const mockDeleteUser = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    provisionNewCustomer: (...args: unknown[]) => mockProvision(...args),
    searchUser: (...args: unknown[]) => mockSearchUser(...args),
    deleteUser: (...args: unknown[]) => mockDeleteUser(...args),
}));

// session.ts uses real signSession; .env from vitest setup provides
// PORTAL_JWT_SECRET. To avoid signSession's own DB read for token version,
// we make user.findUnique return { session_token_version: 1 } when called
// with `where: { id }` (signSession's shape).

import { GET } from '../route';
import { GoogleOAuthError } from '@/lib/auth/oauth/google';

const ORIG_ENV = { ...process.env };
const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const GOOGLE_SUB = '111122223333444455556';

function makeReq(opts: { query?: Record<string, string>; cookies?: Record<string, string> }): NextRequest {
    const url = new URL('http://localhost/api/auth/oauth/google/callback');
    for (const [k, v] of Object.entries(opts.query ?? {})) {
        url.searchParams.set(k, v);
    }
    const cookieHeader = Object.entries(opts.cookies ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    return new NextRequest(url, {
        method: 'GET',
        headers: cookieHeader ? { cookie: cookieHeader } : {},
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIG_ENV };
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid.apps.googleusercontent.com';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'csecret';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3002/api/auth/oauth/google/callback';
    // Ensure tests run against the request.url-based fallback path. The
    // dedicated "redirect base env precedence" test sets these explicitly.
    // Local .env may have them set to a prod URL; clear here.
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;

    mockTransaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
    // last_login_at update + signSession DB read default
    mockUserUpdate.mockResolvedValue({});
});

afterEach(() => {
    process.env = ORIG_ENV;
});

function happyClaims(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        sub: GOOGLE_SUB,
        email: 'happy@example.com',
        email_verified: true,
        iss: 'https://accounts.google.com',
        aud: 'cid.apps.googleusercontent.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        name: 'Happy',
        ...overrides,
    };
}

describe('GET /api/auth/oauth/google/callback', () => {
    it('redirects with state_mismatch when cookie missing', async () => {
        const res = await GET(makeReq({ query: { code: 'authcode', state: 'qstate' } /* no cookies */ }));
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('oauth_error=state_mismatch');
        // cookies cleared
        const cookies = res.headers.getSetCookie();
        expect(cookies.some((c) => c.startsWith('oauth_google_state=;') || c.startsWith('oauth_google_state=; '))).toBe(
            true,
        );
        // never reached token exchange
        expect(mockExchange).not.toHaveBeenCalled();
    });

    it('redirects with state_mismatch when cookie state ≠ query state', async () => {
        const res = await GET(
            makeReq({
                query: { code: 'authcode', state: 'qstate' },
                cookies: { oauth_google_state: 'cookie-state', oauth_google_pkce: 'verifier' },
            }),
        );
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('oauth_error=state_mismatch');
        expect(mockExchange).not.toHaveBeenCalled();
    });

    it('redirects with google_denied when Google sent ?error=', async () => {
        const res = await GET(
            makeReq({
                query: { error: 'access_denied' },
                cookies: { oauth_google_state: 's', oauth_google_pkce: 'v' },
            }),
        );
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('oauth_error=google_denied');
        expect(mockExchange).not.toHaveBeenCalled();
    });

    it('surfaces GoogleOAuthError code from id_token verification', async () => {
        mockExchange.mockResolvedValue({
            id_token: 'idtoken',
            access_token: 'a',
            expires_in: 3600,
            scope: '',
            token_type: 'Bearer',
        });
        mockVerify.mockRejectedValue(
            new GoogleOAuthError('email_not_verified', 'Google says this email is not verified'),
        );

        const res = await GET(
            makeReq({
                query: { code: 'authcode', state: 'good' },
                cookies: { oauth_google_state: 'good', oauth_google_pkce: 'verifier' },
            }),
        );
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('oauth_error=email_not_verified');
    });

    it('Branch 1 (existing oauth_account): logs user in, sets session cookie', async () => {
        mockExchange.mockResolvedValue({
            id_token: 'idtoken',
            access_token: 'a',
            expires_in: 3600,
            scope: '',
            token_type: 'Bearer',
        });
        mockVerify.mockResolvedValue(happyClaims());
        mockOAuthFindUnique.mockResolvedValue({
            user: { id: PORTAL_USER_ID, status: 'active', email: 'happy@example.com' },
        });
        // signSession needs session_token_version
        mockUserFindUnique.mockResolvedValue({ session_token_version: 1 });

        const res = await GET(
            makeReq({
                query: { code: 'authcode', state: 'good' },
                cookies: { oauth_google_state: 'good', oauth_google_pkce: 'verifier' },
            }),
        );

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('http://localhost/dashboard');
        // session cookie set + oauth cookies cleared
        const cookies = res.headers.getSetCookie();
        expect(cookies.some((c) => c.startsWith('silkroad_session='))).toBe(true);
        // no provision, no user.create, no oauth.create — just login
        expect(mockProvision).not.toHaveBeenCalled();
        expect(mockUserCreate).not.toHaveBeenCalled();
        expect(mockOAuthCreate).not.toHaveBeenCalled();
    });

    it('Branch 2 (link-verified): existing user with email_verified=true → silent link, no email flag write', async () => {
        mockExchange.mockResolvedValue({
            id_token: 'idtoken',
            access_token: 'a',
            expires_in: 3600,
            scope: '',
            token_type: 'Bearer',
        });
        mockVerify.mockResolvedValue(happyClaims());
        mockOAuthFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockImplementation((args: { where: { email?: string; id?: string }; select?: unknown }) => {
            if (args.where.email === 'happy@example.com') {
                return Promise.resolve({ id: PORTAL_USER_ID, status: 'active', email_verified: true });
            }
            // signSession's own lookup
            return Promise.resolve({ session_token_version: 1 });
        });
        mockOAuthCreate.mockResolvedValue({ id: 'oauth-row-1' });

        const res = await GET(
            makeReq({
                query: { code: 'authcode', state: 'good' },
                cookies: { oauth_google_state: 'good', oauth_google_pkce: 'verifier' },
            }),
        );

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('http://localhost/dashboard');
        // oauth_account row created with the right (provider, sub, user)
        expect(mockOAuthCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    user_id: PORTAL_USER_ID,
                    provider: 'google',
                    provider_account_id: GOOGLE_SUB,
                }),
            }),
        );
        // No transaction — single create only
        expect(mockTransaction).not.toHaveBeenCalled();
        // No bootstrap — email already verified
        expect(mockUserUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ email_verified: true }) }),
        );
    });

    it('Branch 3 (bootstrap-unverified): existing user with email_verified=false → flips email_verified + links in one transaction', async () => {
        mockExchange.mockResolvedValue({
            id_token: 'idtoken',
            access_token: 'a',
            expires_in: 3600,
            scope: '',
            token_type: 'Bearer',
        });
        mockVerify.mockResolvedValue(happyClaims());
        mockOAuthFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockImplementation((args: { where: { email?: string; id?: string } }) => {
            if (args.where.email === 'happy@example.com') {
                return Promise.resolve({ id: PORTAL_USER_ID, status: 'active', email_verified: false });
            }
            return Promise.resolve({ session_token_version: 1 });
        });

        const res = await GET(
            makeReq({
                query: { code: 'authcode', state: 'good' },
                cookies: { oauth_google_state: 'good', oauth_google_pkce: 'verifier' },
            }),
        );

        expect(res.status).toBe(302);
        // Both user-update AND oauth-create called inside the transaction
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
                    provider: 'google',
                    provider_account_id: GOOGLE_SUB,
                }),
            }),
        );
    });

    it('Branch 4 (fresh signup): no existing user → create user (verified, no password) + provision + link', async () => {
        const NEW_USER_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
        mockExchange.mockResolvedValue({
            id_token: 'idtoken',
            access_token: 'a',
            expires_in: 3600,
            scope: '',
            token_type: 'Bearer',
        });
        mockVerify.mockResolvedValue(happyClaims({ email: 'newbie@example.com' }));
        mockOAuthFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockImplementation((args: { where: { email?: string; id?: string } }) => {
            if (args.where.email === 'newbie@example.com') return Promise.resolve(null);
            // signSession id-lookup
            return Promise.resolve({ session_token_version: 1 });
        });
        mockUserCreate.mockResolvedValue({ id: NEW_USER_ID });
        mockProvision.mockResolvedValue({
            newapi_user_id: 42,
            newapi_username: `c-${NEW_USER_ID.slice(0, 8)}`,
            newapi_access_token: 'access-token-xxx',
            newapi_token_id: 7,
            newapi_token_value: 'sk-real-key',
        });

        const res = await GET(
            makeReq({
                query: { code: 'authcode', state: 'good' },
                cookies: { oauth_google_state: 'good', oauth_google_pkce: 'verifier' },
            }),
        );

        expect(res.status).toBe(302);
        // user created with password_hash=null + email_verified=true + nested oauth link
        expect(mockUserCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    email: 'newbie@example.com',
                    password_hash: null,
                    email_verified: true,
                    oauth_accounts: {
                        create: expect.objectContaining({
                            provider: 'google',
                            provider_account_id: GOOGLE_SUB,
                        }),
                    },
                }),
            }),
        );
        // new-api provision invoked with correct args
        expect(mockProvision).toHaveBeenCalledWith(
            expect.objectContaining({
                portal_user_id: NEW_USER_ID,
                email: 'newbie@example.com',
                initial_quota: 0,
            }),
        );
        // session cookie set
        expect(res.headers.getSetCookie().some((c) => c.startsWith('silkroad_session='))).toBe(true);
    });

    it('Branch 4 rollback: provision failure deletes the portal user + cleans new-api orphan', async () => {
        const NEW_USER_ID = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
        mockExchange.mockResolvedValue({
            id_token: 'idtoken',
            access_token: 'a',
            expires_in: 3600,
            scope: '',
            token_type: 'Bearer',
        });
        mockVerify.mockResolvedValue(happyClaims({ email: 'unlucky@example.com' }));
        mockOAuthFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue(null);
        mockUserCreate.mockResolvedValue({ id: NEW_USER_ID });
        mockProvision.mockRejectedValue(new Error('new-api 500'));
        mockSearchUser.mockResolvedValue({ items: [] }); // no orphan to clean
        mockUserDelete.mockResolvedValue({});

        const res = await GET(
            makeReq({
                query: { code: 'authcode', state: 'good' },
                cookies: { oauth_google_state: 'good', oauth_google_pkce: 'verifier' },
            }),
        );

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('oauth_error=provisioning_failed');
        // portal user rolled back
        expect(mockUserDelete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: NEW_USER_ID } }));
    });

    it('Branch 5 (link conflict): when oauth_account.create throws (e.g. sub already linked elsewhere), redirects with link_conflict', async () => {
        mockExchange.mockResolvedValue({
            id_token: 'idtoken',
            access_token: 'a',
            expires_in: 3600,
            scope: '',
            token_type: 'Bearer',
        });
        mockVerify.mockResolvedValue(happyClaims());
        mockOAuthFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue({ id: PORTAL_USER_ID, status: 'active', email_verified: true });
        mockOAuthCreate.mockRejectedValue(new Error('P2002 unique constraint'));

        const res = await GET(
            makeReq({
                query: { code: 'authcode', state: 'good' },
                cookies: { oauth_google_state: 'good', oauth_google_pkce: 'verifier' },
            }),
        );

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('oauth_error=link_conflict');
    });

    it('refuses to log in disabled (banned) accounts even on existing oauth link', async () => {
        mockExchange.mockResolvedValue({
            id_token: 'idtoken',
            access_token: 'a',
            expires_in: 3600,
            scope: '',
            token_type: 'Bearer',
        });
        mockVerify.mockResolvedValue(happyClaims());
        mockOAuthFindUnique.mockResolvedValue({
            user: { id: PORTAL_USER_ID, status: 'banned', email: 'happy@example.com' },
        });

        const res = await GET(
            makeReq({
                query: { code: 'authcode', state: 'good' },
                cookies: { oauth_google_state: 'good', oauth_google_pkce: 'verifier' },
            }),
        );

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('oauth_error=account_disabled');
        expect(res.headers.getSetCookie().some((c) => c.startsWith('silkroad_session='))).toBe(false);
    });

    it('W5 D3 fix-up: NEXT_PUBLIC_APP_URL is used as redirect base instead of request.url', async () => {
        // Behind reverse proxy in prod, request.url carries the container's
        // bind addr (0.0.0.0:3002) not the public hostname; the env var
        // pins the right base.
        process.env.NEXT_PUBLIC_APP_URL = 'https://llmroute.club';

        // Success path → /dashboard
        mockExchange.mockResolvedValue({
            id_token: 'idtoken',
            access_token: 'a',
            expires_in: 3600,
            scope: '',
            token_type: 'Bearer',
        });
        mockVerify.mockResolvedValue(happyClaims());
        mockOAuthFindUnique.mockResolvedValue({
            user: { id: PORTAL_USER_ID, status: 'active', email: 'happy@example.com' },
        });
        mockUserFindUnique.mockResolvedValue({ session_token_version: 1 });

        const okRes = await GET(
            makeReq({
                query: { code: 'authcode', state: 'good' },
                cookies: { oauth_google_state: 'good', oauth_google_pkce: 'verifier' },
            }),
        );
        expect(okRes.headers.get('location')).toBe('https://llmroute.club/dashboard');

        // Failure path → /?oauth_error=...
        const failRes = await GET(makeReq({ query: { code: 'c', state: 'qstate' } /* no cookies */ }));
        expect(failRes.headers.get('location')).toBe('https://llmroute.club/?oauth_error=state_mismatch');
    });

    it('W5 D3 fix-up #3: APP_URL takes priority over NEXT_PUBLIC_APP_URL', async () => {
        // NEXT_PUBLIC_APP_URL is inlined at build time so a runtime change to
        // it has no effect on server-side reads. APP_URL is a plain runtime
        // var that wins. Both set → APP_URL wins.
        process.env.APP_URL = 'https://runtime.example.com';
        process.env.NEXT_PUBLIC_APP_URL = 'https://build-time.example.com';

        const res = await GET(makeReq({ query: { code: 'c', state: 'qstate' } /* no cookies */ }));
        expect(res.headers.get('location')).toBe('https://runtime.example.com/?oauth_error=state_mismatch');
    });

    it('W5 D3 fix-up #3: APP_URL alone (NEXT_PUBLIC_APP_URL unset) works', async () => {
        process.env.APP_URL = 'https://only-runtime.example.com';
        // NEXT_PUBLIC_APP_URL stays deleted (beforeEach)

        const res = await GET(makeReq({ query: { code: 'c', state: 'qstate' } /* no cookies */ }));
        expect(res.headers.get('location')).toBe('https://only-runtime.example.com/?oauth_error=state_mismatch');
    });
});
