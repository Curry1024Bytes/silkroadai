import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
    resolveAdmin: vi.fn(),
    board: vi.fn(),
    preview: vi.fn(),
    presentPlan: vi.fn(async (plan: unknown) => ({ presented: plan })),
    presentImpact: vi.fn(async (impact: unknown) => impact),
    saveSaleRule: vi.fn(),
    loadCustomer: vi.fn(),
    checkCustomer: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: mocks.resolveAdmin }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/auth/extract-ip', () => ({ extractClientIP: () => '127.0.0.1' }));
vi.mock('@/lib/pricing-rules/publish', () => ({ previewSaleRules: mocks.preview }));
vi.mock('@/lib/pricing-rules/board', () => ({
    loadSaleRuleBoard: mocks.board,
    presentPlan: mocks.presentPlan,
    presentImpact: mocks.presentImpact,
    presentConversion: vi.fn(),
    loadCustomerSaleRules: mocks.loadCustomer,
    checkCustomerSaleRules: mocks.checkCustomer,
}));
vi.mock('@/lib/pricing-rules/service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/pricing-rules/service')>()),
    saveSaleRule: mocks.saveSaleRule,
}));

import { GET, POST } from '@/app/api/admin/pricing/sale-rules/route';
import { POST as CUSTOMER_POST } from '@/app/api/admin/customers/[id]/sale-rules/route';
import { SaleRulePublishError } from '@/lib/pricing-rules/errors';

const SUPER = { role: 'superadmin', tenant_id: null, user: { id: 'su', email: 'boss@x.com' }, viaBreakGlass: false };
const CUSTOMER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const post = (body: unknown, path = 'https://x/api/admin/pricing/sale-rules') =>
    new NextRequest(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
const draft = {
    kind: 'customer_tier',
    tier_key: 'pool',
    user_id: CUSTOMER,
    model_id: null,
    discount: '0.8',
    effective_from: null,
    effective_to: null,
    enabled: true,
    note: null,
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAdmin.mockResolvedValue(SUPER);
});

describe('admin sale-rule routes', () => {
    it('requires a superadmin for the pricing board', async () => {
        mocks.resolveAdmin.mockResolvedValue(null);
        expect((await GET(new NextRequest('https://x/api/admin/pricing/sale-rules'))).status).toBe(401);
        expect((await POST(post({ action: 'preview' }))).status).toBe(401);
        expect(mocks.resolveAdmin).toHaveBeenCalledWith(expect.anything(), 'superadmin');
        expect(mocks.board).not.toHaveBeenCalled();
    });

    it('rejects unknown actions and malformed discounts before any work', async () => {
        expect((await POST(post({ action: 'drop_tables' }))).status).toBe(400);
        const bad = await POST(
            post({
                action: 'save_rule',
                change: { op: 'create', draft: { ...draft, discount: '8e-1' } },
                confirmation: { dry_run: true },
            }),
        );
        expect(bad.status).toBe(400);
        expect(mocks.saveSaleRule).not.toHaveBeenCalled();
    });

    it('returns the full preview and maps service errors to their status', async () => {
        mocks.preview.mockResolvedValue({ hash: 'h' });
        const ok = await POST(post({ action: 'preview' }));
        expect(await ok.json()).toEqual({ plan: { presented: { hash: 'h' } } });
        mocks.saveSaleRule.mockRejectedValue(new SaleRulePublishError('sale_rules_stale', '请重新预览。'));
        const stale = await POST(
            post({
                action: 'save_rule',
                change: { op: 'create', draft },
                confirmation: { dry_run: false, impact_hash: 'a'.repeat(64) },
            }),
        );
        expect(stale.status).toBe(409);
        expect(await stale.json()).toEqual({ error: 'sale_rules_stale', message: '请重新预览。' });
    });

    it('scopes customer-page saves to that customer', async () => {
        mocks.saveSaleRule.mockResolvedValue({ applied: false, impact: { changes: [] }, publish: null });
        const response = await CUSTOMER_POST(
            post(
                { action: 'save_rule', change: { op: 'create', draft }, confirmation: { dry_run: true } },
                `https://x/api/admin/customers/${CUSTOMER}/sale-rules`,
            ),
            { params: Promise.resolve({ id: CUSTOMER }) },
        );
        expect(response.status).toBe(200);
        expect(mocks.resolveAdmin).toHaveBeenCalledWith(expect.anything(), 'admin');
        expect(mocks.saveSaleRule).toHaveBeenCalledWith(
            expect.objectContaining({ path: `/api/admin/customers/${CUSTOMER}/sale-rules` }),
            { op: 'create', draft },
            expect.objectContaining({ dry_run: true }),
            CUSTOMER,
        );
    });
});
