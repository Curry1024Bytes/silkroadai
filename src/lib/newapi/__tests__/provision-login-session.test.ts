/**
 * provisionNewCustomer — login-session + access-token issuance tests.
 *
 * History of the step-3 ("get the customer's dashboard access_token") contract:
 *   - ≤ rc.2   : POST /api/user/login sets a gorilla `session=` cookie;
 *                GET /api/user/token (cookie) rotates the 32-char access_token.
 *   - rc.22    : login returns a short-lived Bearer JWT in the body instead
 *                (2026-08-03 regression: every registration died at step 2).
 *   - rc.41+   : GET /api/user/token is REMOVED. The customer's act-as
 *                credential is a named personal access token (`nap_…`) minted
 *                on the login session: POST /api/verify (password proof) →
 *                POST /api/user/access_tokens with `X-Security-Proof`.
 *
 * `issueCustomerAccessToken` picks the flow from NEWAPI_ACCESS_TOKEN_MODE or
 * (auto) from GET /api/status `version`, so one portal build must work on
 * both sides of the rc.44 upgrade. No real network; fetch is a route mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CUSTOMER_PAT_SCOPES,
    NewApiError,
    _resetAccessTokenModeCache,
    accessTokenModeForVersion,
    isLegacyNewApiAccessToken,
    provisionNewCustomer,
    reissueCustomerAccessTokenViaAdminReset,
} from '../client';

const PORTAL_USER_ID = 'deadbeef-1111-4222-8333-444455556666';
const EMAIL = 'rc22-test@example.com';
const NEWAPI_USER_ID = 758;
const USERNAME = `c-${PORTAL_USER_ID.slice(0, 8)}`;

type RecordedRequest = {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: Record<string, unknown> | null;
    init: RequestInit | undefined;
};

const recorded: RecordedRequest[] = [];

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
    return new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
}

/** new-api NoRoute: unknown GET → 301 to the frontend, unknown POST → 404 JSON. */
function noRoute(method: string, path: string): Response {
    if (method === 'GET') {
        return new Response('<a href="/">Moved Permanently</a>.', {
            status: 301,
            headers: { Location: `https://admin.example${path}`, 'Content-Type': 'text/html' },
        });
    }
    return jsonResponse(
        { error: { message: `Invalid URL (${method} ${path})`, type: 'invalid_request_error' } },
        { status: 404 },
    );
}

interface MockServer {
    /** `version` reported by GET /api/status; `null` → /api/status 500s. */
    version: string | null;
    /** Which access-token endpoints exist on this server. */
    flavour: 'legacy' | 'pat';
    loginBody: unknown;
    loginHeaders?: Record<string, string>;
    /** POST /api/verify override (e.g. wrong password → 403). */
    verifyResponse?: () => Response;
    /** Password the mock accepts for POST /api/verify (any when undefined). */
    acceptPassword?: string;
    /** Admin-flow fixtures. */
    adminLoginBody?: unknown;
    adminUserFields?: Record<string, unknown>;
    customerLoginPasswords?: string[];
}

function installFetchMock(server: MockServer) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = new URL(String(input));
            const method = init?.method ?? 'GET';
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
                headers[k.toLowerCase()] = v;
            }
            const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
            recorded.push({ method, path: url.pathname, headers, body, init });

            if (method === 'GET' && url.pathname === '/api/status') {
                if (server.version === null) return jsonResponse({ success: false, message: 'boom' }, { status: 500 });
                return jsonResponse({ success: true, message: '', data: { version: server.version } });
            }
            if (method === 'POST' && url.pathname === '/api/user/') {
                return jsonResponse({ success: true, message: '' });
            }
            if (method === 'GET' && url.pathname === `/api/user/${NEWAPI_USER_ID}`) {
                return jsonResponse({
                    success: true,
                    message: '',
                    data: {
                        id: NEWAPI_USER_ID,
                        username: USERNAME,
                        display_name: USERNAME,
                        role: 1,
                        status: 1,
                        group: 'default',
                        ...server.adminUserFields,
                    },
                });
            }
            if (method === 'PUT' && url.pathname === '/api/user/') {
                if (!headers['x-security-proof'])
                    return jsonResponse({ success: false, code: 'SECURITY_PROOF_REQUIRED' }, { status: 403 });
                return jsonResponse({ success: true, message: '' });
            }
            if (method === 'POST' && url.pathname === '/api/user/login') {
                const username = body?.username;
                if (server.adminLoginBody && username === 'root') {
                    return jsonResponse(server.adminLoginBody);
                }
                if (server.customerLoginPasswords) server.customerLoginPasswords.push(String(body?.password));
                return jsonResponse(server.loginBody, { headers: server.loginHeaders });
            }
            if (method === 'GET' && url.pathname === '/api/user/token') {
                if (server.flavour === 'pat') return noRoute(method, url.pathname);
                return jsonResponse({ success: true, message: '', data: 'classic-access-token-xyz' });
            }
            if (method === 'POST' && url.pathname === '/api/verify') {
                if (server.flavour === 'legacy') return noRoute(method, url.pathname);
                if (server.verifyResponse) return server.verifyResponse();
                if (server.acceptPassword !== undefined && body?.password !== server.acceptPassword) {
                    return jsonResponse({ success: false, message: 'Verification failed' }, { status: 403 });
                }
                return jsonResponse({
                    success: true,
                    message: '',
                    data: {
                        proof_token: `proof-${body?.scope}`,
                        expires_at: 0,
                        method: 'password',
                        scope: body?.scope,
                    },
                });
            }
            if (method === 'GET' && url.pathname === '/api/user/access_tokens/catalog') {
                if (server.flavour === 'legacy') return noRoute(method, url.pathname);
                return jsonResponse({ success: true, data: { groups: [], max_tokens: 20, default_expiry_days: 90 } });
            }
            if (method === 'POST' && url.pathname === '/api/user/access_tokens') {
                if (server.flavour === 'legacy') return noRoute(method, url.pathname);
                if (headers['x-security-proof'] !== 'proof-access_token.generate') {
                    return jsonResponse({ success: false, code: 'SECURITY_PROOF_REQUIRED' }, { status: 403 });
                }
                return jsonResponse({
                    success: true,
                    message: '',
                    data: { token: 'nap_freshPATvalue', item: { id: 7 } },
                });
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
    _resetAccessTokenModeCache();
    vi.stubEnv('NEWAPI_ADMIN_TOKEN', 'test-admin-token');
    vi.stubEnv('NEWAPI_ADMIN_USER_ID', '1');
    vi.stubEnv('NEWAPI_ACCESS_TOKEN_MODE', '');
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

const RC22_LOGIN_BODY = {
    success: true,
    message: '',
    data: {
        access_token: 'rc22.session.jwt',
        token_type: 'Bearer',
        user: { id: NEWAPI_USER_ID, username: USERNAME, role: 1 },
    },
};

const LEGACY_LOGIN_BODY = {
    success: true,
    message: '',
    data: { id: NEWAPI_USER_ID, username: USERNAME, role: 1 },
};

const ROOT_LOGIN_BODY = {
    success: true,
    message: '',
    data: { access_token: 'root.session.jwt', token_type: 'Bearer', user: { id: 1, username: 'root', role: 100 } },
};

const find = (method: string, path: string) => recorded.find((r) => r.method === method && r.path === path);
const all = (method: string, path: string) => recorded.filter((r) => r.method === method && r.path === path);

describe('provisionNewCustomer login session handling (≤ rc.40 legacy rotate)', () => {
    it('rc.22: uses the body JWT as Bearer auth for GET /api/user/token', async () => {
        installFetchMock({ version: 'v1.0.0-rc.22', flavour: 'legacy', loginBody: RC22_LOGIN_BODY });

        const result = await provisionNewCustomer({
            portal_user_id: PORTAL_USER_ID,
            email: EMAIL,
            newapi_group: 'test-group',
        });

        const rotate = find('GET', '/api/user/token');
        expect(rotate).toBeDefined();
        expect(rotate!.headers['authorization']).toBe('Bearer rc22.session.jwt');
        expect(rotate!.headers['cookie']).toBeUndefined();
        expect(rotate!.headers['new-api-user']).toBe(String(NEWAPI_USER_ID));
        expect(find('POST', '/api/verify')).toBeUndefined();

        expect(result.newapi_user_id).toBe(NEWAPI_USER_ID);
        expect(result.newapi_access_token).toBe('classic-access-token-xyz');
        expect(result.newapi_token_value).toBe('sk-real-key-123');
    });

    it('legacy (≤ rc.2): still uses the session cookie for GET /api/user/token', async () => {
        installFetchMock({
            version: 'v1.0.0-rc.2',
            flavour: 'legacy',
            loginBody: LEGACY_LOGIN_BODY,
            loginHeaders: { 'Set-Cookie': 'session=legacy-session-value; Path=/; HttpOnly' },
        });

        const result = await provisionNewCustomer({
            portal_user_id: PORTAL_USER_ID,
            email: EMAIL,
            newapi_group: 'test-group',
        });

        const rotate = find('GET', '/api/user/token');
        expect(rotate).toBeDefined();
        expect(rotate!.headers['cookie']).toBe('session=legacy-session-value');
        expect(rotate!.headers['authorization']).toBeUndefined();
        expect(rotate!.headers['new-api-user']).toBe(String(NEWAPI_USER_ID));
        expect(result.newapi_access_token).toBe('classic-access-token-xyz');
    });

    it('neither JWT nor cookie → NewApiError, never a silent fallthrough', async () => {
        installFetchMock({
            version: 'v1.0.0-rc.22',
            flavour: 'legacy',
            loginBody: { success: true, message: '', data: { id: NEWAPI_USER_ID, username: USERNAME, role: 1 } },
        });

        await expect(
            provisionNewCustomer({ portal_user_id: PORTAL_USER_ID, email: EMAIL, newapi_group: 'test-group' }),
        ).rejects.toBeInstanceOf(NewApiError);
        expect(find('GET', '/api/user/token')).toBeUndefined();
    });

    it('every call() opts out of redirect following (NoRoute 301 must surface, not become a 200 HTML page)', async () => {
        installFetchMock({ version: 'v1.0.0-rc.22', flavour: 'legacy', loginBody: RC22_LOGIN_BODY });
        await provisionNewCustomer({ portal_user_id: PORTAL_USER_ID, email: EMAIL, newapi_group: 'test-group' });
        for (const r of recorded.filter((r) => r.path !== '/api/user/login')) {
            expect(r.init?.redirect).toBe('manual');
        }
    });
});

describe('provisionNewCustomer on rc.41+ (named personal access tokens)', () => {
    it('auto mode detects rc.44 from /api/status and mints a never-expiring PAT instead of rotating', async () => {
        installFetchMock({ version: 'v1.0.0-rc.44', flavour: 'pat', loginBody: RC22_LOGIN_BODY });

        const result = await provisionNewCustomer({
            portal_user_id: PORTAL_USER_ID,
            email: EMAIL,
            newapi_group: 'test-group',
        });

        expect(find('GET', '/api/user/token')).toBeUndefined();

        const createUser = find('POST', '/api/user/');
        const password = String(createUser!.body!.password);
        expect(password.length).toBeGreaterThanOrEqual(8);

        const verify = find('POST', '/api/verify');
        expect(verify).toBeDefined();
        expect(verify!.headers['authorization']).toBe('Bearer rc22.session.jwt');
        expect(verify!.headers['new-api-user']).toBe(String(NEWAPI_USER_ID));
        expect(verify!.body).toEqual({
            method: 'password',
            scope: 'access_token.generate',
            password,
            context: { scopes: [...CUSTOMER_PAT_SCOPES], expires_at: 0 },
        });

        const create = find('POST', '/api/user/access_tokens');
        expect(create).toBeDefined();
        expect(create!.headers['authorization']).toBe('Bearer rc22.session.jwt');
        expect(create!.headers['x-security-proof']).toBe('proof-access_token.generate');
        expect(create!.body).toEqual({ name: 'portal-act-as', scopes: [...CUSTOMER_PAT_SCOPES], expires_at: 0 });

        // The minted PAT is what every subsequent act-as call authenticates with (bare, no Bearer).
        for (const r of recorded.filter((r) => r.path.startsWith('/api/token/'))) {
            expect(r.headers['authorization']).toBe('nap_freshPATvalue');
            expect(r.headers['new-api-user']).toBe(String(NEWAPI_USER_ID));
        }
        expect(result.newapi_access_token).toBe('nap_freshPATvalue');
        expect(isLegacyNewApiAccessToken(result.newapi_access_token)).toBe(false);
        expect(result.newapi_token_value).toBe('sk-real-key-123');
    });

    it('caches the detected mode: a second provision does not re-read /api/status', async () => {
        installFetchMock({ version: 'v1.0.0-rc.44', flavour: 'pat', loginBody: RC22_LOGIN_BODY });
        await provisionNewCustomer({ portal_user_id: PORTAL_USER_ID, email: EMAIL, newapi_group: 'test-group' });
        await provisionNewCustomer({ portal_user_id: PORTAL_USER_ID, email: EMAIL, newapi_group: 'test-group' });
        expect(all('GET', '/api/status')).toHaveLength(1);
        expect(all('POST', '/api/user/access_tokens')).toHaveLength(2);
    });

    it('NEWAPI_ACCESS_TOKEN_MODE=pat skips the /api/status probe', async () => {
        vi.stubEnv('NEWAPI_ACCESS_TOKEN_MODE', 'pat');
        installFetchMock({ version: 'v1.0.0-rc.44', flavour: 'pat', loginBody: RC22_LOGIN_BODY });

        const result = await provisionNewCustomer({
            portal_user_id: PORTAL_USER_ID,
            email: EMAIL,
            newapi_group: 'test-group',
        });

        expect(find('GET', '/api/status')).toBeUndefined();
        expect(find('GET', '/api/user/token')).toBeUndefined();
        expect(result.newapi_access_token).toBe('nap_freshPATvalue');
    });

    it('NEWAPI_ACCESS_TOKEN_MODE=legacy pins the rotate path even when the server would support PATs', async () => {
        vi.stubEnv('NEWAPI_ACCESS_TOKEN_MODE', 'legacy');
        installFetchMock({ version: 'v1.0.0-rc.44', flavour: 'legacy', loginBody: RC22_LOGIN_BODY });

        const result = await provisionNewCustomer({
            portal_user_id: PORTAL_USER_ID,
            email: EMAIL,
            newapi_group: 'test-group',
        });

        expect(find('GET', '/api/status')).toBeUndefined();
        expect(find('POST', '/api/verify')).toBeUndefined();
        expect(result.newapi_access_token).toBe('classic-access-token-xyz');
    });

    it('/api/status unreachable → probes the PAT flow first and falls back to rotate on a missing route', async () => {
        installFetchMock({ version: null, flavour: 'legacy', loginBody: RC22_LOGIN_BODY });

        const result = await provisionNewCustomer({
            portal_user_id: PORTAL_USER_ID,
            email: EMAIL,
            newapi_group: 'test-group',
        });

        expect(find('GET', '/api/user/access_tokens/catalog')).toBeDefined(); // Read-only NoRoute probe.
        expect(find('POST', '/api/verify')).toBeUndefined(); // Do not send a PAT context to an old verifier.
        expect(find('GET', '/api/user/token')).toBeDefined();
        expect(result.newapi_access_token).toBe('classic-access-token-xyz');
    });

    it('/api/status unreachable on an rc.44 server → the probe simply succeeds', async () => {
        installFetchMock({ version: null, flavour: 'pat', loginBody: RC22_LOGIN_BODY });
        const result = await provisionNewCustomer({
            portal_user_id: PORTAL_USER_ID,
            email: EMAIL,
            newapi_group: 'test-group',
        });
        expect(find('GET', '/api/user/token')).toBeUndefined();
        expect(result.newapi_access_token).toBe('nap_freshPATvalue');
    });

    it('rc.44: a rejected password proof (403) propagates as NewApiError — no legacy fallback, no silent null', async () => {
        installFetchMock({
            version: 'v1.0.0-rc.44',
            flavour: 'pat',
            loginBody: RC22_LOGIN_BODY,
            verifyResponse: () => jsonResponse({ success: false, message: 'Verification failed' }, { status: 403 }),
        });

        await expect(
            provisionNewCustomer({ portal_user_id: PORTAL_USER_ID, email: EMAIL, newapi_group: 'test-group' }),
        ).rejects.toMatchObject({
            name: 'NewApiError',
            status: 403,
        });
        expect(find('GET', '/api/user/token')).toBeUndefined();
        expect(find('POST', '/api/user/access_tokens')).toBeUndefined();
    });

    it('rc.44: a create response without a nap_ token is an error, not a stored garbage credential', async () => {
        installFetchMock({ version: 'v1.0.0-rc.44', flavour: 'pat', loginBody: RC22_LOGIN_BODY });
        const original = globalThis.fetch as unknown as (
            input: URL | RequestInfo,
            init?: RequestInit,
        ) => Promise<Response>;
        vi.stubGlobal('fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = new URL(String(input));
            if (init?.method === 'POST' && url.pathname === '/api/user/access_tokens') {
                return jsonResponse({ success: true, message: '', data: { item: { id: 7 } } });
            }
            return original(input, init);
        });

        await expect(
            provisionNewCustomer({ portal_user_id: PORTAL_USER_ID, email: EMAIL, newapi_group: 'test-group' }),
        ).rejects.toBeInstanceOf(NewApiError);
    });
});

describe('accessTokenModeForVersion', () => {
    it.each([
        ['v1.0.0-rc.2', 'legacy'],
        ['v1.0.0-rc.22', 'legacy'],
        ['v1.0.0-rc.40', 'legacy'],
        ['v1.0.0-rc.41', 'pat'],
        ['v1.0.0-rc.44', 'pat'],
        ['v1.0.0', 'pat'],
        ['v1.0.1', 'pat'],
        ['v1.2.0-rc.3', 'pat'],
        ['v2.0.0', 'pat'],
        ['v0.9.9', 'legacy'],
        ['', 'probe'],
        [undefined, 'probe'],
        ['garbage', 'probe'],
    ] as const)('%s → %s', (version, expected) => {
        expect(accessTokenModeForVersion(version)).toBe(expected);
    });
});

describe('reissueCustomerAccessTokenViaAdminReset (pre-rc.41 customers, no stored password)', () => {
    it('admin proof → password reset → customer login → PAT, all on the same fresh password', async () => {
        const customerLoginPasswords: string[] = [];
        installFetchMock({
            version: 'v1.0.0-rc.44',
            flavour: 'pat',
            loginBody: RC22_LOGIN_BODY,
            adminLoginBody: ROOT_LOGIN_BODY,
            acceptPassword: undefined,
            customerLoginPasswords,
        });

        const result = await reissueCustomerAccessTokenViaAdminReset({
            admin: { session: { kind: 'bearer', jwt: 'root.session.jwt' }, userId: 1, password: 'root-pw' },
            customer: { userId: NEWAPI_USER_ID },
        });

        // 1. admin reads the customer (needed because PUT validates the whole struct)
        const read = find('GET', `/api/user/${NEWAPI_USER_ID}`);
        expect(read!.headers['authorization']).toBe('Bearer root.session.jwt');
        expect(read!.headers['new-api-user']).toBe('1');

        // 2. admin proof bound to this customer
        const verifies = all('POST', '/api/verify');
        expect(verifies[0].headers['authorization']).toBe('Bearer root.session.jwt');
        expect(verifies[0].body).toEqual({
            method: 'password',
            scope: 'admin.user.update',
            password: 'root-pw',
            context: { user_id: NEWAPI_USER_ID },
        });

        // 3. PUT carries the proof + the full user with a new 8-20 char password
        const put = find('PUT', '/api/user/');
        expect(put!.headers['x-security-proof']).toBe('proof-admin.user.update');
        expect(put!.body!.id).toBe(NEWAPI_USER_ID);
        expect(put!.body!.username).toBe(USERNAME);
        const newPassword = String(put!.body!.password);
        expect(newPassword.length).toBeGreaterThanOrEqual(8);
        expect(newPassword.length).toBeLessThanOrEqual(20);

        // 4. customer login + PAT proof reuse exactly that password
        expect(customerLoginPasswords).toEqual([newPassword]);
        expect(verifies[1].headers['authorization']).toBe('Bearer rc22.session.jwt');
        expect(verifies[1].body).toMatchObject({ scope: 'access_token.generate', password: newPassword });

        expect(result).toEqual({ accessToken: 'nap_freshPATvalue', username: USERNAME });
    });

    it('a PUT without a valid proof fails loudly (never silently keeps the legacy token)', async () => {
        installFetchMock({
            version: 'v1.0.0-rc.44',
            flavour: 'pat',
            loginBody: RC22_LOGIN_BODY,
            adminLoginBody: ROOT_LOGIN_BODY,
            verifyResponse: () => jsonResponse({ success: false, message: 'Verification failed' }, { status: 403 }),
        });
        await expect(
            reissueCustomerAccessTokenViaAdminReset({
                admin: { session: { kind: 'bearer', jwt: 'root.session.jwt' }, userId: 1, password: 'wrong' },
                customer: { userId: NEWAPI_USER_ID },
            }),
        ).rejects.toMatchObject({ name: 'NewApiError', status: 403 });
        expect(find('PUT', '/api/user/')).toBeUndefined();
    });

    it('preserves the rc.44 fix: excludes permission and server-managed echoes from the password reset PUT', async () => {
        installFetchMock({
            version: 'v1.0.0-rc.44',
            flavour: 'pat',
            loginBody: RC22_LOGIN_BODY,
            adminUserFields: {
                admin_permissions: { all: true },
                DeletedAt: 'server-value',
                original_password: 'old-test-secret',
                verification_code: 'temporary-test-code',
            },
        });
        await reissueCustomerAccessTokenViaAdminReset({
            admin: { session: { kind: 'bearer', jwt: 'root.session.jwt' }, userId: 1, password: 'root-pw' },
            customer: { userId: NEWAPI_USER_ID },
        });
        const put = find('PUT', '/api/user/')!;
        for (const field of ['admin_permissions', 'DeletedAt', 'original_password', 'verification_code'])
            expect(put.body).not.toHaveProperty(field);
        expect(all('POST', '/api/verify')[0].body).toMatchObject({
            scope: 'admin.user.update',
            context: { user_id: NEWAPI_USER_ID },
        });
        expect(put.body).toMatchObject({
            id: NEWAPI_USER_ID,
            username: USERNAME,
            role: 1,
            status: 1,
            group: 'default',
        });
    });
});
