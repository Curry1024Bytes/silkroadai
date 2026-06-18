import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';

const mockResolveAdmin = vi.fn();
const mockUserFindFirst = vi.fn();
const mockUserUpdate = vi.fn();
const mockAnalyticsCreate = vi.fn();
const mockRechargeCreate = vi.fn();
const mockApplyLedgerEntry = vi.fn();
const mockSyncNewapiGate = vi.fn();
const mockGetUser = vi.fn();
const mockAddQuota = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        user: {
            findFirst: (...a: unknown[]) => mockUserFindFirst(...a),
            update: (...a: unknown[]) => mockUserUpdate(...a),
        },
        analyticsEvent: { create: (...a: unknown[]) => mockAnalyticsCreate(...a) },
        rechargeLog: { create: (...a: unknown[]) => mockRechargeCreate(...a) },
    },
}));
vi.mock('@/lib/billing/ledger', () => ({ applyLedgerEntry: (...a: unknown[]) => mockApplyLedgerEntry(...a) }));
vi.mock('@/lib/billing/newapi-gate', () => ({ syncNewapiGate: (...a: unknown[]) => mockSyncNewapiGate(...a) }));
vi.mock('@/lib/newapi/client', () => ({
    getUser: (...a: unknown[]) => mockGetUser(...a),
    addQuota: (...a: unknown[]) => mockAddQuota(...a),
}));
// 确定性换算(脱离 env):¥1 = 1000 quota。
vi.mock('@/lib/newapi/quota-units', () => ({
    cnyToQuota: (cny: number) => Math.round(cny * 1000),
    quotaToCny: (q: number) => q / 1000,
}));

import { POST } from '@/app/api/admin/customers/[id]/balance-adjust/route';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: { id: 'admin-1' }, viaBreakGlass: false };
const PARTNER = { role: 'admin', tenant_id: 'tenant-7', user: { id: 'padmin-1' }, viaBreakGlass: false };
const PORTAL_USER = { id: 'u-1', tenant_id: null, billing_mode: 'portal', newapi_user_id: 100 };
const NEWAPI_USER = { id: 'u-1', tenant_id: null, billing_mode: 'newapi', newapi_user_id: 100 };

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
    mockUserFindFirst.mockResolvedValue(PORTAL_USER); // 默认 portal(覆盖原账本路径)
    mockUserUpdate.mockResolvedValue({});
    mockAnalyticsCreate.mockResolvedValue({});
    mockRechargeCreate.mockResolvedValue({});
    mockSyncNewapiGate.mockResolvedValue(undefined);
    mockGetUser.mockResolvedValue({ quota: 50_000 });
    mockAddQuota.mockResolvedValue(undefined);
    mockApplyLedgerEntry.mockResolvedValue({
        entryId: 'le-1',
        accountId: 'acc-1',
        kind: 'adjustment',
        amount_cny: new Prisma.Decimal(100),
        balance_after: new Prisma.Decimal(100),
        deduped: false,
    });
});

describe('POST balance-adjust — guards / validation', () => {
    it('401 when not an admin; touches nothing', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await POST(req(GOOD), { params: params() })).status).toBe(401);
        expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
        expect(mockAddQuota).not.toHaveBeenCalled();
    });

    it('400 when amount is 0', async () => {
        expect((await POST(req({ amount_cny: 0, note: 'x' }), { params: params() })).status).toBe(400);
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
        expect(mockUserFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'u-1', tenant_id: 'tenant-7' } }),
        );
        expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
        expect(mockAddQuota).not.toHaveBeenCalled();
    });

    it('superadmin lookup is NOT tenant-filtered (sees all)', async () => {
        await POST(req(GOOD), { params: params() });
        expect(mockUserFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u-1' } }));
    });
});

describe('POST balance-adjust — portal branch (¥ ledger + syncNewapiGate)', () => {
    it('201: applyLedgerEntry(adjustment) + syncNewapiGate + audit; NEVER touches new-api quota', async () => {
        const res = await POST(req(GOOD), { params: params() });
        expect(res.status).toBe(201);
        expect(await res.json()).toMatchObject({
            ok: true,
            billing_mode: 'portal',
            entry_id: 'le-1',
            balance_cny: 100,
        });

        expect(mockApplyLedgerEntry).toHaveBeenCalledWith(
            'u-1',
            expect.objectContaining({
                kind: 'adjustment',
                amount_cny: 100,
                note: 'comp for outage',
                createdBy: 'admin-1',
            }),
        );
        // P4c-5 fix: adjust may cross 0 → re-sync the dumb-gate
        expect(mockSyncNewapiGate).toHaveBeenCalledWith('u-1');
        // portal path must NOT touch new-api quota
        expect(mockAddQuota).not.toHaveBeenCalled();
        expect(mockGetUser).not.toHaveBeenCalled();
        expect(mockRechargeCreate).not.toHaveBeenCalled();
        expect(mockAnalyticsCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ event_type: 'admin_balance_adjusted', user_id: 'u-1' }),
            }),
        );
    });

    it('syncNewapiGate failure is non-fatal (ledger already committed)', async () => {
        mockSyncNewapiGate.mockRejectedValue(new Error('new-api down'));
        expect((await POST(req(GOOD), { params: params() })).status).toBe(201);
    });

    it('audit-event failure does NOT fail the adjustment', async () => {
        mockAnalyticsCreate.mockRejectedValue(new Error('analytics down'));
        expect((await POST(req(GOOD), { params: params() })).status).toBe(201);
    });
});

describe('POST balance-adjust — newapi branch (new-api quota, NO ledger)', () => {
    beforeEach(() => mockUserFindFirst.mockResolvedValue(NEWAPI_USER));

    it('credit (+¥): atomic add_quota(add) + cache bust + RechargeLog(adjustment) + audit; NO ledger', async () => {
        const res = await POST(req({ amount_cny: 100, note: 'comp' }), { params: params() });
        expect(res.status).toBe(201);
        expect(await res.json()).toMatchObject({ ok: true, billing_mode: 'newapi', balance_cny: 150 }); // (50000+100000)/1000

        expect(mockGetUser).toHaveBeenCalledWith(100);
        expect(mockAddQuota).toHaveBeenCalledWith({ userId: 100, quotaDelta: 100_000, mode: 'add' });
        // cache bust → null the three cache fields
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'u-1' },
                data: { newapi_quota_cache: null, newapi_used_quota_cache: null, newapi_cached_at: null },
            }),
        );
        // customer-visible flow row
        expect(mockRechargeCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    user_id: 'u-1',
                    amount: 100,
                    source: 'adjustment',
                    newapi_user_id: 100,
                }),
            }),
        );
        // NEVER writes the ¥ ledger for a newapi customer
        expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
        expect(mockSyncNewapiGate).not.toHaveBeenCalled();
        expect(mockAnalyticsCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    event_type: 'admin_balance_adjusted',
                    properties: expect.objectContaining({ billing_mode: 'newapi' }),
                }),
            }),
        );
    });

    it('debit (−¥): override to (current − |Δ|), NOT add (new-api rejects negative add)', async () => {
        const res = await POST(req({ amount_cny: -30, note: 'correction' }), { params: params() });
        expect(res.status).toBe(201);
        // 50000 − 30*1000 = 20000
        expect(mockAddQuota).toHaveBeenCalledWith({ userId: 100, quotaDelta: 20_000, mode: 'override' });
        expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
    });

    it('debit overshoot clamps at 0 (no negative quota via the adjust button)', async () => {
        const res = await POST(req({ amount_cny: -100, note: 'zero out' }), { params: params() }); // 100*1000 > 50000
        expect(res.status).toBe(201);
        expect(mockAddQuota).toHaveBeenCalledWith({ userId: 100, quotaDelta: 0, mode: 'override' });
    });

    it('409 when the customer has no linked new-api account', async () => {
        mockUserFindFirst.mockResolvedValue({ ...NEWAPI_USER, newapi_user_id: null });
        const res = await POST(req(GOOD), { params: params() });
        expect(res.status).toBe(409);
        expect(mockAddQuota).not.toHaveBeenCalled();
    });

    it('RechargeLog insert failure is non-fatal (quota already changed)', async () => {
        mockRechargeCreate.mockRejectedValue(new Error('db blip'));
        expect((await POST(req({ amount_cny: 100, note: 'x' }), { params: params() })).status).toBe(201);
    });
});
