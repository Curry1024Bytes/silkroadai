import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPricingPublishOptions, putPricingPublishOption } from '@/lib/newapi/client';

const fetchMock = vi.fn();
beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    vi.stubEnv('NEWAPI_ADMIN_TOKEN', 'test-only-admin-token');
    vi.stubEnv('NEWAPI_ADMIN_USER_ID', '1');
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('publication management acknowledgement', () => {
    it.each([
        ['HTML with HTTP 200', '<html>gateway sign in</html>'],
        ['missing envelope', '{}'],
        ['rejected application result', '{"success":false,"message":"rejected"}'],
        ['non-boolean success', '{"success":"yes"}'],
    ])('does not acknowledge %s', async (_name, body) => {
        fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
        await expect(putPricingPublishOption('ModelRatio', '{}')).rejects.toThrow();
    });
    it('acknowledges only explicit success and sends one bounded PUT', async () => {
        fetchMock.mockResolvedValue(new Response('{"success":true}', { status: 200 }));
        await expect(putPricingPublishOption('ModelPrice', '{"model":1}')).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const request = fetchMock.mock.calls[0][1] as RequestInit;
        expect(request.method).toBe('PUT');
        expect(request.signal).toBeInstanceOf(AbortSignal);
        expect(JSON.parse(String(request.body))).toEqual({ key: 'ModelPrice', value: '{"model":1}' });
    });
    it('writes only the expression dictionary for tiered publication', async () => {
        const value = JSON.stringify({ 'gpt-5.5': 'tier("base", p * 8 + c * 48 + cr * 0.8)' });
        fetchMock.mockResolvedValue(new Response('{"success":true}', { status: 200 }));
        await expect(putPricingPublishOption('billing_setting.billing_expr', value)).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
            key: 'billing_setting.billing_expr',
            value,
        });
    });
    it.each(['billing_setting.billing_mode', 'GroupRatio', 'GroupGroupRatio', 'CacheRatio', 'CreateCacheRatio'])(
        'refuses an unsupported publication write before fetching: %s',
        async (key) => {
            await expect(
                putPricingPublishOption(key as Parameters<typeof putPricingPublishOption>[0], '{}'),
            ).rejects.toThrow('Unsupported pricing publication option');
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );
    it('returns only allowlisted pricing metadata, never unrelated admin secrets', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    success: true,
                    data: [
                        { key: 'ModelRatio', value: '{"model":1}' },
                        { key: 'CompletionRatioMeta', value: '{}' },
                        { key: 'billing_setting.billing_expr', value: JSON.stringify({ model: 'tier("base", p)' }) },
                        { key: 'billing_setting.billing_mode', value: '{"model":"tiered_expr"}' },
                        { key: 'billing_setting.scheduled_discount', value: '{}' },
                        { key: 'AnythingSecret', value: 'test-secret-sentinel' },
                    ],
                }),
            ),
        );
        const options = await getPricingPublishOptions();
        expect(options.ModelRatio).toBe('{"model":1}');
        expect(options['billing_setting.billing_expr']).toBe(JSON.stringify({ model: 'tier("base", p)' }));
        expect(options['billing_setting.billing_mode']).toBe('{"model":"tiered_expr"}');
        expect(options['billing_setting.scheduled_discount']).toBe('{}');
        expect(options.AnythingSecret).toBeUndefined();
        expect(JSON.stringify(options)).not.toContain('test-secret-sentinel');
    });
    it.each(['array', 'object'])(
        'preserves absent optional keys and explicit null separately in %s responses',
        async (shape) => {
            const row = { key: 'ImageResolutionPrice', value: null };
            fetchMock.mockResolvedValue(
                new Response(
                    JSON.stringify({
                        success: true,
                        data: shape === 'array' ? [row] : { [row.key]: row.value },
                    }),
                ),
            );
            const options = await getPricingPublishOptions();
            expect(Object.hasOwn(options, 'ImageResolutionPrice')).toBe(true);
            expect(options.ImageResolutionPrice).toBeNull();
            expect(Object.hasOwn(options, 'billing_setting.scheduled_discount')).toBe(false);
            expect(Object.hasOwn(options, 'ModelRatio')).toBe(false);
        },
    );
});
