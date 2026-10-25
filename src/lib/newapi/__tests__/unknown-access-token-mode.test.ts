import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAccessTokenModeCache, accessTokenModeForVersion, issueCustomerAccessToken } from '../client';

const args = {
    session: { kind: 'bearer' as const, jwt: 'customer.session.jwt' },
    userId: 42,
    password: 'fixture-customer-password',
};
const requests: {
    method: string;
    path: string;
    body: Record<string, unknown>;
    headers: Headers;
    init?: RequestInit;
}[] = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), { status });
interface Options {
    version?: string | null;
    modern?: boolean;
    catalogStatus?: number;
    catalogFailure?: Error;
    catalogData?: unknown;
    legacyProof?: boolean;
    legacyFailure?: Error;
    verifyStatus?: number;
    createFailure?: Error;
}
function setup(options: Options = {}) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = new URL(String(input)),
                method = init?.method ?? 'GET';
            const body = init?.body ? JSON.parse(String(init.body)) : {};
            const headers = new Headers(init?.headers);
            requests.push({ method, path: url.pathname, body, headers, init });
            if (url.pathname === '/api/status')
                return json({ version: options.version === undefined ? '' : options.version });
            if (method === 'GET' && url.pathname === '/api/user/access_tokens/catalog') {
                if (options.catalogFailure) throw options.catalogFailure;
                const status = options.catalogStatus ?? (options.modern ? 200 : 404);
                return json(
                    options.catalogData === undefined
                        ? { groups: [], max_tokens: 20, default_expiry_days: 90 }
                        : options.catalogData,
                    status,
                );
            }
            if (url.pathname === '/api/user/token') {
                if (options.legacyFailure) throw options.legacyFailure;
                if (options.legacyProof && !headers.has('x-security-proof'))
                    return new Response(JSON.stringify({ success: false, code: 'SECURITY_PROOF_REQUIRED' }), {
                        status: 403,
                    });
                return json('persistent-legacy-credential');
            }
            if (url.pathname === '/api/verify/methods')
                return json({
                    scope: 'access_token.generate',
                    password_encryption_enabled: false,
                    methods: [{ method: 'password', available: true }],
                });
            if (url.pathname === '/api/verify') {
                // Production custom legacy verifier rejects a PAT creation context.
                if (!options.modern && body.context) return json(null, 400);
                if (options.verifyStatus) return json(null, options.verifyStatus);
                return json({
                    proof_token: 'single-use-proof',
                    scope: 'access_token.generate',
                    method: 'password',
                    expires_at: Math.floor(Date.now() / 1000) + 60,
                });
            }
            if (method === 'POST' && url.pathname === '/api/user/access_tokens') {
                if (options.createFailure) throw options.createFailure;
                return json({ token: 'nap_new-persistent-credential' });
            }
            throw new Error(`Unexpected request ${method} ${url.pathname}`);
        }),
    );
}
const calls = (method: string, path: string) =>
    requests.filter((request) => request.method === method && request.path === path);
beforeEach(() => {
    requests.length = 0;
    _resetAccessTokenModeCache();
    vi.stubEnv('NEWAPI_ACCESS_TOKEN_MODE', 'auto');
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('unknown-version read-only PAT capability detection', () => {
    it.each(['', ' ', 'custom-build', 'v1.0.0-custom', null])(
        'does not infer PAT support from version %s',
        (version) => {
            expect(accessTokenModeForVersion(version)).toBe('probe');
        },
    );
    it.each([301, 404, 405])(
        'old service + empty version: catalog HTTP %s selects legacy without posting PAT verification',
        async (catalogStatus) => {
            setup({ catalogStatus });
            expect(await issueCustomerAccessToken(args)).toBe('persistent-legacy-credential');
            expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
                'GET /api/status',
                'GET /api/user/access_tokens/catalog',
                'GET /api/user/token',
            ]);
            expect(calls('GET', '/api/user/access_tokens')).toHaveLength(0);
            expect(calls('POST', '/api/verify')).toHaveLength(0);
            const probe = calls('GET', '/api/user/access_tokens/catalog')[0];
            expect(probe.headers.get('authorization')).toBe('Bearer customer.session.jwt');
            expect(probe.headers.get('new-api-user')).toBe('42');
            expect(probe.init).toMatchObject({ cache: 'no-store', redirect: 'manual' });
        },
    );
    it('empty version on a modern service probes first, then issues a PAT with the same customer session', async () => {
        setup({ modern: true });
        expect(await issueCustomerAccessToken(args)).toBe('nap_new-persistent-credential');
        expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
            'GET /api/status',
            'GET /api/user/access_tokens/catalog',
            'POST /api/verify',
            'POST /api/user/access_tokens',
        ]);
        expect(calls('GET', '/api/user/token')).toHaveLength(0);
    });
    it('empty-version legacy service retains the exact security-proof challenge flow without a PAT context', async () => {
        setup({ legacyProof: true });
        expect(await issueCustomerAccessToken(args)).toBe('persistent-legacy-credential');
        expect(calls('GET', '/api/user/token')).toHaveLength(2);
        expect(calls('GET', '/api/verify/methods')).toHaveLength(1);
        expect(calls('POST', '/api/verify')[0].body).toEqual({
            method: 'password',
            scope: 'access_token.generate',
            password: args.password,
        });
        expect(calls('GET', '/api/user/token')[1].headers.get('x-security-proof')).toBe('single-use-proof');
        expect(calls('POST', '/api/user/access_tokens')).toHaveLength(0);
    });
    it.each([400, 401, 403, 429, 500, 503])(
        'catalog HTTP %s is not permission to rotate or mint credentials',
        async (catalogStatus) => {
            setup({ catalogStatus });
            await expect(issueCustomerAccessToken(args)).rejects.toMatchObject({ status: catalogStatus });
            expect(requests).toHaveLength(2);
            expect(requests.every((request) => request.method === 'GET')).toBe(true);
            expect(calls('GET', '/api/user/token')).toHaveLength(0);
        },
    );
    it.each([new DOMException('timed out', 'TimeoutError'), new TypeError('connection reset')])(
        'a failed catalog connection does not rotate any credential: %s',
        async (catalogFailure) => {
            setup({ catalogFailure });
            await expect(issueCustomerAccessToken(args)).rejects.toThrow();
            expect(requests).toHaveLength(2);
            expect(calls('GET', '/api/user/token')).toHaveLength(0);
        },
    );
    it.each([null, {}, [], { groups: [], max_tokens: 0, default_expiry_days: 90 }])(
        'malformed catalog success is rejected without credential mutations: %j',
        async (catalogData) => {
            setup({ modern: true, catalogData });
            await expect(issueCustomerAccessToken(args)).rejects.toMatchObject({ status: 502 });
            expect(requests).toHaveLength(2);
        },
    );
    it.each([400, 403, 404])(
        'after a supported catalog, proof HTTP %s never falls back to rotating legacy',
        async (verifyStatus) => {
            setup({ modern: true, verifyStatus });
            await expect(issueCustomerAccessToken(args)).rejects.toMatchObject({ status: verifyStatus });
            expect(calls('POST', '/api/verify')).toHaveLength(1);
            expect(calls('GET', '/api/user/token')).toHaveLength(0);
            expect(calls('POST', '/api/user/access_tokens')).toHaveLength(0);
        },
    );
    it('does not replay or rotate after an ambiguous PAT creation timeout', async () => {
        setup({ modern: true, createFailure: new DOMException('timeout after acceptance', 'TimeoutError') });
        await expect(issueCustomerAccessToken(args)).rejects.toMatchObject({ status: 504 });
        expect(calls('POST', '/api/user/access_tokens')).toHaveLength(1);
        expect(calls('GET', '/api/user/token')).toHaveLength(0);
    });
    it('does not repeat legacy rotation after a timeout once the catalog is definitively absent', async () => {
        setup({ legacyFailure: new DOMException('rotation outcome unknown', 'TimeoutError') });
        await expect(issueCustomerAccessToken(args)).rejects.toMatchObject({ status: 504 });
        expect(calls('GET', '/api/user/token')).toHaveLength(1);
        expect(calls('POST', '/api/verify')).toHaveLength(0);
        expect(calls('POST', '/api/user/access_tokens')).toHaveLength(0);
    });
});
