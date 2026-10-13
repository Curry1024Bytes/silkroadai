import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewApiError, provisionNewCustomer } from '../client';

const loginJwt = 'customer.session.jwt';
const proofToken = 'single-use-proof';
const scope = 'access_token.generate';
const userId = 758;
const args = {
    portal_user_id: 'deadbeef-1111-4222-8333-444455556666',
    email: 'proof-test@example.invalid',
    newapi_group: 'GPT特惠反代',
};
const requests: {
    path: string;
    method: string;
    headers: Headers;
    body: Record<string, unknown>;
    init?: RequestInit;
}[] = [];

function setup(
    options: {
        initialStatus?: number;
        initialCode?: string;
        networkFailure?: boolean;
        policy?: unknown;
        proof?: unknown;
        verifyFailure?: boolean;
        retryFailure?: boolean;
        token?: unknown;
    } = {},
) {
    let rotations = 0;
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = new URL(String(input));
            const method = init?.method ?? 'GET';
            const headers = new Headers(init?.headers);
            const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
            requests.push({ path: url.pathname, method, headers, body, init });
            const response = (data: unknown, status = 200, success = true) =>
                new Response(JSON.stringify({ success, data }), { status });
            if (url.pathname === '/api/user/') return response(null);
            if (url.pathname === '/api/user/login')
                return response({ access_token: loginJwt, user: { id: userId, username: 'c-deadbeef', role: 1 } });
            if (url.pathname === '/api/user/token') {
                rotations++;
                if (options.networkFailure) throw new TypeError('fetch failed');
                if (rotations === 1 || options.retryFailure)
                    return new Response(
                        JSON.stringify({ success: false, code: options.initialCode ?? 'SECURITY_PROOF_REQUIRED' }),
                        { status: options.initialStatus ?? 403 },
                    );
                return response(options.token === undefined ? 'durable-credential' : options.token);
            }
            if (url.pathname === '/api/verify/methods') {
                expect(url.searchParams.get('scope')).toBe(scope);
                return response(
                    options.policy ?? {
                        scope,
                        password_encryption_enabled: false,
                        methods: [{ method: 'password', available: true }],
                    },
                );
            }
            if (url.pathname === '/api/verify') {
                if (options.verifyFailure)
                    return new Response(
                        JSON.stringify({ success: false, message: body.password, password: body.password }),
                        { status: 403 },
                    );
                return response(
                    options.proof === undefined
                        ? {
                              proof_token: proofToken,
                              scope,
                              method: 'password',
                              expires_at: Math.floor(Date.now() / 1000) + 60,
                          }
                        : options.proof,
                );
            }
            if (url.pathname === '/api/token/' && method === 'POST') return response(null);
            if (url.pathname === '/api/token/' && method === 'GET')
                return response({ items: [{ id: 1903, name: 'default-deadbeef' }], total: 1 });
            if (url.pathname === '/api/token/1903/key') return response({ key: 'sk-test-key' });
            throw new Error(`Unexpected request: ${method} ${url.pathname}`);
        }),
    );
}

beforeEach(() => {
    requests.length = 0;
    vi.stubEnv('NEWAPI_ADMIN_TOKEN', 'admin-credential');
    vi.stubEnv('NEWAPI_ADMIN_USER_ID', '1');
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('new-api provisioning security proof', () => {
    it('verifies the generated customer password with the same session and uses the proof exactly once', async () => {
        setup();
        const result = await provisionNewCustomer(args);
        const verification = requests.find((r) => r.path === '/api/verify')!;
        const created = requests.find((r) => r.path === '/api/user/')!;
        expect(verification.body).toEqual({ method: 'password', scope, password: created.body.password });
        const handshake = requests.filter((r) => r.path === '/api/user/token' || r.path.startsWith('/api/verify'));
        for (const request of handshake) {
            expect(request.headers.get('authorization')).toBe(loginJwt);
            expect(request.headers.get('new-api-user')).toBe(String(userId));
            expect(request.init).toMatchObject({ cache: 'no-store', redirect: 'error' });
            expect(request.init?.signal).toBeInstanceOf(AbortSignal);
        }
        const proofRequests = requests.filter((r) => r.headers.has('x-security-proof'));
        expect(proofRequests).toHaveLength(1);
        expect(proofRequests[0].path).toBe('/api/user/token');
        expect(proofRequests[0].headers.get('x-security-proof')).toBe(proofToken);
        expect(requests.filter((r) => r.path === '/api/user/token')).toHaveLength(2);
        for (const request of requests.filter((r) => r.path.startsWith('/api/token/'))) {
            expect(request.headers.get('authorization')).toBe('durable-credential');
            expect(request.headers.has('x-security-proof')).toBe(false);
        }
        expect(result.newapi_access_token).toBe('durable-credential');
        expect(requests.find((r) => r.path === '/api/token/' && r.method === 'POST')?.body).toMatchObject({
            group: args.newapi_group,
            unlimited_quota: true,
        });
    });

    it.each([
        [401, 'AUTH_UNAUTHORIZED'],
        [403, 'SECURITY_PROOF_INVALID'],
        [403, 'SECURITY_PROOF_EXPIRED'],
        [500, 'SECURITY_PROOF_REQUIRED'],
    ])('does not reinterpret %s / %s as a proof challenge', async (initialStatus, initialCode) => {
        setup({ initialStatus: initialStatus as number, initialCode: initialCode as string });
        await expect(provisionNewCustomer(args)).rejects.toBeInstanceOf(NewApiError);
        expect(requests.some((r) => r.path.startsWith('/api/verify'))).toBe(false);
    });

    it('does not retry token rotation after an ambiguous network failure', async () => {
        setup({ networkFailure: true });
        await expect(provisionNewCustomer(args)).rejects.toThrow('fetch failed');
        expect(requests.filter((r) => r.path === '/api/user/token')).toHaveLength(1);
    });

    it.each([
        { scope, password_encryption_enabled: false, methods: [{ method: '2fa', available: true }] },
        { scope, password_encryption_enabled: false, methods: [{ method: 'password', available: false }] },
        { scope, password_encryption_enabled: true, methods: [{ method: 'password', available: true }] },
        {
            scope: 'access_token.revoke',
            password_encryption_enabled: false,
            methods: [{ method: 'password', available: true }],
        },
    ])('honors the upstream verification policy without sending an unsupported password', async (policy) => {
        setup({ policy });
        await expect(provisionNewCustomer(args)).rejects.toThrow('Password verification is unavailable');
        expect(requests.some((r) => r.path === '/api/verify')).toBe(false);
    });

    it.each([
        null,
        { proof_token: '', scope, method: 'password', expires_at: 4_000_000_000 },
        { proof_token: proofToken, scope, method: 'password', expires_at: 1 },
        { proof_token: proofToken, scope: 'access_token.revoke', method: 'password', expires_at: 4_000_000_000 },
        { proof_token: proofToken, scope, method: 'session', expires_at: 4_000_000_000 },
    ])('rejects malformed, expired, or differently scoped proofs', async (proof) => {
        setup({ proof });
        await expect(provisionNewCustomer(args)).rejects.toThrow('Invalid provisioning security proof');
        expect(requests.filter((r) => r.path === '/api/user/token')).toHaveLength(1);
    });

    it('does not expose an upstream password echo when verification fails', async () => {
        setup({ verifyFailure: true });
        const error = await provisionNewCustomer(args).catch((e: unknown) => e);
        const password = String(requests.find((r) => r.path === '/api/user/')?.body.password);
        expect(error).toBeInstanceOf(NewApiError);
        expect(String(error)).not.toContain(password);
        expect((error as NewApiError).payload).toBeNull();
        expect(requests.some((r) => r.path === '/api/token/')).toBe(false);
    });

    it('does not loop when the protected operation rejects its proof', async () => {
        setup({ retryFailure: true });
        await expect(provisionNewCustomer(args)).rejects.toBeInstanceOf(NewApiError);
        expect(requests.filter((r) => r.path === '/api/verify')).toHaveLength(1);
        expect(requests.filter((r) => r.path === '/api/user/token')).toHaveLength(2);
    });

    it.each([null, '', loginJwt, 'different.session.jwt'])(
        'never persists an absent token or session JWT',
        async (token) => {
            setup({ token });
            await expect(provisionNewCustomer(args)).rejects.toThrow('Invalid persistent access token');
            expect(requests.some((r) => r.path === '/api/token/')).toBe(false);
        },
    );
});
