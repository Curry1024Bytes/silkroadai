import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUsableGroupsForCustomer } from '../client';
afterEach(() => vi.unstubAllGlobals());
describe('customer-authorized group ratios client', () => {
    it('sends only the customer identity and validates an explicit successful response', async () => {
        const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
            expect(new Headers(init?.headers).get('authorization')).toBe('customer-secret');
            expect(new Headers(init?.headers).get('new-api-user')).toBe('42');
            expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
            return new Response(JSON.stringify({ success: true, data: { sale: { ratio: 0, desc: 'sale' } } }));
        });
        vi.stubGlobal('fetch', fetcher);
        expect(await getUsableGroupsForCustomer({ accessToken: 'customer-secret', userId: 42 })).toEqual({
            sale: { ratio: 0, desc: 'sale' },
        });
    });
    it.each([null, [], { sale: { ratio: -1 } }, { sale: { ratio: '0.5' } }, { sale: null }])(
        'rejects malformed or negative ratio metadata: %j',
        async (data) => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => new Response(JSON.stringify({ success: true, data }))),
            );
            await expect(getUsableGroupsForCustomer({ accessToken: 'customer-secret', userId: 42 })).rejects.toThrow();
        },
    );
    it('never retries an unauthorized customer read using an administrator', async () => {
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 403 }));
        vi.stubGlobal('fetch', fetcher);
        await expect(getUsableGroupsForCustomer({ accessToken: 'customer-secret', userId: 42 })).rejects.toThrow();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});
