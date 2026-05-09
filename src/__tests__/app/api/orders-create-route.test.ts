/**
 * W4-1 D2 — POST /api/orders auth + payload smoke.
 *
 * Verifies the cookie-session migration: the route MUST 401 anonymous
 * requests, MUST extract user_id from getCurrentUser, MUST drop the legacy
 * W1 `token` body field. Does NOT exercise createOrder's deeper plumbing
 * (mocked at the boundary) — that's covered by create-order-auth.test.ts
 * and execute-recharge.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockCreateOrder = vi.fn();
vi.mock('@/lib/order/service', () => ({
    createOrder: (...args: unknown[]) => mockCreateOrder(...args),
}));

const mockGetEnabledPaymentTypes = vi.fn();
vi.mock('@/lib/payment/resolve-enabled-types', () => ({
    getEnabledPaymentTypes: (...args: unknown[]) => mockGetEnabledPaymentTypes(...args),
}));

vi.mock('@/lib/system-config', () => ({
    getSystemConfigs: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/config', () => ({
    getEnv: () => ({
        MIN_RECHARGE_AMOUNT: 1,
        MAX_RECHARGE_AMOUNT: 1000,
    }),
}));

vi.mock('@/lib/utils/api', () => ({
    handleApiError: (err: unknown, fallback: string) => {
        const code = (err as { statusCode?: number })?.statusCode ?? 500;
        const message = err instanceof Error ? err.message : fallback;
        const errCode = (err as { code?: string })?.code;
        return new Response(JSON.stringify({ error: message, code: errCode }), {
            status: code,
            headers: { 'Content-Type': 'application/json' },
        });
    },
}));

import { POST } from '@/app/api/orders/route';

const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetEnabledPaymentTypes.mockResolvedValue(['alipay', 'wxpay', 'stripe']);
});

describe('POST /api/orders (W4-1 D2 cookie-auth)', () => {
    it('401 AUTH_REQUIRED when no session cookie', async () => {
        mockGetCurrentUser.mockResolvedValue(null);

        const res = await POST(makeReq({ amount: 100, payment_type: 'alipay' }));
        const body = await res.json();

        expect(res.status).toBe(401);
        expect(body.code).toBe('AUTH_REQUIRED');
        expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it('400 when amount missing (zod validation)', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: PORTAL_USER_ID });

        const res = await POST(makeReq({ payment_type: 'alipay' }));
        expect(res.status).toBe(400);
        expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it('400 when payment_type not in enabled list', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: PORTAL_USER_ID });

        const res = await POST(makeReq({ amount: 100, payment_type: 'bitcoin' }));
        expect(res.status).toBe(400);
        expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it('400 when amount below RECHARGE_MIN (env default 1)', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: PORTAL_USER_ID });

        // Zod requires amount > 0; the route's effectiveMin check then catches
        // anything below MIN_RECHARGE_AMOUNT (1 in our mock).
        const res = await POST(makeReq({ amount: 0.5, payment_type: 'alipay' }));
        expect(res.status).toBe(400);
        expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it('200 + passes session userId into createOrder + strips userBalance/userName from response', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: PORTAL_USER_ID });
        mockCreateOrder.mockResolvedValue({
            orderId: 'ord-1',
            amount: 100,
            payAmount: 100,
            feeRate: 0,
            status: 'PENDING',
            paymentType: 'alipay',
            userName: 'happy', // should be stripped from response
            userBalance: 0, // should be stripped from response
            payUrl: 'https://gateway/pay/ord-1',
            qrCode: null,
            clientSecret: null,
            expiresAt: new Date(),
            statusAccessToken: 'sat-xyz',
        });

        const res = await POST(makeReq({ amount: 100, payment_type: 'alipay', is_mobile: false }));
        expect(res.status).toBe(200);
        const body = await res.json();

        // createOrder called with session-derived user_id, never reads `token`
        expect(mockCreateOrder).toHaveBeenCalledWith(
            expect.objectContaining({
                user_id: PORTAL_USER_ID,
                amount: 100,
                paymentType: 'alipay',
            }),
        );
        // privacy: userName / userBalance must not leak to client
        expect(body.userName).toBeUndefined();
        expect(body.userBalance).toBeUndefined();
        // payUrl preserved so client can redirect
        expect(body.payUrl).toBe('https://gateway/pay/ord-1');
        expect(body.orderId).toBe('ord-1');
    });

    it('400 still wins when payload also has legacy `token` field (zod ignores unknown keys)', async () => {
        // Sanity: a W1-shape payload (with `token`) and missing `amount` still
        // falls into the zod path and 400s, NOT crashing on the legacy field.
        mockGetCurrentUser.mockResolvedValue({ id: PORTAL_USER_ID });

        const res = await POST(makeReq({ token: 'legacy-litellm-token', payment_type: 'alipay' }));
        expect(res.status).toBe(400);
    });
});
