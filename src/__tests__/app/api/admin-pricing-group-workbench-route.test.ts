import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { PricingGroupCatalog } from '@/lib/admin/pricing-group-types';
import type { PricingCostConfig } from '@/lib/admin/pricing-cost-types';
const m = vi.hoisted(() => ({
    auth: vi.fn(),
    discover: vi.fn(),
    groups: vi.fn(),
    save: vi.fn(),
    resolve: vi.fn(),
    preview: vi.fn(),
    enqueue: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: m.auth }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/admin/pricing-group-catalog', () => ({
    discoverPricingGroupCatalog: m.discover,
    listPricingGroups: m.groups,
}));
vi.mock('@/lib/admin/pricing-cost-store', () => ({ saveCostRules: m.save }));
vi.mock('@/lib/admin/pricing-cost-publication-guard', async (original) => ({
    ...(await original<typeof import('@/lib/admin/pricing-cost-publication-guard')>()),
    resolvePricingCostSelection: m.resolve,
}));
vi.mock('@/lib/admin/pricing-publish', () => ({
    previewPricingBatch: m.preview,
    enqueuePricingBatch: m.enqueue,
    pricingPublishErrorResponse: (error: { code?: string; message?: string; status?: number }) => ({
        status: error.status ?? 409,
        body: { error: error.code ?? 'pricing_error', message: error.message ?? 'error' },
    }),
}));
import { GET, POST } from '@/app/api/admin/pricing/group-workbench/route';
const A = '11111111-1111-4111-8111-111111111111',
    B = '22222222-2222-4222-8222-222222222222';
const config = (): PricingCostConfig => ({
    version: 1,
    basis: 'token',
    currency: 'credits',
    credits_per_cny: 10,
    upstream_multiplier: 1.3,
    retail_multiplier: 1.6,
    markup_percent: 0,
    source_note: '',
    token_rates: { input: 5, output: 30, cache_read: 0.5, cache_write: null },
    variants: [],
});
let c: PricingGroupCatalog;
const req = (body: unknown) =>
    new NextRequest('http://localhost/api/admin/pricing/group-workbench', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
const draft = () => ({
    action: 'preview',
    group_id: A,
    catalog_fingerprint: 'a'.repeat(64),
    settings: { currency: 'credits', credits_per_cny: 10, upstream_multiplier: 1.3, retail_multiplier: 1.6 },
    models: [A, B].map((model_id) => ({ model_id, expected_revision: null, config: config() })),
});
beforeEach(() => {
    vi.clearAllMocks();
    process.env.PORTAL_JWT_SECRET = 'test-only-pricing-group-signing-secret-123456789';
    c = {
        tier: { id: A, key: 'enterprise', label: '企业级', newapi_group: 'GPT' },
        fingerprint: 'a'.repeat(64),
        reference_error: null,
        notices: [],
        counts: { total: 2, ready: 2, needs_price: 0, unavailable: 0 },
        models: [A, B].map((id) => ({
            id,
            model_id: id,
            slug: id,
            display_name: id,
            upstream_model: id,
            channel_ids: [5],
            status: 'ready',
            ready: true,
            selectable: true,
            config: config(),
            saved_revision: null,
            saved_rule_id: null,
            capability: {
                model_id: id,
                tier: 'enterprise',
                basis: 'token',
                resolution: null,
                publishable: true,
                reason: null,
            },
            reason: null,
            base_source: 'reference',
            reference_model: id,
        })),
    };
    m.auth.mockResolvedValue({ role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true });
    m.groups.mockResolvedValue([c.tier]);
    m.discover.mockImplementation(async () => structuredClone(c));
    m.save.mockImplementation(async (rows) => {
        c.fingerprint = 'b'.repeat(64);
        c.models = c.models.map((row) => ({
            ...row,
            saved_rule_id: row.model_id,
            saved_revision: 1,
            config: rows.find((v: { model_id: string }) => v.model_id === row.model_id).config,
        }));
        return c.models.map((row) => ({
            id: row.model_id,
            model_id: row.model_id,
            tier: 'enterprise',
            revision: 1,
            config: row.config,
            mapping_current: true,
        }));
    });
    m.resolve.mockImplementation(async (_db, selections, _admin, group_scope) => ({
        inputs: [],
        cost_rows: [],
        context: { selections, fingerprint: 'c'.repeat(64), group_scope },
    }));
    m.preview.mockResolvedValue({ preview_token: 'valid-preview', rows: [], warnings: [] });
    m.enqueue.mockResolvedValue({ id: 'job', status: 'queued' });
});
describe('group pricing admin endpoint', () => {
    it('blocks unauthenticated reads and writes before discovery or saving', async () => {
        m.auth.mockResolvedValue(null);
        expect((await GET(new NextRequest('http://localhost/api/admin/pricing/group-workbench'))).status).toBe(401);
        expect((await POST(req(draft()))).status).toBe(401);
        expect(m.discover).not.toHaveBeenCalled();
        expect(m.save).not.toHaveBeenCalled();
    });
    it('returns a no-store group list and a precise group catalog', async () => {
        const list = await GET(new NextRequest('http://localhost/api/admin/pricing/group-workbench'));
        expect(list.headers.get('cache-control')).toContain('no-store');
        expect((await list.json()).groups).toHaveLength(1);
        const result = await GET(new NextRequest(`http://localhost/api/admin/pricing/group-workbench?group_id=${A}`));
        expect((await result.json()).catalog.tier.id).toBe(A);
    });
    it('saves all cost drafts once and returns a signed preview with the new fingerprint', async () => {
        const r = await POST(req(draft()));
        expect(r.status).toBe(200);
        const data = await r.json();
        expect(data.catalog_fingerprint).toBe('b'.repeat(64));
        expect(data.rules).toHaveLength(2);
        expect(data.selections).toHaveLength(2);
        expect(data.selection_token).toMatch(/^[a-f0-9]{64}$/);
        expect(m.save).toHaveBeenCalledTimes(1);
        expect(m.resolve.mock.calls[0][3]).toEqual({ tier: 'enterprise', newapi_group: 'GPT', retail_ratio: 0.16 });
        expect(m.enqueue).not.toHaveBeenCalled();
    });
    it('rejects partial or stale selection before any draft write', async () => {
        const partial = draft();
        partial.models.pop();
        expect((await POST(req(partial))).status).toBe(409);
        const stale = draft();
        stale.catalog_fingerprint = 'd'.repeat(64);
        expect((await POST(req(stale))).status).toBe(409);
        expect(m.save).not.toHaveBeenCalled();
    });
    it('reports already-saved revisions on a preview failure without publishing', async () => {
        m.preview.mockRejectedValue(new Error('new-api 暂时不可用'));
        const r = await POST(req(draft()));
        const data = await r.json();
        expect(r.status).toBe(409);
        expect(data.rules).toHaveLength(2);
        expect(data.catalog_fingerprint).toBe('b'.repeat(64));
        expect(data.message).toContain('成本草稿已保存，尚未发布');
        expect(m.enqueue).not.toHaveBeenCalled();
    });
    it('enqueues one job only after confirmation matches the group and fresh cost signature', async () => {
        const data = await (await POST(req(draft()))).json();
        const publish = {
            action: 'publish',
            group_id: A,
            catalog_fingerprint: data.catalog_fingerprint,
            selections: data.selections,
            preview_token: data.preview.preview_token,
            selection_token: data.selection_token,
        };
        expect((await POST(req({ ...publish, selection_token: '0'.repeat(64) }))).status).toBe(409);
        expect(m.enqueue).not.toHaveBeenCalled();
        expect((await POST(req(publish))).status).toBe(202);
        expect(m.enqueue).toHaveBeenCalledTimes(1);
        expect(m.save).toHaveBeenCalledTimes(1);
    });
    it('refuses publication if discovery has changed since preview', async () => {
        const data = await (await POST(req(draft()))).json();
        c.fingerprint = 'e'.repeat(64);
        const r = await POST(
            req({
                action: 'publish',
                group_id: A,
                catalog_fingerprint: data.catalog_fingerprint,
                selections: data.selections,
                preview_token: data.preview.preview_token,
                selection_token: data.selection_token,
            }),
        );
        expect(r.status).toBe(409);
        expect(m.enqueue).not.toHaveBeenCalled();
    });
});
