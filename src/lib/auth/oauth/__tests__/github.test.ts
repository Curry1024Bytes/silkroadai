import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    GITHUB_AUTHORIZE_URL,
    GITHUB_TOKEN_URL,
    GITHUB_USER_URL,
    GITHUB_USER_EMAILS_URL,
    GitHubOAuthError,
    buildGitHubAuthorizeUrl,
    exchangeCodeForToken,
    fetchGitHubUser,
    fetchGitHubVerifiedPrimaryEmail,
    generateState,
} from '../github';

const ORIG_FETCH = global.fetch;

beforeEach(() => {
    global.fetch = vi.fn();
});
afterEach(() => {
    global.fetch = ORIG_FETCH;
});

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number } = {}): void {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: init.ok ?? true,
        status: init.status ?? 200,
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });
}

describe('generateState', () => {
    it('returns 64 hex chars (32 random bytes)', () => {
        const s = generateState();
        expect(s).toMatch(/^[a-f0-9]{64}$/);
    });
    it('two calls produce different values', () => {
        expect(generateState()).not.toBe(generateState());
    });
});

describe('buildGitHubAuthorizeUrl', () => {
    it('builds the canonical authorize URL with all required params', () => {
        const url = buildGitHubAuthorizeUrl({
            clientId: 'cid123',
            redirectUri: 'http://localhost:3002/api/auth/oauth/github/callback',
            state: 'abc',
        });
        expect(url.startsWith(GITHUB_AUTHORIZE_URL)).toBe(true);
        const u = new URL(url);
        expect(u.searchParams.get('client_id')).toBe('cid123');
        expect(u.searchParams.get('redirect_uri')).toBe(
            'http://localhost:3002/api/auth/oauth/github/callback',
        );
        expect(u.searchParams.get('scope')).toBe('read:user user:email');
        expect(u.searchParams.get('state')).toBe('abc');
        expect(u.searchParams.get('allow_signup')).toBe('true');
    });
});

describe('exchangeCodeForToken', () => {
    it('POSTs JSON with Accept: application/json and returns access_token', async () => {
        mockFetchOnce({ access_token: 'gho_xxx', token_type: 'bearer', scope: 'read:user user:email' });

        const res = await exchangeCodeForToken({
            code: 'authcode',
            clientId: 'cid',
            clientSecret: 'csecret',
            redirectUri: 'http://localhost/api/auth/oauth/github/callback',
        });

        expect(res.access_token).toBe('gho_xxx');
        // Inspect the call args
        const [calledUrl, calledInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(calledUrl).toBe(GITHUB_TOKEN_URL);
        const init = calledInit as RequestInit;
        expect(init.method).toBe('POST');
        const headers = init.headers as Record<string, string>;
        expect(headers['Accept']).toBe('application/json');
        expect(headers['Content-Type']).toBe('application/json');
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({
            client_id: 'cid',
            client_secret: 'csecret',
            code: 'authcode',
            redirect_uri: 'http://localhost/api/auth/oauth/github/callback',
        });
    });

    it('throws token_exchange_failed on non-2xx', async () => {
        mockFetchOnce('boom', { ok: false, status: 502 });
        await expect(
            exchangeCodeForToken({
                code: 'authcode',
                clientId: 'cid',
                clientSecret: 'csecret',
                redirectUri: 'http://localhost/cb',
            }),
        ).rejects.toMatchObject({ code: 'token_exchange_failed' });
    });

    it('throws token_exchange_failed when GitHub returns 200 with `error` field (e.g. bad_verification_code)', async () => {
        // GitHub responds 200 OK but with an error envelope when the code is
        // already-used / expired — must not be confused with success.
        mockFetchOnce({ error: 'bad_verification_code', error_description: 'The code is incorrect' });
        await expect(
            exchangeCodeForToken({
                code: 'reused',
                clientId: 'cid',
                clientSecret: 'csecret',
                redirectUri: 'http://localhost/cb',
            }),
        ).rejects.toMatchObject({ code: 'token_exchange_failed' });
    });
});

describe('fetchGitHubUser', () => {
    it('returns id + login + name + avatar_url', async () => {
        mockFetchOnce({ id: 12345, login: 'octocat', name: 'The Octocat', avatar_url: 'https://x/y.png' });
        const u = await fetchGitHubUser('gho_xxx');
        expect(u).toEqual({
            id: 12345,
            login: 'octocat',
            name: 'The Octocat',
            avatar_url: 'https://x/y.png',
        });
        const [calledUrl, calledInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(calledUrl).toBe(GITHUB_USER_URL);
        const headers = (calledInit as RequestInit).headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer gho_xxx');
        expect(headers['Accept']).toBe('application/vnd.github+json');
    });

    it('coerces missing name/avatar_url to null', async () => {
        mockFetchOnce({ id: 1, login: 'noinfo' });
        const u = await fetchGitHubUser('gho_xxx');
        expect(u.name).toBeNull();
        expect(u.avatar_url).toBeNull();
    });

    it('throws user_fetch_failed on non-2xx', async () => {
        mockFetchOnce('forbidden', { ok: false, status: 403 });
        await expect(fetchGitHubUser('gho_xxx')).rejects.toMatchObject({
            code: 'user_fetch_failed',
        });
    });

    it('throws user_fetch_failed when payload missing id/login', async () => {
        mockFetchOnce({ unrelated: true });
        await expect(fetchGitHubUser('gho_xxx')).rejects.toMatchObject({
            code: 'user_fetch_failed',
        });
    });
});

describe('fetchGitHubVerifiedPrimaryEmail', () => {
    it('returns the primary+verified email lowercased', async () => {
        mockFetchOnce([
            { email: 'work@example.com', primary: false, verified: true, visibility: 'private' },
            { email: 'Octo@Example.COM', primary: true, verified: true, visibility: 'public' },
            { email: 'noreply@noreply.github.com', primary: false, verified: true, visibility: null },
        ]);
        const e = await fetchGitHubVerifiedPrimaryEmail('gho_xxx');
        expect(e).toBe('octo@example.com');
        const [calledUrl] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(calledUrl).toBe(GITHUB_USER_EMAILS_URL);
    });

    it('throws email_not_verified when no row is primary AND verified', async () => {
        mockFetchOnce([
            { email: 'a@x.com', primary: true, verified: false, visibility: null },
            { email: 'b@x.com', primary: false, verified: true, visibility: null },
        ]);
        await expect(fetchGitHubVerifiedPrimaryEmail('gho_xxx')).rejects.toMatchObject({
            code: 'email_not_verified',
        });
    });

    it('throws email_fetch_failed on non-2xx', async () => {
        mockFetchOnce('boom', { ok: false, status: 500 });
        await expect(fetchGitHubVerifiedPrimaryEmail('gho_xxx')).rejects.toMatchObject({
            code: 'email_fetch_failed',
        });
    });
});

describe('GitHubOAuthError', () => {
    it('carries typed code', () => {
        const err = new GitHubOAuthError('email_not_verified', 'msg');
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe('email_not_verified');
        expect(err.name).toBe('GitHubOAuthError');
    });
});
