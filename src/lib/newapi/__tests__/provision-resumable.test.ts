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

function installFetch(
    tokensAfterCreate: unknown[],
    existingUsers: Array<{ id: number; username: string; email: string }> = [
        { id: USER_ID, username: USERNAME, email: 'customer@example.com' },
    ],
    options: { createUsernameRace?: boolean; deleteAlreadyGone?: boolean } = {},
) {
    let tokens: unknown[] = [];
    const users = [...existingUsers];
    const deleted: number[] = [];
    let created = false;
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
                createdUser = JSON.parse(String(init?.body)) as { username: string; email: string };
                if (options.createUsernameRace) {
                    users.push({ id: USER_ID, username: createdUser.username, email: createdUser.email });
                    return new Response(JSON.stringify({ success: false, message: 'duplicate username' }), {
                        status: 409,
                    });
                }
                return new Response(JSON.stringify({ success: true, data: null }));
            }
            if (method === 'POST' && url.pathname === '/api/user/login') {
                const username = createdUser?.username ?? USERNAME;
                return new Response(
                    JSON.stringify({
                        success: true,
                        data: {
                            access_token: 'session.jwt',
                            user: { id: USER_ID, username, role: 1 },
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
    return { deleted, wasCreated: () => created, createdUser: () => createdUser };
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
