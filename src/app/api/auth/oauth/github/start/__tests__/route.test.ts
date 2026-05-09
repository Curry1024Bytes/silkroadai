import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET } from '../route';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
    process.env = { ...ORIG_ENV };
    process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-cid';
    process.env.GITHUB_OAUTH_REDIRECT_URI = 'http://localhost:3002/api/auth/oauth/github/callback';
});
afterEach(() => {
    process.env = ORIG_ENV;
});

describe('GET /api/auth/oauth/github/start', () => {
    it('302 redirect to GitHub authorize URL with all required params', async () => {
        const res = await GET();
        expect(res.status).toBe(302);

        const location = res.headers.get('location')!;
        expect(location.startsWith('https://github.com/login/oauth/authorize')).toBe(true);
        const u = new URL(location);
        expect(u.searchParams.get('client_id')).toBe('gh-cid');
        expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:3002/api/auth/oauth/github/callback');
        expect(u.searchParams.get('scope')).toBe('read:user user:email');
        expect(u.searchParams.get('state')).toMatch(/^[a-f0-9]{64}$/);
        expect(u.searchParams.get('allow_signup')).toBe('true');
    });

    it('sets oauth_github_state cookie httpOnly+sameSite=lax matching the URL state', async () => {
        const res = await GET();
        const cookies = res.headers.getSetCookie();
        const stateLine = cookies.find((c) => c.startsWith('oauth_github_state='))!;
        expect(stateLine).toBeDefined();
        expect(stateLine).toMatch(/HttpOnly/i);
        expect(stateLine).toMatch(/SameSite=lax/i);
        expect(stateLine).toMatch(/Path=\//i);

        const u = new URL(res.headers.get('location')!);
        const stateValueFromCookie = stateLine.split(';')[0].split('=')[1];
        expect(stateValueFromCookie).toBe(u.searchParams.get('state'));
    });

    it('503 when GITHUB_OAUTH_CLIENT_ID missing', async () => {
        delete process.env.GITHUB_OAUTH_CLIENT_ID;
        const res = await GET();
        expect(res.status).toBe(503);
        expect((await res.json()).error).toBe('oauth_not_configured');
    });

    it('503 when GITHUB_OAUTH_REDIRECT_URI missing', async () => {
        delete process.env.GITHUB_OAUTH_REDIRECT_URI;
        const res = await GET();
        expect(res.status).toBe(503);
        expect((await res.json()).error).toBe('oauth_not_configured');
    });
});
