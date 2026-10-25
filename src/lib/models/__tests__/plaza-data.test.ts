import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserCatalog } from '../catalog-browser-types';
const loadCatalog = vi.fn();
const fetchMock = vi.fn();
vi.mock('../catalog-browser', () => ({ loadBrowserCatalog: (...args: unknown[]) => loadCatalog(...args) }));
import { adaptPlazaCatalog, loadPlazaData } from '../plaza-data';
const catalog: BrowserCatalog = {
    tiers: [{ key: 'retail', label: '标准档', isDefault: true }],
    models: [
        {
            slug: 'gpt-5.5',
            pricesByTier: { retail: { input_cny_per_1m: 0, output_cny_per_1m: 3.6, per_image_cny: null } },
        },
    ],
};
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    loadCatalog.mockResolvedValue(catalog);
});
afterEach(() => vi.unstubAllGlobals());
describe('Portal plaza data boundary', () => {
    it('enriches matching models while excluding upstream catalog entries, pricing, internal groups and expressions', () => {
        const data = adaptPlazaCatalog(catalog, {
            success: true,
            vendors: [{ id: 99, name: 'OpenAI', icon: 'OpenAI' }],
            data: [
                {
                    model_name: 'gpt-5.5',
                    vendor_id: 99,
                    description: 'Verified description',
                    model_price: 999,
                    model_ratio: 999,
                    enable_groups: ['secret'],
                    billing_expr: 'secret()',
                    context_length: 272000,
                    supported_endpoint_types: ['openai'],
                },
                { model_name: 'hidden-model' },
            ],
            supported_endpoint: {
                openai: { path: '/v1/chat/completions', method: 'POST' },
                admin: { path: '/api/user' },
            },
            group_ratio: { secret: 0.01 },
            usable_group: { secret: { ratio: 0.01 } },
            auto_groups: ['secret'],
        });
        expect(data.data.map((model) => model.model_name)).toEqual(['gpt-5.5']);
        expect(data.data[0]).toMatchObject({
            description: 'Verified description',
            context_length: 272000,
            enable_groups: ['retail'],
            portal: { pricesByTier: catalog.models[0].pricesByTier },
        });
        expect(data.data[0]).not.toHaveProperty('model_ratio');
        expect(data.data[0]).not.toHaveProperty('model_price');
        expect(data.data[0]).not.toHaveProperty('billing_expr');
        expect(data.group_ratio).toEqual({});
        expect(data.auto_groups).toEqual([]);
        expect(JSON.stringify(data)).not.toContain('secret');
        expect(JSON.stringify(data)).not.toContain('hidden-model');
        expect(data.supported_endpoint).toEqual({ openai: { path: '/v1/chat/completions', method: 'POST' } });
    });
    it('preserves missing prices and rejects metadata endpoint URLs outside customer paths', () => {
        const missing = { ...catalog, models: [{ slug: 'gpt-5.5', pricesByTier: { retail: null } }] };
        const data = adaptPlazaCatalog(missing, {
            success: true,
            data: [{ model_name: 'gpt-5.5', supported_endpoint_types: ['openai'] }],
            supported_endpoint: { openai: { path: 'https://upstream.test/v1/chat/completions' } },
        });
        expect(data.data[0].portal?.pricesByTier.retail).toBeNull();
        expect(data.supported_endpoint).toEqual({});
        expect(data.data[0].supported_endpoint_types).toEqual([]);
    });
    it('uses the customer for catalog pricing and forwards identity only to optional descriptive metadata', async () => {
        const customer = { id: 'a', newapi_user_id: 12, newapi_access_token: 'test-token' };
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [] })));
        const data = await loadPlazaData(customer);
        expect(loadCatalog).toHaveBeenCalledWith('a');
        expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: 'test-token', 'New-Api-User': '12' });
        expect(data.data[0].portal?.pricesByTier.retail?.input_cny_per_1m).toBe(0);
        expect(data.portal_viewer_key).toBe('a');
    });
    it('does not replace a dedicated-price failure with public upstream prices', async () => {
        loadCatalog.mockRejectedValueOnce(new Error('Cannot verify dedicated customer price'));
        await expect(loadPlazaData({ id: 'a' })).rejects.toThrow('Cannot verify');
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('retains verified tariffs when optional metadata is unavailable without inventing capabilities', async () => {
        fetchMock.mockRejectedValueOnce(new Error('offline'));
        const data = await loadPlazaData(null);
        expect(data.data[0].portal?.pricesByTier).toEqual(catalog.models[0].pricesByTier);
        expect(data.data[0].description).toBeUndefined();
        expect(data.data[0].context_length).toBeUndefined();
        expect(data.data[0].capabilities).toBeUndefined();
        expect(data.data[0].supported_endpoint_types).toEqual([]);
    });
});
