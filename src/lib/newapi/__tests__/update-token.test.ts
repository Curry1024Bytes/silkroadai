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

    it.each([null, { id: 99 }, { ...EXISTING, user_id: 43 }, { ...EXISTING, id: 100 }])(
        'never overwrites settings when a GET returns missing or mismatched ownership metadata: %j',
        async (payload) => {
            const fetcher = vi.fn(
                async () => new Response(JSON.stringify({ success: true, data: payload }), { status: 200 }),
            );
            vi.stubGlobal('fetch', fetcher);
            await expect(updateTokenForCustomer(CUSTOMER_AUTH, 99, { expired_time: -1 })).rejects.toThrow(
                'Unconfirmed customer token metadata',
            );
            expect(fetcher).toHaveBeenCalledTimes(1);
        },
    );

    it.each([
        [3, { expired_time: 4_000_000_000 }],
        [4, { unlimited_quota: true }],
    ])('saves settings for automatic status %s without reactivating the Key', async (status, patch) => {
        let current = {
            ...EXISTING,
            status: status as number,
            unlimited_quota: status === 3,
            remain_quota: 0,
            expired_time: status === 3 ? 1 : -1,
        };
        const operations: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string | URL, init?: RequestInit) => {
                const url = new URL(String(input));
                const method = init?.method ?? 'GET';
                operations.push(`${method} ${url.pathname}${url.search}`);
                if (method === 'PUT') {
                    expect(url.searchParams.has('status_only')).toBe(false);
                    const originalStatus = current.status;
                    current = { ...current, ...JSON.parse(String(init?.body)), status: originalStatus };
                }
                return new Response(JSON.stringify({ success: true, data: method === 'GET' ? current : null }));
            }),
        );
        const result = await updateTokenForCustomer(
            CUSTOMER_AUTH,
            99,
            patch as { expired_time?: number; unlimited_quota?: boolean },
        );
        expect(result).toEqual({ requiresReactivation: true });
        expect(current.status).toBe(status);
        expect(operations).toEqual(['GET /api/token/99', 'PUT /api/token/']);
    });

    it('never enables an explicitly disabled token and reports that saving expiry does not restore it', async () => {
        const requests: URL[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string | URL, init?: RequestInit) => {
                const url = new URL(String(input));
                requests.push(url);
                return new Response(
                    JSON.stringify({ success: true, data: init?.method === 'GET' ? { ...EXISTING, status: 2 } : null }),
                );
            }),
        );
        expect(await updateTokenForCustomer(CUSTOMER_AUTH, 99, { expired_time: 4_000_000_000 })).toEqual({
            requiresReactivation: true,
        });
        expect(requests).toHaveLength(2);
        expect(requests.some((url) => url.searchParams.has('status_only'))).toBe(false);
    });

    it('preserves an external operator disable after the last status read, without any status-only write', async () => {
        let current = { ...EXISTING, status: 3, expired_time: 1 };
        const operations: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string | URL, init?: RequestInit) => {
                const url = new URL(String(input));
                const method = init?.method ?? 'GET';
                operations.push(`${method} ${url.pathname}${url.search}`);
                if (method === 'GET') {
                    const staleSnapshot = { ...current };
                    // The operator uses new-api directly after our read, outside the Portal mutex.
                    current.status = 2;
                    return new Response(JSON.stringify({ success: true, data: staleSnapshot }));
                }
                const body = JSON.parse(String(init?.body));
                if (url.searchParams.has('status_only')) current.status = body.status;
                else {
                    // Mirrors new-api: an ordinary settings PUT never mutates status.
                    const priorStatus = current.status;
                    current = { ...current, ...body, status: priorStatus };
                }
                return new Response(JSON.stringify({ success: true, data: null }));
            }),
        );
        expect(await updateTokenForCustomer(CUSTOMER_AUTH, 99, { expired_time: 4_000_000_000 })).toEqual({
            requiresReactivation: true,
        });
        expect(current.expired_time).toBe(4_000_000_000);
        expect(current.status).toBe(2);
        expect(operations).toEqual(['GET /api/token/99', 'PUT /api/token/']);
        expect(operations.some((value) => value.includes('status_only'))).toBe(false);
    });
});
