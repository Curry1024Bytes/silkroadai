import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET } from '../route';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
    process.env = { ...ORIG_ENV };
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3002/api/auth/oauth/google/callback';
});

afterEach(() => {
    process.env = ORIG_ENV;
});

describe('GET /api/auth/oauth/google/start', () => {
    it('302 redirect to Google authorize URL with all required params', async () => {
        const res = await GET();
        expect(res.status).toBe(302);

        const location = res.headers.get('location')!;
        expect(location.startsWith('https://accounts.google.com/o/oauth2/v2/auth')).toBe(true);

        const u = new URL(location);
        expect(u.searchParams.get('client_id')).toBe('test-client-id.apps.googleusercontent.com');
        expect(u.searchParams.get('redirect_uri')).toBe(
            'http://localhost:3002/api/auth/oauth/google/callback',
        );
        expect(u.searchParams.get('response_type')).toBe('code');
        expect(u.searchParams.get('scope')).toBe('openid email profile');
        expect(u.searchParams.get('code_challenge_method')).toBe('S256');

        // state + code_challenge are random; just assert presence + non-empty
        expect(u.searchParams.get('state')).toMatch(/^[a-f0-9]{64}$/); // 32 bytes hex
        expect(u.searchParams.get('code_challenge')?.length).toBeGreaterThan(20);
    });

    it('sets state + pkce cookies (httpOnly, sameSite=lax) matching the URL params', async () => {
        const res = await GET();

        // Read both Set-Cookie headers (the helper API gives us the canonical
        // serialized form). Verify both cookies present.
        const cookies = res.headers.getSetCookie();
        const stateLine = cookies.find((c) => c.startsWith('oauth_google_state='))!;
        const pkceLine = cookies.find((c) => c.startsWith('oauth_google_pkce='))!;

        expect(stateLine).toBeDefined();
        expect(pkceLine).toBeDefined();
        expect(stateLine).toMatch(/HttpOnly/i);
        expect(stateLine).toMatch(/SameSite=lax/i);
        expect(stateLine).toMatch(/Path=\//i);
        expect(pkceLine).toMatch(/HttpOnly/i);
        expect(pkceLine).toMatch(/SameSite=lax/i);

        // The state cookie value must equal the `state` query param sent to
        // Google — that's the whole point of the CSRF check on callback.
        const u = new URL(res.headers.get('location')!);
        const stateValueFromCookie = stateLine.split(';')[0].split('=')[1];
        expect(stateValueFromCookie).toBe(u.searchParams.get('state'));
    });

    it('503 when GOOGLE_OAUTH_CLIENT_ID is missing', async () => {
        delete process.env.GOOGLE_OAUTH_CLIENT_ID;

        const res = await GET();
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.error).toBe('oauth_not_configured');
    });

    it('503 when GOOGLE_OAUTH_REDIRECT_URI is missing', async () => {
        delete process.env.GOOGLE_OAUTH_REDIRECT_URI;

        const res = await GET();
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.error).toBe('oauth_not_configured');
    });
});
