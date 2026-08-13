import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockGetCatalog = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...args: unknown[]) => mockResolveAdmin(...args) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/admin/litellm-official-prices', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/admin/litellm-official-prices')>();
    return { ...actual, getLiteLlmPriceCatalog: (...args: unknown[]) => mockGetCatalog(...args) };
});

import { GET } from '@/app/api/admin/pricing-calculator/official-prices/route';

const CATALOG = {
    source: 'litellm-cdn',
    sourceLabel: 'LiteLLM CDN',
    fetchedAt: '2026-08-13T00:00:00.000Z',
    models: [
        {
            model: 'claude-fable-5',
            provider: 'anthropic',
            inputUsdPer1m: 10,
            outputUsdPer1m: 50,
            cacheReadUsdPer1m: 1,
            cacheWrite5mUsdPer1m: 12.5,
            cacheWrite1hUsdPer1m: 20,
        },
    ],
};

function req(q = 'claude-fable-5') {
    return new NextRequest(
        `https://example.test/api/admin/pricing-calculator/official-prices?q=${encodeURIComponent(q)}`,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue({ role: 'superadmin' });
    mockGetCatalog.mockResolvedValue(CATALOG);
});

describe('GET /api/admin/pricing-calculator/official-prices', () => {
    it('requires superadmin access', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await GET(req())).status).toBe(401);
        expect(mockGetCatalog).not.toHaveBeenCalled();
    });

    it('returns a narrow normalized result from the service-side catalog', async () => {
        const response = await GET(req());
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        await expect(response.json()).resolves.toMatchObject({
            source: 'litellm-cdn',
            models: [{ model: 'claude-fable-5', cacheWrite5mUsdPer1m: 12.5 }],
        });
    });

    it('rejects an empty model query before fetching external data', async () => {
        const response = await GET(req(''));
        expect(response.status).toBe(400);
        expect(mockGetCatalog).not.toHaveBeenCalled();
    });
});
