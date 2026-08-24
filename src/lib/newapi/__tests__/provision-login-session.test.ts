/**
 * provisionNewCustomer login-session regression tests (2026-08-03).
 *
 * Current new-api returns a short-lived login JWT in the body
 * (data.access_token, with the user nested under data.user) and does not set
 * the legacy gorilla `session=` cookie. Both current and older releases must
 * exchange their login credential for the durable /api/user/token value.
 *
 * Covers:
 *   - current shape: body JWT → durable access token → act-as calls
 *   - legacy shape: session cookie → step 3 uses `Cookie: session=...`
 *   - neither present → NewApiError (no silent fallthrough)
 *
 * No real network; global fetch is mocked with a route dispatcher.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NewApiError, provisionNewCustomer } from '../client';

const PORTAL_USER_ID = 'deadbeef-1111-4222-8333-444455556666';
const EMAIL = 'rc22-test@example.com';
const NEWAPI_USER_ID = 758;
const NEWAPI_GROUP = 'GPT-特惠反代';

type RecordedRequest = { method: string; path: string; headers: Record<string, string>; body?: unknown };

const recorded: RecordedRequest[] = [];

function jsonResponse(body: unknown, init?: { headers?: Record<string, string> }): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
}

/**
 * Route-dispatching fetch mock for the 6-step provision flow. `loginBody`
 * and `loginHeaders` control what POST /api/user/login hands back so each
 * test can simulate current body-token vs legacy Set-Cookie servers.
 */
function installFetchMock(opts: { loginBody: unknown; loginHeaders?: Record<string, string> }) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = new URL(String(input));
            const method = init?.method ?? 'GET';
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
                headers[k.toLowerCase()] = v;
            }
            const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
            recorded.push({ method, path: url.pathname, headers, body });

            if (method === 'POST' && url.pathname === '/api/user/') {
                return jsonResponse({ success: true, message: '' });
            }
            if (method === 'POST' && url.pathname === '/api/user/login') {
                return jsonResponse(opts.loginBody, { headers: opts.loginHeaders });
            }
            if (method === 'GET' && url.pathname === '/api/user/token') {
                return jsonResponse({ success: true, message: '', data: 'classic-access-token-xyz' });
            }
            if (method === 'POST' && url.pathname === '/api/token/') {
                return jsonResponse({ success: true, message: '' });
            }
            if (method === 'GET' && url.pathname === '/api/token/') {
                return jsonResponse({
                    success: true,
                    message: '',
                    data: {
                        page: 1,
                        page_size: 10,
                        total: 1,
                        items: [
                            {
                                id: 1903,
                                user_id: NEWAPI_USER_ID,
                                name: `default-${PORTAL_USER_ID.slice(0, 8)}`,
                                key: 'masked',
                                status: 1,
                            },
                        ],
                    },
                });
            }
            if (method === 'POST' && url.pathname === '/api/token/1903/key') {
                return jsonResponse({ success: true, message: '', data: { key: 'sk-real-key-123' } });
            }
            throw new Error(`fetch mock: unexpected ${method} ${url.pathname}`);
        }),
    );
}

beforeEach(() => {
    recorded.length = 0;
    vi.stubEnv('NEWAPI_ADMIN_TOKEN', 'test-admin-token');
    vi.stubEnv('NEWAPI_ADMIN_USER_ID', '1');
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

const CURRENT_LOGIN_BODY = {
    success: true,
    message: '',
    data: {
        access_token: 'rc22.session.jwt',
        token_type: 'Bearer',
        user: { id: NEWAPI_USER_ID, username: `c-${PORTAL_USER_ID.slice(0, 8)}`, role: 1 },
    },
};

const LEGACY_LOGIN_BODY = {
    success: true,
    message: '',
    data: { id: NEWAPI_USER_ID, username: `c-${PORTAL_USER_ID.slice(0, 8)}`, role: 1 },
};

describe('provisionNewCustomer login session handling', () => {
    it('current new-api: exchanges the body JWT for a durable access token', async () => {
        installFetchMock({ loginBody: CURRENT_LOGIN_BODY });

        const result = await provisionNewCustomer({
            portal_user_id: PORTAL_USER_ID,
            email: EMAIL,
            newapi_group: NEWAPI_GROUP,
        });

        const rotate = recorded.find((r) => r.method === 'GET' && r.path === '/api/user/token');
        expect(rotate).toBeDefined();
        expect(rotate!.headers['authorization']).toBe('rc22.session.jwt');
        expect(rotate!.headers['cookie']).toBeUndefined();
        expect(rotate!.headers['new-api-user']).toBe(String(NEWAPI_USER_ID));

        expect(result.newapi_user_id).toBe(NEWAPI_USER_ID);
        expect(result.newapi_access_token).toBe('classic-access-token-xyz');
        expect(result.newapi_token_value).toBe('sk-real-key-123');
        const createToken = recorded.find((r) => r.method === 'POST' && r.path === '/api/token/');
        expect(createToken?.body).toEqual(expect.objectContaining({ group: NEWAPI_GROUP }));
    });

    it('legacy (≤ rc.2): still uses the session cookie for GET /api/user/token', async () => {
        installFetchMock({
            loginBody: LEGACY_LOGIN_BODY,
            loginHeaders: { 'Set-Cookie': 'session=legacy-session-value; Path=/; HttpOnly' },
        });

        const result = await provisionNewCustomer({
            portal_user_id: PORTAL_USER_ID,
            email: EMAIL,
            newapi_group: NEWAPI_GROUP,
        });

        const rotate = recorded.find((r) => r.method === 'GET' && r.path === '/api/user/token');
        expect(rotate).toBeDefined();
        expect(rotate!.headers['cookie']).toBe('session=legacy-session-value');
        expect(rotate!.headers['authorization']).toBeUndefined();
        expect(rotate!.headers['new-api-user']).toBe(String(NEWAPI_USER_ID));

        expect(result.newapi_access_token).toBe('classic-access-token-xyz');
    });

    it('login 200 with neither JWT nor cookie → NewApiError, no further steps', async () => {
        installFetchMock({ loginBody: LEGACY_LOGIN_BODY }); // no Set-Cookie, no access_token

        await expect(
            provisionNewCustomer({ portal_user_id: PORTAL_USER_ID, email: EMAIL, newapi_group: NEWAPI_GROUP }),
        ).rejects.toThrow(NewApiError);
        const rotate = recorded.find((r) => r.method === 'GET' && r.path === '/api/user/token');
        expect(rotate).toBeUndefined();
    });

    it('act-as steps 4-6 use the durable access token without a Bearer prefix', async () => {
        installFetchMock({ loginBody: CURRENT_LOGIN_BODY });

        await provisionNewCustomer({ portal_user_id: PORTAL_USER_ID, email: EMAIL, newapi_group: NEWAPI_GROUP });

        const createToken = recorded.find((r) => r.method === 'POST' && r.path === '/api/token/');
        expect(createToken).toBeDefined();
        expect(createToken!.headers['authorization']).toBe('classic-access-token-xyz');
        expect(createToken!.headers['new-api-user']).toBe(String(NEWAPI_USER_ID));
    });
});
