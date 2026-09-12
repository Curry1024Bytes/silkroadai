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
    it('returns only allowlisted pricing metadata, never unrelated admin secrets', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    success: true,
                    data: [
                        { key: 'ModelRatio', value: '{"model":1}' },
                        { key: 'CompletionRatioMeta', value: '{}' },
                        { key: 'AnythingSecret', value: 'test-secret-sentinel' },
                    ],
                }),
            ),
        );
        const options = await getPricingPublishOptions();
        expect(options.ModelRatio).toBe('{"model":1}');
        expect(options.AnythingSecret).toBeUndefined();
        expect(JSON.stringify(options)).not.toContain('test-secret-sentinel');
    });
});
