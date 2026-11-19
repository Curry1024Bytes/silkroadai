import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const m = vi.hoisted(() => ({
    auth: vi.fn(),
    scope: vi.fn(),
    customer: vi.fn(),
    countKeys: vi.fn(),
    load: vi.fn(),
    view: vi.fn(),
    preview: vi.fn(),
    save: vi.fn(),
    reference: vi.fn(),
    pending: vi.fn(),
    recover: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findFirst: m.customer },
        newApiToken: { count: m.countKeys },
        customerPricingChange: { findMany: m.pending },
    },
}));
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: m.auth }));
vi.mock('@/lib/admin/tenant-scope', () => ({ tenantScope: m.scope, PLATFORM_TENANT_ID: 'platform-tenant' }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/customer-pricing/context', () => ({ loadOfficialContext: m.load, publicOfficialView: m.view }));
vi.mock('@/lib/customer-pricing/preview', () => ({ compileCustomerPreview: m.preview }));
vi.mock('@/lib/customer-pricing/reference', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/customer-pricing/reference')>()),
    saveOfficialReference: m.reference,
}));
vi.mock('@/lib/customer-pricing/service', () => ({ saveCustomerOfficialPricing: m.save }));
vi.mock('@/lib/customer-pricing/recovery', () => ({ recoverCustomerOfficialPricing: m.recover }));

import { GET, POST } from '@/app/api/admin/customers/[id]/official-pricing/route';
import { CustomerPricingError } from '@/lib/customer-pricing/math';

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const MODEL = '22222222-2222-4222-8222-222222222222';
const admin = { user: { id: 'admin-a' }, role: 'admin', tenant_id: 'tenant-a', viaBreakGlass: false };
const params = { params: Promise.resolve({ id: CUSTOMER }) };
const endpoint = `http://localhost/api/admin/customers/${CUSTOMER}/official-pricing`;
const draft = { tier_key: 'sd', model_id: MODEL, official_multiplier: 0.2 };
const req = (body: unknown) =>
    new NextRequest(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });

beforeEach(() => {
    vi.clearAllMocks();
    m.auth.mockResolvedValue(admin);
    m.scope.mockReturnValue({ tenant_id: 'tenant-a' });
    m.customer.mockResolvedValue({ id: CUSTOMER });
    m.countKeys.mockResolvedValue(2);
    m.load.mockResolvedValue({ version: 'v1', private_secret: 'must-not-reach-browser' });
    m.view.mockReturnValue({ version: 'v1', tiers: [], rules: [] });
    m.preview.mockReturnValue({ preview: { version: 'v1', hash: 'hash-a', cells: [] } });
    m.save.mockResolvedValue({ applied: true });
    m.reference.mockResolvedValue({ version: 'v2', tiers: [], rules: [] });
    m.pending.mockResolvedValue([]);
    m.recover.mockResolvedValue({ unchanged: false, change_id: MODEL });
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('customer official-pricing API contract', () => {
    it('requires admin authorization for reads, previews and writes before accessing a customer', async () => {
        m.auth.mockResolvedValue(null);
        expect((await GET(new NextRequest(endpoint), params)).status).toBe(401);
        expect((await POST(req({ action: 'preview', ...draft }), params)).status).toBe(401);
        expect(
            (await POST(req({ action: 'save', ...draft, expected_version: 'v1', preview_hash: 'hash-a' }), params))
                .status,
        ).toBe(401);
        expect(m.auth).toHaveBeenCalledWith(expect.anything(), 'admin');
        expect(m.customer).not.toHaveBeenCalled();
        expect(m.load).not.toHaveBeenCalled();
        expect(m.save).not.toHaveBeenCalled();
    });

    it('scopes the target customer to the authenticated tenant before loading pricing or writing', async () => {
        m.customer.mockResolvedValue(null);
        expect((await GET(new NextRequest(endpoint), params)).status).toBe(404);
        expect((await POST(req({ action: 'preview', ...draft }), params)).status).toBe(404);
        expect(m.scope).toHaveBeenCalledWith(admin);
        expect(m.customer).toHaveBeenCalledWith({
            where: { id: CUSTOMER, tenant_id: 'tenant-a' },
            select: { id: true },
        });
        expect(m.load).not.toHaveBeenCalled();
        expect(m.countKeys).not.toHaveBeenCalled();
        expect(m.save).not.toHaveBeenCalled();
    });

    it('returns only the public customer view with private non-cacheable headers', async () => {
        const response = await GET(new NextRequest(endpoint), params);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(await response.json()).toEqual({ version: 'v1', tiers: [], rules: [], pending_changes: [] });
        expect(m.view).toHaveBeenCalledWith({ version: 'v1', private_secret: 'must-not-reach-browser' });
    });

    it('provides only the selected customer pending change identifiers and accepts a recovery action', async () => {
        m.pending.mockResolvedValue([{ id: MODEL, tier_key: 'sd', status: 'failed' }]);
        expect(await (await GET(new NextRequest(endpoint), params)).json()).toMatchObject({
            pending_changes: [{ id: MODEL, tier_key: 'sd', status: 'failed' }],
        });
        expect(m.pending).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { user_id: CUSTOMER, status: { in: ['preparing', 'applying', 'failed'] } },
            }),
        );
        expect((await POST(req({ action: 'recover', change_id: MODEL }), params)).status).toBe(200);
        expect(m.recover).toHaveBeenCalledWith({ userId: CUSTOMER, changeId: MODEL, actorId: 'admin-a' });
        expect(m.save).not.toHaveBeenCalled();
        expect((await POST(req({ action: 'recover', change_id: 'not-a-uuid' }), params)).status).toBe(400);
    });

    it('keeps preview read-only and counts only active keys of the selected customer and logical group', async () => {
        const response = await POST(req({ action: 'preview', ...draft }), params);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ preview: { version: 'v1', hash: 'hash-a', cells: [] } });
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(m.countKeys).toHaveBeenCalledWith({ where: { user_id: CUSTOMER, tier: 'sd', status: 'active' } });
        expect(m.preview).toHaveBeenCalledWith({ version: 'v1', private_secret: 'must-not-reach-browser' }, draft, 2);
        expect(m.save).not.toHaveBeenCalled();
        expect(m.reference).not.toHaveBeenCalled();
    });

    it.each([
        { official_multiplier: 0 },
        { official_multiplier: -1 },
        { official_multiplier: 101 },
        { official_multiplier: '0.2' },
        { model_id: 'not-a-model-uuid' },
        { tier_key: '' },
        { user_id: 'another-customer' },
        { target_cny: 0.01 },
    ])('rejects invalid or client-authored pricing overrides: %o', async (patch) => {
        const response = await POST(req({ action: 'preview', ...draft, ...patch }), params);
        expect(response.status).toBe(400);
        expect(m.preview).not.toHaveBeenCalled();
        expect(m.save).not.toHaveBeenCalled();
    });

    it('requires both the source version and preview commitment before forwarding a save', async () => {
        expect((await POST(req({ action: 'save', ...draft, preview_hash: 'hash-a' }), params)).status).toBe(400);
        expect((await POST(req({ action: 'save', ...draft, expected_version: 'v1' }), params)).status).toBe(400);
        expect(m.save).not.toHaveBeenCalled();
    });

    it('forwards the exact absolute multiplier, preview version/hash, actor and loss/increase acknowledgements', async () => {
        const response = await POST(
            req({
                action: 'save',
                ...draft,
                expected_version: 'v1',
                preview_hash: 'hash-a',
                confirm_below_cost: true,
                confirm_increases: true,
            }),
            params,
        );
        expect(response.status).toBe(200);
        expect(m.save).toHaveBeenCalledWith({
            userId: CUSTOMER,
            actorId: 'admin-a',
            draft,
            expectedVersion: 'v1',
            previewHash: 'hash-a',
            confirmBelowCost: true,
            confirmIncreases: true,
        });
        expect(await response.json()).toEqual({ ok: true, result: { applied: true } });
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });

    it('does not imply acknowledgement when flags are omitted and preserves null as a rule removal', async () => {
        const removed = { tier_key: 'sd', model_id: null, official_multiplier: null };
        await POST(req({ action: 'save', ...removed, expected_version: 'v1', preview_hash: 'hash-a' }), params);
        expect(m.save).toHaveBeenCalledWith(
            expect.objectContaining({ draft: removed, confirmBelowCost: false, confirmIncreases: false }),
        );
    });

    it('dispatches an explicitly sourced reference confirmation separately from customer price publication', async () => {
        const reference = {
            action: 'reference',
            tier_key: 'sd',
            model_id: MODEL,
            currency: 'USD',
            fx: 7.2,
            source_note: '官方价目表 2026-11-19',
            expected_version: 'v1',
            cells: [{ key: 'input', price: 2 }],
        };
        const response = await POST(req(reference), params);
        expect(response.status).toBe(200);
        expect(m.reference).toHaveBeenCalledWith(CUSTOMER, 'admin-a', reference);
        expect(m.save).not.toHaveBeenCalled();
        expect(await response.json()).toEqual({ ok: true, view: { version: 'v2', tiers: [], rules: [] } });
    });

    it('preserves a fail-closed pricing error instead of accepting a stale or unconfirmed save', async () => {
        m.save.mockRejectedValue(new CustomerPricingError('preview_stale', '请重新预览', 409));
        const response = await POST(
            req({ action: 'save', ...draft, expected_version: 'v1', preview_hash: 'hash-a' }),
            params,
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: 'preview_stale', message: '请重新预览' });
    });

    it('does not leak provider or credential details on unexpected server failures', async () => {
        m.load.mockRejectedValue(new Error('provider-secret-and-credential'));
        const response = await GET(new NextRequest(endpoint), params);
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain('provider-secret-and-credential');
        expect(m.save).not.toHaveBeenCalled();
    });
});
