import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPricingRuntimeModels } from '@/lib/newapi/client';

const fetchMock = vi.fn();
const expression = 'len < 272000 ? tier("base", p * 5 + c * 30 + cr * 0.5) : tier("tier_2", p * 10 + c * 45 + cr * 1)';
const model = (model_name = 'gpt-5.5') => ({
    model_name,
    quota_type: 0,
    model_ratio: 2.5,
    model_price: 0,
    completion_ratio: 6,
    enable_groups: ['enterprise'],
    cache_ratio: 0.1,
    billing_mode: 'tiered_expr',
    billing_expr: expression,
});
const respond = (data: unknown = [model()], group_ratio: unknown = { enterprise: 0.16 }) =>
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, data, group_ratio })));

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

describe('runtime pricing verification boundary', () => {
    it('reads the live model structures and top-level public group ratios with one bounded fresh GET', async () => {
        respond([{ ...model(), secret_metadata: 'must-not-return' }], { enterprise: 0.16 });
        expect(await getPricingRuntimeModels(['gpt-5.5'])).toEqual({
            models: [model()],
            group_ratio: { enterprise: 0.16 },
        });
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
        expect(String(url)).toMatch(/\/api\/pricing$/);
        expect(request).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error', credentials: 'omit' });
        expect(request.headers).not.toHaveProperty('Authorization');
        expect(request.headers).not.toHaveProperty('Cookie');
        expect(request.headers).not.toHaveProperty('New-Api-User');
        expect(request.signal).toBeInstanceOf(AbortSignal);
        expect(request.body).toBeUndefined();
    });
    it('does not require administrator credentials to read public runtime pricing', async () => {
        vi.stubEnv('NEWAPI_ADMIN_TOKEN', undefined);
        vi.stubEnv('NEWAPI_ADMIN_USER_ID', undefined);
        respond();
        expect((await getPricingRuntimeModels(['gpt-5.5'])).group_ratio).toEqual({ enterprise: 0.16 });
    });
    it('returns requested models in selection order without unrelated models or option fallbacks', async () => {
        respond([model('unrelated'), model('gpt-5.5'), model('second')]);
        const result = await getPricingRuntimeModels(['second', 'gpt-5.5']);
        expect(result.models.map((row) => row.model_name)).toEqual(['second', 'gpt-5.5']);
        expect(fetchMock).toHaveBeenCalledOnce();
    });
    it('preserves absent cache/mode fields separately from explicit zero ratios', async () => {
        const { cache_ratio, billing_mode, billing_expr, ...ordinary } = model();
        void cache_ratio;
        void billing_mode;
        void billing_expr;
        respond([{ ...ordinary, create_cache_ratio: 0 }], { enterprise: 0 });
        const result = await getPricingRuntimeModels(['gpt-5.5']);
        expect(result.models[0]).toEqual({ ...ordinary, create_cache_ratio: 0 });
        expect(Object.hasOwn(result.models[0], 'cache_ratio')).toBe(false);
        expect(Object.hasOwn(result.models[0], 'billing_mode')).toBe(false);
        expect(result.group_ratio).toEqual({ enterprise: 0 });
    });
    it('does not invent a visible model when the endpoint filters it out', async () => {
        respond([model('other')]);
        await expect(getPricingRuntimeModels(['gpt-5.5'])).rejects.toThrow(
            'Requested runtime pricing models are unavailable',
        );
        expect(fetchMock).toHaveBeenCalledOnce();
    });
    it.each([
        { names: [] },
        { names: [' '] },
        { names: [' gpt-5.5'] },
        { names: ['gpt-5.5', 'gpt-5.5'] },
        { names: Array.from({ length: 31 }, (_, i) => `model-${i}`) },
    ])('rejects invalid selections before requesting ($names)', async ({ names }) => {
        await expect(getPricingRuntimeModels(names)).rejects.toThrow('Invalid runtime pricing model selection');
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it.each([
        '<html>sign in</html>',
        '{}',
        '{"success":false}',
        '{"success":"true","data":[]}',
        '{"success":true,"data":[],"group_ratio":null}',
        '{"success":true,"data":null,"group_ratio":{}}',
    ])('rejects malformed or unacknowledged endpoint responses (%s)', async (body) => {
        fetchMock.mockResolvedValue(new Response(body));
        await expect(getPricingRuntimeModels(['gpt-5.5'])).rejects.toThrow();
        expect(fetchMock).toHaveBeenCalledOnce();
    });
    it.each([
        { quota_type: 2 },
        { model_ratio: '2.5' },
        { model_ratio: -1 },
        { model_price: null },
        { completion_ratio: -1 },
        { enable_groups: null },
        { enable_groups: [''] },
        { cache_ratio: null },
        { cache_ratio: '0.1' },
        { create_cache_ratio: -1 },
        { billing_mode: '' },
        { billing_expr: null },
        { billing_expr: ' ' },
    ])('rejects an incomplete runtime row (%j)', async (override) => {
        respond([{ ...model(), ...override }]);
        await expect(getPricingRuntimeModels(['gpt-5.5'])).rejects.toThrow('Invalid runtime pricing response');
    });
    it.each([
        { groups: null },
        { groups: [] },
        { groups: { enterprise: '0.16' } },
        { groups: { enterprise: -0.16 } },
        { groups: { ' ': 0.16 } },
    ])('rejects invalid group ratios ($groups)', async ({ groups }) => {
        respond([model()], groups);
        await expect(getPricingRuntimeModels(['gpt-5.5'])).rejects.toThrow('Invalid runtime pricing response');
    });
    it('rejects duplicate selected runtime models', async () => {
        respond([model(), model()]);
        await expect(getPricingRuntimeModels(['gpt-5.5'])).rejects.toThrow('Invalid runtime pricing response');
    });
    it('rereads every time and preserves exact expression strings for target comparison', async () => {
        respond();
        expect((await getPricingRuntimeModels(['gpt-5.5'])).models[0].billing_expr).toBe(expression);
        const changed = `(${expression}) * 2`;
        respond([{ ...model(), billing_expr: changed }]);
        expect((await getPricingRuntimeModels(['gpt-5.5'])).models[0].billing_expr).toBe(changed);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
