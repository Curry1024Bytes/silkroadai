import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { resolveAdmin, previewGlobalModelPricing, enqueueGlobalModelPricing } = vi.hoisted(() => ({
    resolveAdmin: vi.fn(),
    previewGlobalModelPricing: vi.fn(),
    enqueueGlobalModelPricing: vi.fn(),
}));

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin }));
vi.mock('@/lib/admin-auth', () => ({ unauthorizedResponse: () => new Response(null, { status: 401 }) }));
vi.mock('@/lib/admin/pricing-publish', () => ({
    enqueueGlobalModelPricing,
    previewGlobalModelPricing,
    pricingPublishErrorResponse: (error: unknown) => ({
        status: 500,
        body: { error: 'internal_error', message: String(error) },
    }),
    readPublishSource: vi.fn(),
    readPublishState: vi.fn(),
}));
vi.mock('@/lib/admin/global-model-pricing', () => ({ listGlobalModelPrices: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { POST } from '../global-model/route';

const admin = { user: { id: 'admin-1' }, tenant_id: 'tenant-1' };
const modelId = '11111111-1111-4111-8111-111111111111';
const quote = {
    upstream_model: 'gpt-5.5',
    provider: 'openai',
    source: 'litellm',
    source_label: 'LiteLLM model prices',
    fetched_at: '2026-09-24T00:00:00.000Z',
    input_usd_per_1m: 1,
    output_usd_per_1m: 2,
    cache_read_usd_per_1m: null,
    cache_write_5m_usd_per_1m: null,
    cache_write_1h_usd_per_1m: null,
    usd_to_cny_rate: 7,
    input_cny_per_1m: 7,
    output_cny_per_1m: 14,
    cache_read_cny_per_1m: null,
    cache_write_5m_cny_per_1m: null,
    cache_write_1h_cny_per_1m: null,
};

function req(body: unknown): NextRequest {
    return new NextRequest('http://internal/api/admin/pricing/global-model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    resolveAdmin.mockResolvedValue(admin);
    previewGlobalModelPricing.mockResolvedValue({ preview_token: 'preview-token', rows: [], warnings: [] });
    enqueueGlobalModelPricing.mockResolvedValue({ id: 'job-1', status: 'queued' });
});

describe('POST /api/admin/pricing/global-model', () => {
    it('previews a catalog quote using only the model ID', async () => {
        const response = await POST(req({ action: 'preview', model_id: modelId }));

        expect(response.status).toBe(200);
        expect(previewGlobalModelPricing).toHaveBeenCalledWith({ model_id: modelId }, admin);
        expect(enqueueGlobalModelPricing).not.toHaveBeenCalled();
    });

    it('rejects manual price fields on a query-only preview', async () => {
        const response = await POST(req({ action: 'preview', model_id: modelId, base_per_image_cny: 0.5 }));

        expect(response.status).toBe(400);
        expect(previewGlobalModelPricing).not.toHaveBeenCalled();
    });

    it('publishes with the signed quote snapshot and normalized global input', async () => {
        const response = await POST(
            req({
                action: 'publish',
                preview_token: 'preview-token',
                model_id: modelId,
                base_input_cny_per_1m: null,
                base_output_cny_per_1m: null,
                base_per_image_cny: null,
                official_quote: quote,
            }),
        );

        expect(response.status).toBe(202);
        expect(enqueueGlobalModelPricing).toHaveBeenCalledWith(
            {
                model_id: modelId,
                base_input_cny_per_1m: null,
                base_output_cny_per_1m: null,
                base_per_image_cny: null,
                official_quote: quote,
            },
            'preview-token',
            admin,
        );
    });
});
