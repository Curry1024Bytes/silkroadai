/**
 * renameToken — new-api `PUT /api/token/` is a FULL overwrite (not partial).
 * The helper must GET the existing token and send it back with only `name`
 * changed, otherwise `unlimited_quota` flips to false and the key is
 * rejected as exhausted (gotcha #12). No real network — global fetch mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renameToken } from '../client';

const CUSTOMER_AUTH = { accessToken: 'cust-access-token', userId: 42 };
const EXISTING = {
    id: 99,
    user_id: 42,
    key: 'sk-masked****',
    status: 1,
    name: 'old-name',
    created_time: 1,
    accessed_time: 1,
    expired_time: -1,
    remain_quota: 0,
    unlimited_quota: true,
    model_limits_enabled: false,
    model_limits: '',
    allow_ips: '1.2.3.4',
    used_quota: 123,
    group: 'official',
};

type Call = { method: string; path: string; headers: Record<string, string>; body: unknown };
let calls: Call[];

beforeEach(() => {
    calls = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            const method = init?.method ?? 'GET';
            const headers = (init?.headers ?? {}) as Record<string, string>;
            const body = init?.body ? JSON.parse(String(init.body)) : undefined;
            calls.push({ method, path: url.pathname, headers, body });
            if (method === 'GET' && url.pathname === '/api/token/99') {
                return new Response(JSON.stringify({ success: true, message: '', data: EXISTING }), { status: 200 });
            }
            if (method === 'PUT' && url.pathname === '/api/token/') {
                return new Response(JSON.stringify({ success: true, message: '', data: null }), { status: 200 });
            }
            throw new Error(`fetch mock: unexpected ${method} ${url.pathname}`);
        }),
    );
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('renameToken', () => {
    it('GETs the existing token as the customer, then PUTs the full object with only name changed', async () => {
        await renameToken(CUSTOMER_AUTH, 99, 'new-name');

        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/token/99', 'PUT /api/token/']);
        for (const c of calls) {
            expect(c.headers.Authorization).toBe('cust-access-token');
            expect(c.headers['New-Api-User']).toBe('42');
        }
        const put = calls[1].body as Record<string, unknown>;
        expect(put).toEqual({ ...EXISTING, name: 'new-name' });
        // The gotcha #12 guard: these must survive the round-trip untouched.
        expect(put.unlimited_quota).toBe(true);
        expect(put.expired_time).toBe(-1);
        expect(put.group).toBe('official');
        expect(put.allow_ips).toBe('1.2.3.4');
    });

    it('throws (and never PUTs) when the GET fails', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify({ success: false, message: '无权' }), { status: 200 })),
        );
        await expect(renameToken(CUSTOMER_AUTH, 99, 'x')).rejects.toThrow();
    });
});
