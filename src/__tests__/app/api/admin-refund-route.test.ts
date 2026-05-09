import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockVerifyAdminToken = vi.fn();
const mockProcessRefund = vi.fn();

vi.mock('@/lib/admin-auth', () => ({
    verifyAdminToken: (...args: unknown[]) => mockVerifyAdminToken(...args),
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));

vi.mock('@/lib/order/service', () => ({
    processRefund: (...args: unknown[]) => mockProcessRefund(...args),
}));

vi.mock('@/lib/locale', () => ({
    resolveLocale: (lang: string | null) => (lang === 'en' ? 'en' : 'zh'),
}));

vi.mock('@/lib/utils/api', () => ({
    handleApiError: (error: Error, msg: string, _req: NextRequest) =>
        NextResponse.json({ error: msg, detail: error.message }, { status: 500 }),
}));

import { POST } from '@/app/api/admin/refund/route';

function createRequest(body?: object, lang?: string) {
    const url = lang
        ? `https://pay.example.com/api/admin/refund?lang=${lang}`
        : 'https://pay.example.com/api/admin/refund';
    return new NextRequest(url, {
        method: 'POST',
        headers: {
            Authorization: 'Bearer test-admin-token',
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : JSON.stringify({}),
    });
}

describe('POST /api/admin/refund', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVerifyAdminToken.mockResolvedValue(true);
        mockProcessRefund.mockResolvedValue({ success: true, balanceDeducted: 100, subscriptionDaysDeducted: 0 });
    });

    it('returns 401 when unauthenticated', async () => {
        mockVerifyAdminToken.mockResolvedValue(false);
        const res = await POST(createRequest({ order_id: 'o1' }));
        expect(res.status).toBe(401);
    });

    it('returns 400 for missing order_id', async () => {
        const res = await POST(createRequest({}));
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBeTruthy();
    });

    it('returns 400 for empty order_id', async () => {
        const res = await POST(createRequest({ order_id: '' }));
        expect(res.status).toBe(400);
    });

    it('calls processRefund with deduct_balance=true by default', async () => {
        const res = await POST(createRequest({ order_id: 'order-001' }));
        expect(res.status).toBe(200);
        expect(mockProcessRefund).toHaveBeenCalledWith(
            expect.objectContaining({
                orderId: 'order-001',
                deductBalance: true,
                force: false,
            }),
        );
    });

    it('passes deduct_balance=false correctly', async () => {
        const res = await POST(createRequest({ order_id: 'order-002', deduct_balance: false }));
        expect(res.status).toBe(200);
        expect(mockProcessRefund).toHaveBeenCalledWith(
            expect.objectContaining({
                orderId: 'order-002',
                deductBalance: false,
            }),
        );
    });

    it('passes force=true correctly', async () => {
        const res = await POST(createRequest({ order_id: 'order-003', force: true }));
        expect(res.status).toBe(200);
        expect(mockProcessRefund).toHaveBeenCalledWith(
            expect.objectContaining({
                orderId: 'order-003',
                force: true,
            }),
        );
    });

    it('passes reason correctly', async () => {
        const res = await POST(createRequest({ order_id: 'order-004', reason: '用户申请退款' }));
        expect(res.status).toBe(200);
        expect(mockProcessRefund).toHaveBeenCalledWith(
            expect.objectContaining({
                reason: '用户申请退款',
            }),
        );
    });

    it('passes locale from query param', async () => {
        const res = await POST(createRequest({ order_id: 'order-005' }, 'en'));
        expect(res.status).toBe(200);
        expect(mockProcessRefund).toHaveBeenCalledWith(
            expect.objectContaining({
                locale: 'en',
            }),
        );
    });

    it('returns processRefund result on success', async () => {
        mockProcessRefund.mockResolvedValue({
            success: true,
            balanceDeducted: 50,
            subscriptionDaysDeducted: 0,
        });

        const res = await POST(createRequest({ order_id: 'order-006' }));
        const data = await res.json();

        expect(data.success).toBe(true);
        expect(data.balanceDeducted).toBe(50);
    });

    it('returns error response when processRefund throws', async () => {
        mockProcessRefund.mockRejectedValue(new Error('something went wrong'));

        const res = await POST(createRequest({ order_id: 'order-007' }));
        expect(res.status).toBe(500);
        const data = await res.json();
        expect(data.error).toBeTruthy();
    });

    it('returns requireForce result when processRefund indicates it', async () => {
        mockProcessRefund.mockResolvedValue({
            success: false,
            requireForce: true,
            warning: '无法获取用户余额',
        });

        const res = await POST(createRequest({ order_id: 'order-008' }));
        const data = await res.json();

        expect(data.success).toBe(false);
        expect(data.requireForce).toBe(true);
        expect(data.warning).toBeTruthy();
    });
});
