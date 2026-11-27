import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockWalletUpdateMany = vi.fn();
const mockWalletFindUnique = vi.fn();
const mockWalletUpdate = vi.fn();
const mockWithdrawalCreate = vi.fn();
const mockWithdrawalFindMany = vi.fn();
const mockWithdrawalFindUnique = vi.fn();
const mockWithdrawalUpdateMany = vi.fn();
const mockAuditCreate = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => {
    const tx = {
        partnerWallet: {
            updateMany: (...a: unknown[]) => mockWalletUpdateMany(...a),
            findUnique: (...a: unknown[]) => mockWalletFindUnique(...a),
            update: (...a: unknown[]) => mockWalletUpdate(...a),
        },
        partnerWithdrawal: {
            create: (...a: unknown[]) => mockWithdrawalCreate(...a),
            findUnique: (...a: unknown[]) => mockWithdrawalFindUnique(...a),
            updateMany: (...a: unknown[]) => mockWithdrawalUpdateMany(...a),
        },
        adminAuditLog: { create: (...a: unknown[]) => mockAuditCreate(...a) },
    };
    return {
        prisma: {
            ...tx,
            partnerWithdrawal: { ...tx.partnerWithdrawal, findMany: (...a: unknown[]) => mockWithdrawalFindMany(...a) },
            $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx),
        },
    };
});

import { POST as WITHDRAW } from '@/app/api/partner/wallet/withdraw/route';
import { GET as LIST } from '@/app/api/admin/partner-withdrawals/route';
import { POST as PROCESS } from '@/app/api/admin/partner-withdrawals/[id]/route';

const TENANT = '11111111-2222-3333-4444-555555555555';
const PLATFORM = '00000000-0000-0000-0000-000000000001';
const STAFF = { role: 'staff', tenant_id: TENANT, user: { id: 'u1' } };
const SUPER = { role: 'superadmin', tenant_id: null, user: { id: 'admin-1', email: 'ops@x' }, viaBreakGlass: false };

function req(url: string, method: string, body?: object) {
    return new NextRequest(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(STAFF);
    mockWalletUpdateMany.mockResolvedValue({ count: 1 });
    mockWalletFindUnique.mockResolvedValue({ balance_cny: '0', pending_cny: '100' });
    mockWithdrawalCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: 'w1', status: 'pending', ...data }));
    mockWithdrawalFindUnique.mockResolvedValue({ id: 'w1', tenant_id: TENANT, amount_cny: '100', status: 'pending' });
    mockWithdrawalUpdateMany.mockResolvedValue({ count: 1 });
    mockWalletUpdate.mockResolvedValue({ balance_cny: '0', pending_cny: '0' });
    mockAuditCreate.mockResolvedValue({});
});

describe('POST /api/partner/wallet/withdraw', () => {
    it('holds the amount with one conditional update and records the request', async () => {
        const res = await WITHDRAW(req('https://x/api/partner/wallet/withdraw', 'POST', { amount_cny: 100, note: 'alipay' }));
        expect(res.status).toBe(200);
        expect(mockWalletUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ tenant_id: TENANT }),
                data: expect.objectContaining({ pending_cny: { increment: expect.anything() } }),
            }),
        );
        expect(mockWithdrawalCreate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ tenant_id: TENANT, note: 'alipay' }) }),
        );
    });

    it('rejects when the conditional balance check matches no row', async () => {
        mockWalletUpdateMany.mockResolvedValue({ count: 0 });
        const res = await WITHDRAW(req('https://x/api/partner/wallet/withdraw', 'POST', { amount_cny: 100 }));
        expect(res.status).toBe(400);
        expect(mockWithdrawalCreate).not.toHaveBeenCalled();
    });

    it('rejects invalid amounts and platform tenants', async () => {
        expect(
            (await WITHDRAW(req('https://x/api/partner/wallet/withdraw', 'POST', { amount_cny: 0 }))).status,
        ).toBe(400);
        mockResolveAdmin.mockResolvedValue({ ...STAFF, tenant_id: PLATFORM });
        expect(
            (await WITHDRAW(req('https://x/api/partner/wallet/withdraw', 'POST', { amount_cny: 100 }))).status,
        ).toBe(403);
    });
});

describe('POST /api/admin/partner-withdrawals/[id]', () => {
    beforeEach(() => mockResolveAdmin.mockResolvedValue(SUPER));

    it('marks paid and clears the held amount', async () => {
        const res = await PROCESS(req('https://x/api/admin/partner-withdrawals/w1', 'POST', { action: 'paid' }), {
            params: Promise.resolve({ id: 'w1' }),
        });
        expect(res.status).toBe(200);
        expect(mockWithdrawalUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'w1', status: 'pending' }, data: expect.objectContaining({ status: 'paid' }) }),
        );
        expect(mockWalletUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ pending_cny: { decrement: expect.anything() } }) }),
        );
        expect(mockWalletUpdate.mock.calls[0][0].data).not.toHaveProperty('balance_cny');
        expect(mockAuditCreate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ action: 'partner_withdrawal_paid' }) }),
        );
    });

    it('rejecting returns the held amount to the available balance', async () => {
        expect(
            (
                await PROCESS(req('https://x/api/admin/partner-withdrawals/w1', 'POST', { action: 'reject' }), {
                    params: Promise.resolve({ id: 'w1' }),
                })
            ).status,
        ).toBe(200);
        expect(mockWalletUpdate.mock.calls[0][0].data).toMatchObject({
            pending_cny: { decrement: expect.anything() },
            balance_cny: { increment: expect.anything() },
        });
    });

    it('refuses a request that was already processed', async () => {
        mockWithdrawalUpdateMany.mockResolvedValue({ count: 0 });
        const res = await PROCESS(req('https://x/api/admin/partner-withdrawals/w1', 'POST', { action: 'paid' }), {
            params: Promise.resolve({ id: 'w1' }),
        });
        expect(res.status).toBe(409);
        expect(mockWalletUpdate).not.toHaveBeenCalled();
    });

    it('superadmin only', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect(
            (
                await PROCESS(req('https://x/api/admin/partner-withdrawals/w1', 'POST', { action: 'paid' }), {
                    params: Promise.resolve({ id: 'w1' }),
                })
            ).status,
        ).toBe(401);
    });
});

describe('GET /api/admin/partner-withdrawals', () => {
    it('lists pending requests for superadmins', async () => {
        mockResolveAdmin.mockResolvedValue(SUPER);
        mockWithdrawalFindMany.mockResolvedValue([{ id: 'w1' }]);
        const data = await (await LIST(req('https://x/api/admin/partner-withdrawals', 'GET'))).json();
        expect(data.withdrawals).toHaveLength(1);
        expect(mockWithdrawalFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'pending' } }));
    });
});
