import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';

const mockResolveAdmin = vi.fn();
const mockUserFindFirst = vi.fn();
const mockAnalyticsCreate = vi.fn();
const mockApplyLedgerEntry = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findFirst: (...a: unknown[]) => mockUserFindFirst(...a) },
        analyticsEvent: { create: (...a: unknown[]) => mockAnalyticsCreate(...a) },
    },
}));
vi.mock('@/lib/billing/ledger', () => ({ applyLedgerEntry: (...a: unknown[]) => mockApplyLedgerEntry(...a) }));

import { POST } from '@/app/api/admin/customers/[id]/balance-adjust/route';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: { id: 'admin-1' }, viaBreakGlass: false };
const PARTNER = { role: 'admin', tenant_id: 'tenant-7', user: { id: 'padmin-1' }, viaBreakGlass: false };

function req(body: unknown, id = 'u-1') {
    return new NextRequest(`https://x/api/admin/customers/${id}/balance-adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}
const params = (id = 'u-1') => Promise.resolve({ id });
const GOOD = { amount_cny: 100, note: 'comp for outage' };

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(SUPERADMIN);
    mockUserFindFirst.mockResolvedValue({ id: 'u-1', tenant_id: null });
    mockAnalyticsCreate.mockResolvedValue({});
    mockApplyLedgerEntry.mockResolvedValue({
        entryId: 'le-1',
        accountId: 'acc-1',
        kind: 'adjustment',
        amount_cny: new Prisma.Decimal(100),
        balance_after: new Prisma.Decimal(100),
        deduped: false,
    });
});

describe('POST /api/admin/customers/[id]/balance-adjust', () => {
    it('401 when not an admin; never touches ledger', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await POST(req(GOOD), { params: params() })).status).toBe(401);
        expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
    });

    it('400 when amount is 0', async () => {
        const res = await POST(req({ amount_cny: 0, note: 'x' }), { params: params() });
        expect(res.status).toBe(400);
        expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
    });

    it('400 when note is empty/whitespace', async () => {
        expect((await POST(req({ amount_cny: 50, note: '   ' }), { params: params() })).status).toBe(400);
    });

    it('400 when amount exceeds the ±1,000,000 safety cap', async () => {
        expect((await POST(req({ amount_cny: 2_000_000, note: 'x' }), { params: params() })).status).toBe(400);
    });

    it('404 (IDOR) when the customer is outside the admin tenant; never adjusts', async () => {
        mockResolveAdmin.mockResolvedValue(PARTNER);
        mockUserFindFirst.mockResolvedValue(null);
        const res = await POST(req(GOOD), { params: params() });
        expect(res.status).toBe(404);
        // tenant-scoped lookup: partner only sees their own tenant's user
        expect(mockUserFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'u-1', tenant_id: 'tenant-7' } }),
        );
        expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
    });

    it('201: routes through applyLedgerEntry(adjustment) + writes admin audit event', async () => {
        const res = await POST(req(GOOD), { params: params() });
        expect(res.status).toBe(201);
        expect(await res.json()).toMatchObject({ ok: true, entry_id: 'le-1', balance_cny: 100 });

        expect(mockApplyLedgerEntry).toHaveBeenCalledWith(
            'u-1',
            expect.objectContaining({
                kind: 'adjustment',
                amount_cny: 100,
                note: 'comp for outage',
                createdBy: 'admin-1',
                tenantId: null,
            }),
        );
        expect(mockAnalyticsCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    event_type: 'admin_balance_adjusted',
                    user_id: 'u-1',
                }),
            }),
        );
    });

    it('superadmin lookup is NOT tenant-filtered (sees all)', async () => {
        await POST(req(GOOD), { params: params() });
        expect(mockUserFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u-1' } }));
    });

    it('audit-event failure does NOT fail the adjustment (best-effort)', async () => {
        mockAnalyticsCreate.mockRejectedValue(new Error('analytics down'));
        const res = await POST(req(GOOD), { params: params() });
        expect(res.status).toBe(201); // money op already committed via applyLedgerEntry
    });
});
