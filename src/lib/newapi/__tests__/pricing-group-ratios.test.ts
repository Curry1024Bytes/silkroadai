import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPricingGroupRatiosForCustomer } from '../client';

const AUTH = { accessToken: 'nap_customer_pat', userId: 1907 };
let lastInit: RequestInit | undefined;
let lastUrl = '';

function stub(status: number, body: unknown) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL, init?: RequestInit) => {
            lastUrl = String(input);
            lastInit = init;
            return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
        }),
    );
}
beforeEach(() => {
    lastInit = undefined;
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('getPricingGroupRatiosForCustomer', () => {
    it('GETs /api/pricing as the customer (no Bearer) and returns the top-level numeric group_ratio', async () => {
        stub(200, {
            success: true,
            data: [{ model_name: 'x' }],
            group_ratio: { default: 1.3, 'oai image 2': 1.7, auto: 'auto' },
            usable_group: {},
        });
        const r = await getPricingGroupRatiosForCustomer(AUTH);
        expect(lastUrl).toMatch(/\/api\/pricing$/);
        const h = lastInit?.headers as Record<string, string>;
        expect(h.Authorization).toBe('nap_customer_pat');
        expect(h['New-Api-User']).toBe('1907');
        expect(r).toEqual({ default: 1.3, 'oai image 2': 1.7 });
    });

    it('throws NewApiError on 403 / success:false (caller falls back to global)', async () => {
        stub(403, { success: false, message: 'The access token lacks the required permission' });
        await expect(getPricingGroupRatiosForCustomer(AUTH)).rejects.toThrow(/lacks the required permission/);
        stub(200, { success: false, message: 'nope' });
        await expect(getPricingGroupRatiosForCustomer(AUTH)).rejects.toThrow(/nope/);
    });

    it('missing group_ratio → empty map (not a throw)', async () => {
        stub(200, { success: true, data: [] });
        expect(await getPricingGroupRatiosForCustomer(AUTH)).toEqual({});
    });
});
