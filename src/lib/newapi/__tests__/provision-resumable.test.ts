import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { customerProvisioningUsername, provisionNewCustomerResumable } from '../client';

const PORTAL_USER_ID = 'deadbeef-1111-4222-8333-444455556666';
const USERNAME = `c-${PORTAL_USER_ID.slice(0, 8)}`;
const TOKEN_NAME = `default-${PORTAL_USER_ID.slice(0, 8)}`;
const USER_ID = 758;
const GROUP = 'GPT特惠反代';

function token(id: number, overrides: Record<string, unknown> = {}) {
    return {
        id,
        user_id: USER_ID,
        key: 'masked',
        status: 1,
        name: TOKEN_NAME,
        created_time: id,
        accessed_time: 0,
        expired_time: -1,
        remain_quota: 0,
        unlimited_quota: true,
        model_limits_enabled: false,
        model_limits: '',
        used_quota: 0,
        group: GROUP,
        ...overrides,
    };
}

describe('resumable provisioning with a customer pricing binding', () => {
    const binding = { group: 'auto', auto_groups: ['model-a', 'model-b'], cross_group_retry: false };
    const input = {
        portal_user_id: PORTAL_USER_ID,
        email: 'customer@example.com',
        newapi_group: GROUP,
        password: 'stable-password',
        token_binding: binding,
    };

    it('creates and confirms the native auto configuration while retaining the logical default group', async () => {
        installFetch([token(91, binding)]);
        await expect(provisionNewCustomerResumable(input)).resolves.toMatchObject({ newapi_token_id: 91 });
        const createCall = vi
            .mocked(fetch)
            .mock.calls.find(
                ([url, init]) => new URL(String(url)).pathname === '/api/token/' && init?.method === 'POST',
            );
        expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject(binding);
    });

    it('rejects a partially saved or broadened auto list before revealing the credential', async () => {
        installFetch([token(91, { ...binding, auto_groups: ['model-a'] })]);
        await expect(provisionNewCustomerResumable(input)).rejects.toMatchObject({ status: 409 });
        expect(vi.mocked(fetch).mock.calls.some(([url]) => new URL(String(url)).pathname === '/api/token/91/key')).toBe(
            false,
        );
    });
});

function installFetch(
    tokensAfterCreate: unknown[],
    existingUsers: Array<{ id: number; username: string; email: string }> = [
        { id: USER_ID, username: USERNAME, email: 'customer@example.com' },
    ],
    options: {
        createUsernameRace?: boolean;
        createResponseLost?: boolean;
        ignoreCreateEmail?: boolean;
        deleteAlreadyGone?: boolean;
        loginFailures?: number;
        expectedPassword?: string;
        loginUser?: { id?: number; username?: string; role?: number };
    } = {},
) {
    let tokens: unknown[] = [];
    const users = [...existingUsers];
    const deleted: number[] = [];
    let created = false;
    let loginFailures = options.loginFailures ?? 0;
    let userCreateCount = 0;
    let createdUser: { username: string; email: string } | undefined;
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = new URL(String(input));
            const method = init?.method ?? 'GET';
            if (method === 'GET' && url.pathname === '/api/user/search') {
                const keyword = url.searchParams.get('keyword') ?? '';
                const matches = users.filter((user) => user.username.includes(keyword));
                return new Response(
                    JSON.stringify({
                        success: true,
                        data: {
                            total: matches.length,
                            items: matches,
                        },
                    }),
                );
            }
            if (method === 'POST' && url.pathname === '/api/user/') {
                userCreateCount += 1;
                createdUser = JSON.parse(String(init?.body)) as { username: string; email: string };
                users.push({
                    id: USER_ID,
                    username: createdUser.username,
                    email: options.ignoreCreateEmail ? '' : createdUser.email,
                });
                if (options.createResponseLost) throw new TypeError('Create response lost');
                if (options.createUsernameRace) {
                    return new Response(JSON.stringify({ success: false, message: 'duplicate username' }), {
                        status: 409,
                    });
                }
                return new Response(JSON.stringify({ success: true, data: null }));
            }
            if (method === 'POST' && url.pathname === '/api/user/login') {
                const { username, password } = JSON.parse(String(init?.body)) as {
                    username: string;
                    password: string;
                };
                if (loginFailures > 0) {
                    loginFailures -= 1;
                    return new Response(JSON.stringify({ success: false, message: 'Login failed' }), {
                        status: 503,
                    });
                }
                if (password !== (options.expectedPassword ?? 'stable-password')) {
                    return new Response(JSON.stringify({ success: false, message: 'Login failed' }), {
                        status: 401,
                    });
                }
                return new Response(
                    JSON.stringify({
                        success: true,
                        data: {
                            access_token: 'session.jwt',
                            user: { id: USER_ID, username, role: 1, ...options.loginUser },
                        },
                    }),
                );
            }
            if (method === 'GET' && url.pathname === '/api/user/token') {
                return new Response(JSON.stringify({ success: true, data: 'durable-access-token' }));
            }
            if (method === 'GET' && url.pathname === '/api/token/') {
                return new Response(JSON.stringify({ success: true, data: { total: tokens.length, items: tokens } }));
            }
            if (method === 'POST' && url.pathname === '/api/token/') {
                created = true;
                tokens = tokensAfterCreate;
                return new Response(JSON.stringify({ success: true, data: null }));
            }
            if (method === 'DELETE' && url.pathname.startsWith('/api/token/')) {
                const id = Number(url.pathname.split('/').at(-1));
                deleted.push(id);
                tokens = tokens.filter((candidate) => (candidate as { id: number }).id !== id);
                if (options.deleteAlreadyGone) {
                    return new Response(JSON.stringify({ success: false, message: 'not found' }), { status: 404 });
                }
                return new Response(JSON.stringify({ success: true, data: null }));
            }
            if (method === 'POST' && url.pathname.endsWith('/key')) {
                return new Response(JSON.stringify({ success: true, data: { key: 'sk-default-key' } }));
            }
            throw new Error(`Unexpected request: ${method} ${url.pathname}`);
        }),
    );
    return {
        deleted,
        wasCreated: () => created,
        createdUser: () => createdUser,
        userCreateCount: () => userCreateCount,
    };
}

beforeEach(() => {
    vi.stubEnv('NEWAPI_ADMIN_TOKEN', 'admin-token');
    vi.stubEnv('NEWAPI_ADMIN_USER_ID', '1');
    vi.stubEnv('NEWAPI_ACCESS_TOKEN_MODE', 'legacy');
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

const args = {
    portal_user_id: PORTAL_USER_ID,
    email: 'customer@example.com',
    newapi_group: GROUP,
    password: 'stable-password',
};

describe('provisionNewCustomerResumable default token convergence', () => {
    it('uses a 20-character username with a 72-bit suffix namespace', () => {
        const username = customerProvisioningUsername(PORTAL_USER_ID);
        expect(username).toHaveLength(20);
        expect(username).toBe('c-deadbeef1111422283');
        expect(customerProvisioningUsername('deadbeef-9999-4222-8333-444455556666')).not.toBe(username);
    });

    it('creates new-api users with the long deterministic username', async () => {
        const state = installFetch([token(1)], []);

        const result = await provisionNewCustomerResumable(args);

        expect(state.createdUser()).toMatchObject({
            username: customerProvisioningUsername(PORTAL_USER_ID),
            email: args.email,
        });
        expect(result.newapi_username).toBe(customerProvisioningUsername(PORTAL_USER_ID));
    });

    it('reuses an exact matching user after a deterministic username create race', async () => {
        const state = installFetch([token(1)], [], { createUsernameRace: true });

        const result = await provisionNewCustomerResumable(args);

        expect(state.createdUser()?.username).toBe(customerProvisioningUsername(PORTAL_USER_ID));
        expect(result.newapi_username).toBe(customerProvisioningUsername(PORTAL_USER_ID));
        expect(vi.mocked(fetch)).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ method: 'POST' }));
    });

    it('resumes after creation succeeds without storing email and the first login fails', async () => {
        const state = installFetch([token(1)], [], { ignoreCreateEmail: true, loginFailures: 1 });

        await expect(provisionNewCustomerResumable(args)).rejects.toMatchObject({ status: 503 });
        expect(state.wasCreated()).toBe(false);
        const result = await provisionNewCustomerResumable(args);

        expect(result).toMatchObject({
            newapi_user_id: USER_ID,
            newapi_username: customerProvisioningUsername(PORTAL_USER_ID),
            newapi_token_id: 1,
        });
        expect(state.userCreateCount()).toBe(1);
    });

    it.each(['createUsernameRace', 'createResponseLost'] as const)(
        'authenticates an email-less create winner after %s before issuing credentials',
        async (failure) => {
            const state = installFetch([token(1)], [], { ignoreCreateEmail: true, [failure]: true });

            const result = await provisionNewCustomerResumable(args);

            expect(result.newapi_user_id).toBe(USER_ID);
            expect(state.userCreateCount()).toBe(1);
            expect(state.wasCreated()).toBe(true);
        },
    );

    it('does not adopt an email-less wide-name match without the original password', async () => {
        const state = installFetch(
            [token(1)],
            [{ id: USER_ID, username: customerProvisioningUsername(PORTAL_USER_ID), email: '' }],
            { expectedPassword: 'another-job-password' },
        );

        await expect(provisionNewCustomerResumable(args)).rejects.toMatchObject({ status: 401 });

        expect(state.wasCreated()).toBe(false);
        expect(state.userCreateCount()).toBe(0);
        expect(
            vi.mocked(fetch).mock.calls.some(([input]) => new URL(String(input)).pathname === '/api/user/token'),
        ).toBe(false);
    });

    it.each([{ id: USER_ID + 1 }, { username: 'another-user' }, { role: 10 }])(
        'rejects authenticated identity mismatch %j before issuing credentials',
        async (loginUser) => {
            const state = installFetch(
                [token(1)],
                [{ id: USER_ID, username: customerProvisioningUsername(PORTAL_USER_ID), email: '' }],
                { loginUser },
            );

            await expect(provisionNewCustomerResumable(args)).rejects.toMatchObject({ status: 409 });

            expect(state.wasCreated()).toBe(false);
            expect(
                vi.mocked(fetch).mock.calls.some(([input]) => new URL(String(input)).pathname === '/api/user/token'),
            ).toBe(false);
        },
    );

    it('rejects a conflicting non-empty email before trying its password', async () => {
        const state = installFetch(
            [token(1)],
            [{ id: USER_ID, username: customerProvisioningUsername(PORTAL_USER_ID), email: 'other@example.com' }],
        );

        await expect(provisionNewCustomerResumable(args)).rejects.toMatchObject({ status: 409 });

        expect(state.userCreateCount()).toBe(0);
        expect(
            vi.mocked(fetch).mock.calls.some(([input]) => new URL(String(input)).pathname === '/api/user/login'),
        ).toBe(false);
    });

    it('does not reuse an email-less legacy short-name collision', async () => {
        const state = installFetch([token(1)], [{ id: USER_ID + 1, username: USERNAME, email: '' }]);

        const result = await provisionNewCustomerResumable(args);

        expect(state.userCreateCount()).toBe(1);
        expect(result.newapi_username).toBe(customerProvisioningUsername(PORTAL_USER_ID));
    });

    it('deletes duplicate deterministic keys and returns the oldest valid key', async () => {
        const state = installFetch([token(1), token(2)]);

        const result = await provisionNewCustomerResumable(args);

        expect(state.wasCreated()).toBe(true);
        expect(state.deleted).toEqual([2]);
        expect(result.newapi_token_id).toBe(1);
        expect(result.newapi_token_value).toBe('sk-default-key');
    });

    it('re-lists duplicate keys when another retry already deleted one', async () => {
        const state = installFetch([token(1), token(2)], undefined, { deleteAlreadyGone: true });

        const result = await provisionNewCustomerResumable(args);

        expect(state.deleted).toEqual([2]);
        expect(result.newapi_token_id).toBe(1);
    });

    it('fails closed when duplicate deterministic keys contain a mismatched configuration', async () => {
        const state = installFetch([token(1), token(2, { group: 'wrong-group' })]);

        await expect(provisionNewCustomerResumable(args)).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining('configuration mismatch'),
        });
        expect(state.deleted).toEqual([]);
    });
});
