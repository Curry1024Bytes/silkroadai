/**
 * updateTokenForCustomer — new-api PUT /api/token/ is a FULL overwrite, so the
 * client must GET the existing token and merge the patch (same contract as
 * renameToken). Guards the "only the patched fields change" invariant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateTokenForCustomer } from '../client';

const CUSTOMER_AUTH = { accessToken: 'cust-access-token', userId: 42 };
const EXISTING = {
    id: 99,
    user_id: 42,
    key: 'sk-masked****',
    status: 1,
    name: 'prod',
    created_time: 1,
    accessed_time: 1,
    expired_time: -1,
    remain_quota: 123456,
    unlimited_quota: true,
    model_limits_enabled: false,
    model_limits: '',
    allow_ips: '1.2.3.4',
    used_quota: 123,
    group: 'official',
};
type Call = { method: string; path: string; body: unknown };
let calls: Call[];

beforeEach(() => {
    calls = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            const method = init?.method ?? 'GET';
            const body = init?.body ? JSON.parse(String(init.body)) : undefined;
            calls.push({ method, path: url.pathname, body });
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

describe('updateTokenForCustomer', () => {
    it('set quota: GET then PUT full object with unlimited_quota=false + absolute remain_quota, nothing else changed', async () => {
        await updateTokenForCustomer(CUSTOMER_AUTH, 99, { unlimited_quota: false, remain_quota: 6_944_444 });
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/token/99', 'PUT /api/token/']);
        expect(calls[1].body).toEqual({ ...EXISTING, unlimited_quota: false, remain_quota: 6_944_444 });
    });

    it('cancel quota: only flips unlimited_quota, remain_quota keeps its stored value', async () => {
        await updateTokenForCustomer(CUSTOMER_AUTH, 99, { unlimited_quota: true });
        expect(calls[1].body).toEqual({ ...EXISTING, unlimited_quota: true });
        expect((calls[1].body as { remain_quota: number }).remain_quota).toBe(123456);
    });

    it('expiry + rename in one PUT; group / allow_ips / model_limits untouched', async () => {
        await updateTokenForCustomer(CUSTOMER_AUTH, 99, { expired_time: 1_800_000_000, name: 'renamed' });
        const put = calls[1].body as Record<string, unknown>;
        expect(put).toEqual({ ...EXISTING, expired_time: 1_800_000_000, name: 'renamed' });
        expect(put.group).toBe('official');
        expect(put.allow_ips).toBe('1.2.3.4');
    });

    it('throws (and never PUTs) when the GET fails', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify({ success: false, message: '无权' }), { status: 200 })),
        );
        await expect(updateTokenForCustomer(CUSTOMER_AUTH, 99, { unlimited_quota: true })).rejects.toThrow();
    });
});
