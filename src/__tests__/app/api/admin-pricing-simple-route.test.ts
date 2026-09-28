import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const m = vi.hoisted(() => ({
    auth: vi.fn(),
    load: vi.fn(),
    previewTier: vi.fn(),
    previewModel: vi.fn(),
    saveTier: vi.fn(),
    saveModel: vi.fn(),
    resync: vi.fn(),
    verify: vi.fn(),
    savePurchase: vi.fn(),
    lookup: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: m.auth }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/admin/pricing-publish', () => ({
    pricingPublishErrorResponse: (error: { code?: string; message?: string; status?: number }) => ({
        status: error.status ?? 500,
        body: { error: error.code ?? 'pricing_error', message: error.message ?? 'error' },
    }),
}));
vi.mock('@/lib/admin/pricing-simple', () => ({
    loadSimplePricing: m.load,
    previewTier: m.previewTier,
    previewModel: m.previewModel,
    saveTier: m.saveTier,
    saveModel: m.saveModel,
    resyncCatalog: m.resync,
    verifyRuntime: m.verify,
    savePurchaseRate: m.savePurchase,
    lookupBillLog: m.lookup,
}));

import { GET, POST } from '@/app/api/admin/pricing/simple/route';
import { SimplePricingError } from '@/lib/admin/pricing-simple-core';

const GROUP = '11111111-1111-4111-8111-111111111111';
const admin = { user: { id: 'u1' }, role: 'superadmin', tenant_id: null, viaBreakGlass: false };
const req = (body: unknown) =>
    new NextRequest('http://localhost/api/admin/pricing/simple', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
        body: JSON.stringify(body),
    });
const token = { mode: 'token', input: 5, output: 40, cache_read: null, cache_write: null };

beforeEach(() => {
    vi.clearAllMocks();
    m.auth.mockResolvedValue(admin);
});

describe('/api/admin/pricing/simple', () => {
    it('requires superadmin', async () => {
        m.auth.mockResolvedValue(null);
        expect((await GET(new NextRequest('http://localhost/api/admin/pricing/simple'))).status).toBe(401);
        expect((await POST(req({ action: 'resync_catalog' }))).status).toBe(401);
        expect(m.auth).toHaveBeenCalledWith(expect.anything(), 'superadmin');
        expect(m.resync).not.toHaveBeenCalled();
    });

    it('returns the view without caching', async () => {
        m.load.mockResolvedValue({ tiers: [] });
        const response = await GET(new NextRequest('http://localhost/api/admin/pricing/simple'));
        expect(await response.json()).toEqual({ tiers: [] });
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });

    it('dispatches each action', async () => {
        m.previewTier.mockResolvedValue({ unchanged: true });
        m.saveTier.mockResolvedValue({ catalog_rows: 1 });
        m.previewModel.mockResolvedValue({ unchanged: false });
        m.saveModel.mockResolvedValue({ catalog_rows: 2 });
        m.verify.mockResolvedValue({ models: [], groups: [] });

        expect(await (await POST(req({ action: 'preview_tier', group_id: GROUP, ratio: 2.4 }))).json()).toEqual({
            preview: { unchanged: true },
        });
        await POST(req({ action: 'save_tier', group_id: GROUP, ratio: 2.4, expected_ratio: null }));
        expect(m.saveTier).toHaveBeenCalledWith(
            expect.objectContaining({ admin, userAgent: 'vitest' }),
            GROUP,
            2.4,
            null,
        );
        await POST(req({ action: 'preview_model', model: 'gpt-5.5', base: token }));
        expect(m.previewModel).toHaveBeenCalledWith(admin, 'gpt-5.5', token);
        expect(
            await (
                await POST(req({ action: 'save_model', model: 'gpt-5.5', base: token, expected_state: 's' }))
            ).json(),
        ).toEqual({ result: { catalog_rows: 2 } });
        expect(await (await POST(req({ action: 'verify_runtime', models: ['gpt-5.5'] }))).json()).toEqual({
            check: { models: [], groups: [] },
        });
    });

    it('saves a purchase rate and looks up a log', async () => {
        m.savePurchase.mockResolvedValue({ purchase_rate: 0.3 });
        m.lookup.mockResolvedValue({ tier: 'pool' });
        expect(
            await (await POST(req({ action: 'save_purchase_rate', group_id: GROUP, purchase_rate: 0.3 }))).json(),
        ).toEqual({ result: { purchase_rate: 0.3 } });
        expect(m.savePurchase).toHaveBeenCalledWith(expect.objectContaining({ admin }), GROUP, 0.3);
        await POST(req({ action: 'save_purchase_rate', group_id: GROUP, purchase_rate: null }));
        expect(m.savePurchase).toHaveBeenLastCalledWith(expect.anything(), GROUP, null);

        const response = await POST(req({ action: 'lookup_log', request_id: '  req_1-a  ' }));
        expect(await response.json()).toEqual({ lookup: { tier: 'pool' } });
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(m.lookup).toHaveBeenCalledWith(admin, 'req_1-a');
    });

    it('rejects malformed input before touching the service', async () => {
        for (const body of [
            { action: 'save_tier', group_id: GROUP, ratio: 0, expected_ratio: 1 },
            { action: 'save_model', model: 'gpt-5.5', base: { ...token, input: 0 }, expected_state: 's' },
            { action: 'preview_model', model: 'x', base: token, extra: 1 },
            { action: 'verify_runtime', models: [] },
            { action: 'save_purchase_rate', group_id: 'not-a-uuid', purchase_rate: 1 },
            { action: 'save_purchase_rate', group_id: GROUP, purchase_rate: -1 },
            { action: 'lookup_log', request_id: '' },
            { action: 'lookup_log', request_id: 'bad id;drop' },
            { action: 'unknown' },
        ]) {
            const response = await POST(req(body));
            expect(response.status).toBe(400);
            expect((await response.json()).error).toBe('invalid_input');
        }
        expect(m.saveTier).not.toHaveBeenCalled();
        expect(m.saveModel).not.toHaveBeenCalled();
        expect(m.savePurchase).not.toHaveBeenCalled();
        expect(m.lookup).not.toHaveBeenCalled();
    });

    it('maps service errors to their status', async () => {
        m.previewModel.mockRejectedValue(new SimplePricingError('pricing_completion_locked', 'locked'));
        const locked = await POST(req({ action: 'preview_model', model: 'gpt-5.5', base: token }));
        expect(locked.status).toBe(409);
        expect(await locked.json()).toEqual({ error: 'pricing_completion_locked', message: 'locked' });

        m.saveTier.mockRejectedValue(Object.assign(new Error('bad'), { code: 'pricing_write_failed', status: 502 }));
        const failed = await POST(req({ action: 'save_tier', group_id: GROUP, ratio: 2, expected_ratio: 1 }));
        expect(failed.status).toBe(502);
    });
});
