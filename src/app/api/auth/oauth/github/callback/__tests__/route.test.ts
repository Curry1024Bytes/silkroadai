import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ── github helper mock ──
// vi.mock factory is hoisted; declare GitHubOAuthError inside the factory so
// the route's `instanceof` check still passes.
const mockExchange = vi.fn();
const mockFetchUser = vi.fn();
const mockFetchEmail = vi.fn();
vi.mock('@/lib/auth/oauth/github', () => {
    class GitHubOAuthError extends Error {
        constructor(
            public code: string,
            message: string,
        ) {
            super(message);
            this.name = 'GitHubOAuthError';
        }
    }
    return {
        exchangeCodeForToken: (...args: unknown[]) => mockExchange(...args),
        fetchGitHubUser: (...args: unknown[]) => mockFetchUser(...args),
        fetchGitHubVerifiedPrimaryEmail: (...args: unknown[]) => mockFetchEmail(...args),
        GitHubOAuthError,
    };
});

// ── account-link helper mock ──
// The 5-branch logic itself is tested directly in account-link.test.ts. Here
// we just verify the route correctly hands identity to it and maps outcomes
// back to redirects/cookies.
const mockLinkOrCreate = vi.fn();
vi.mock('@/lib/auth/oauth/account-link', () => ({
    linkOrCreateOAuthUser: (...args: unknown[]) => mockLinkOrCreate(...args),
}));

// P6a: callback resolves the request-domain tenant + passes its id to linkOrCreate.
vi.mock('@/lib/tenant/resolve', () => ({
    resolveTenantByHost: vi.fn(async () => ({ id: 'tenant-platform' })),
}));

// ── prisma mock — only last_login_at touch + signSession's tv lookup ──
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

import { GET } from '../route';
import { GitHubOAuthError } from '@/lib/auth/oauth/github';

const ORIG_ENV = { ...process.env };
const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeReq(opts: { query?: Record<string, string>; cookies?: Record<string, string> }): NextRequest {
    const url = new URL('http://localhost/api/auth/oauth/github/callback');
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
    process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-cid';
    process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh-csecret';
    process.env.GITHUB_OAUTH_REDIRECT_URI = 'http://localhost:3002/api/auth/oauth/github/callback';
    // Ensure tests run against the request.url-based fallback path. The
    // dedicated "redirect base env precedence" test sets these explicitly.
    // Local .env may have them set to a prod URL; clear here.
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    // signSession's user lookup default
    mockUserFindUnique.mockResolvedValue({ session_token_version: 1 });
    mockUserUpdate.mockResolvedValue({});
});
afterEach(() => {
    process.env = ORIG_ENV;
});

describe('GET /api/auth/oauth/github/callback', () => {
    it('state_mismatch when state cookie missing', async () => {
        const res = await GET(makeReq({ query: { code: 'c', state: 'qs' } }));
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('oauth_error=state_mismatch');
        expect(mockExchange).not.toHaveBeenCalled();
    });

    it('state_mismatch when cookie state ≠ query state', async () => {
        const res = await GET(
            makeReq({
                query: { code: 'c', state: 'qstate' },
                cookies: { oauth_github_state: 'cookie-state' },
            }),
        );
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('oauth_error=state_mismatch');
        expect(mockExchange).not.toHaveBeenCalled();
    });

    it('github_denied when GitHub sends ?error= (user clicked cancel)', async () => {
        const res = await GET(
            makeReq({
                query: { error: 'access_denied' },
                cookies: { oauth_github_state: 's' },
            }),
        );
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('oauth_error=github_denied');
        expect(mockExchange).not.toHaveBeenCalled();
    });

    it('missing_code_or_state when query lacks code+state', async () => {
        const res = await GET(makeReq({ cookies: { oauth_github_state: 's' } }));
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('oauth_error=missing_code_or_state');
    });

    it('surfaces token_exchange_failed', async () => {
        mockExchange.mockRejectedValue(new GitHubOAuthError('token_exchange_failed', 'oops'));
        const res = await GET(
            makeReq({
                query: { code: 'c', state: 'good' },
                cookies: { oauth_github_state: 'good' },
            }),
        );
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('oauth_error=token_exchange_failed');
    });

    it('surfaces user_fetch_failed', async () => {
        mockExchange.mockResolvedValue({ access_token: 'gho', token_type: 'bearer', scope: '' });
        mockFetchUser.mockRejectedValue(new GitHubOAuthError('user_fetch_failed', 'forbidden'));
        const res = await GET(
            makeReq({
                query: { code: 'c', state: 'good' },
                cookies: { oauth_github_state: 'good' },
            }),
        );
        expect(res.headers.get('location')).toContain('oauth_error=user_fetch_failed');
    });

    it('surfaces email_not_verified when user has no primary verified email', async () => {
        mockExchange.mockResolvedValue({ access_token: 'gho', token_type: 'bearer', scope: '' });
        mockFetchUser.mockResolvedValue({ id: 1, login: 'octo', name: null, avatar_url: null });
        mockFetchEmail.mockRejectedValue(new GitHubOAuthError('email_not_verified', 'no row'));
        const res = await GET(
            makeReq({
                query: { code: 'c', state: 'good' },
                cookies: { oauth_github_state: 'good' },
            }),
        );
        expect(res.headers.get('location')).toContain('oauth_error=email_not_verified');
    });

    it('happy path: exchanges → fetches → invokes linkOrCreate with stringified id + signs session', async () => {
        mockExchange.mockResolvedValue({
            access_token: 'gho_xxx',
            token_type: 'bearer',
            scope: 'read:user user:email',
        });
        mockFetchUser.mockResolvedValue({ id: 12345, login: 'octocat', name: 'The Octocat', avatar_url: null });
        mockFetchEmail.mockResolvedValue('octo@example.com');
        mockLinkOrCreate.mockResolvedValue({ ok: true, userId: PORTAL_USER_ID, branch: 1 });

        const res = await GET(
            makeReq({
                query: { code: 'c', state: 'good' },
                cookies: { oauth_github_state: 'good' },
            }),
        );

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('http://localhost/dashboard');
        // helper called with provider='github' + stringified id + lowercased email
        expect(mockLinkOrCreate).toHaveBeenCalledWith(
            {
                provider: 'github',
                providerAccountId: '12345',
                email: 'octo@example.com',
                nameHint: 'The Octocat',
            },
            'tenant-platform', // P6a tenant attribution
        );
        // session cookie set
        expect(res.headers.getSetCookie().some((c) => c.startsWith('silkroad_session='))).toBe(true);
        // state cookie cleared
        expect(
            res.headers
                .getSetCookie()
                .some((c) => c.startsWith('oauth_github_state=;') || c.startsWith('oauth_github_state=; ')),
        ).toBe(true);
    });

    it('falls back to login when ghUser.name is null (uses username as nameHint)', async () => {
        mockExchange.mockResolvedValue({ access_token: 'gho', token_type: 'bearer', scope: '' });
        mockFetchUser.mockResolvedValue({ id: 7, login: 'noname', name: null, avatar_url: null });
        mockFetchEmail.mockResolvedValue('noname@example.com');
        mockLinkOrCreate.mockResolvedValue({ ok: true, userId: PORTAL_USER_ID, branch: 4 });

        await GET(
            makeReq({
                query: { code: 'c', state: 'good' },
                cookies: { oauth_github_state: 'good' },
            }),
        );

        expect(mockLinkOrCreate).toHaveBeenCalledWith(
            expect.objectContaining({ nameHint: 'noname' }),
            'tenant-platform',
        );
    });

    it('maps account_disabled outcome from helper to redirect', async () => {
        mockExchange.mockResolvedValue({ access_token: 'gho', token_type: 'bearer', scope: '' });
        mockFetchUser.mockResolvedValue({ id: 1, login: 'banned', name: null, avatar_url: null });
        mockFetchEmail.mockResolvedValue('banned@example.com');
        mockLinkOrCreate.mockResolvedValue({ ok: false, error: 'account_disabled' });

        const res = await GET(
            makeReq({
                query: { code: 'c', state: 'good' },
                cookies: { oauth_github_state: 'good' },
            }),
        );
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('oauth_error=account_disabled');
        // no session cookie
        expect(res.headers.getSetCookie().some((c) => c.startsWith('silkroad_session='))).toBe(false);
    });

    it('maps provisioning_failed outcome to redirect', async () => {
        mockExchange.mockResolvedValue({ access_token: 'gho', token_type: 'bearer', scope: '' });
        mockFetchUser.mockResolvedValue({ id: 1, login: 'newbie', name: null, avatar_url: null });
        mockFetchEmail.mockResolvedValue('newbie@example.com');
        mockLinkOrCreate.mockResolvedValue({ ok: false, error: 'provisioning_failed' });

        const res = await GET(
            makeReq({
                query: { code: 'c', state: 'good' },
                cookies: { oauth_github_state: 'good' },
            }),
        );
        expect(res.headers.get('location')).toContain('oauth_error=provisioning_failed');
    });

    it('W5 D3 fix-up: NEXT_PUBLIC_APP_URL is used as redirect base instead of request.url', async () => {
        // Behind reverse proxy in prod, request.url carries the container's
        // bind addr (0.0.0.0:3002) not the public hostname; the env var
        // pins the right base.
        process.env.NEXT_PUBLIC_APP_URL = 'https://portal.silkroadai.io';

        // Success path → /dashboard
        mockExchange.mockResolvedValue({
            access_token: 'gho_xxx',
            token_type: 'bearer',
            scope: 'read:user user:email',
        });
        mockFetchUser.mockResolvedValue({ id: 12345, login: 'octocat', name: 'The Octocat', avatar_url: null });
        mockFetchEmail.mockResolvedValue('octo@example.com');
        mockLinkOrCreate.mockResolvedValue({ ok: true, userId: PORTAL_USER_ID, branch: 1 });

        const okRes = await GET(
            makeReq({
                query: { code: 'c', state: 'good' },
                cookies: { oauth_github_state: 'good' },
            }),
        );
        expect(okRes.headers.get('location')).toBe('https://portal.silkroadai.io/dashboard');

        // Failure path → /?oauth_error=...
        const failRes = await GET(makeReq({ query: { code: 'c', state: 'qstate' } /* no cookies */ }));
        expect(failRes.headers.get('location')).toBe('https://portal.silkroadai.io/?oauth_error=state_mismatch');
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
