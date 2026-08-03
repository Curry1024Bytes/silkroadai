/**
 * W5 D2 — /pay/result page server-component render smoke.
 *
 * Mirror of W4-2 portal-balance test pattern. Mocks prisma at the boundary,
 * exercises 4 states:
 *   - missing order_id query → "访问无效"
 *   - order not found → "订单异常" + 客服 hint
 *   - order COMPLETED → "付款成功" + amount + /balance back link
 *   - order PAID/RECHARGING → "付款已收到,处理中" + /balance back link
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Prisma } from '@prisma/client';

const mockOrderFindUnique = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        order: {
            findUnique: (...args: unknown[]) => mockOrderFindUnique(...args),
        },
    },
}));

import PayResultPage from '@/app/pay/result/page';

const ORDER_ID = 'order-w5d2-test-1';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('<PayResultPage /> SSR smoke (W5 D2)', () => {
    it('"访问无效" when order_id and out_trade_no are both missing', async () => {
        const html = renderToString(await PayResultPage({ searchParams: Promise.resolve({}) }));
        expect(html).toContain('访问无效');
        expect(html).toContain('缺少订单参数');
        // Falls back to /
        expect(html).toMatch(/href="\/"[^>]*>返回首页/);
        expect(mockOrderFindUnique).not.toHaveBeenCalled();
    });

    it('"订单异常" + 微信 LLmRoute when order not found in DB', async () => {
        mockOrderFindUnique.mockResolvedValue(null);

        const html = renderToString(
            await PayResultPage({ searchParams: Promise.resolve({ order_id: 'nonexistent' }) }),
        );
        expect(html).toContain('订单异常');
        expect(html).toContain('LLmRoute');
        expect(mockOrderFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'nonexistent' } }));
    });

    it('"付款成功" + amount + /balance link when order COMPLETED', async () => {
        mockOrderFindUnique.mockResolvedValue({
            id: ORDER_ID,
            status: 'COMPLETED',
            amount: new Prisma.Decimal('10.00'),
        });

        const html = renderToString(await PayResultPage({ searchParams: Promise.resolve({ order_id: ORDER_ID }) }));
        expect(html).toContain('付款成功');
        expect(html).toMatch(/¥(<!-- -->)?10\.00/);
        expect(html).toContain('60 秒');
        expect(html).toMatch(/href="\/balance"/);
    });

    it('"付款已收到,处理中" when order is PAID (webhook still in flight)', async () => {
        mockOrderFindUnique.mockResolvedValue({
            id: ORDER_ID,
            status: 'PAID',
            amount: new Prisma.Decimal('10.00'),
        });

        const html = renderToString(await PayResultPage({ searchParams: Promise.resolve({ order_id: ORDER_ID }) }));
        expect(html).toContain('付款已收到');
        expect(html).toContain('处理中');
        expect(html).toMatch(/href="\/balance"/);
    });

    it('"付款已收到,处理中" when order is RECHARGING (CAS lock taken)', async () => {
        mockOrderFindUnique.mockResolvedValue({
            id: ORDER_ID,
            status: 'RECHARGING',
            amount: new Prisma.Decimal('10.00'),
        });

        const html = renderToString(await PayResultPage({ searchParams: Promise.resolve({ order_id: ORDER_ID }) }));
        expect(html).toContain('处理中');
    });

    it('"订单异常" when status is FAILED / EXPIRED / CANCELLED', async () => {
        for (const status of ['FAILED', 'EXPIRED', 'CANCELLED']) {
            mockOrderFindUnique.mockResolvedValue({
                id: ORDER_ID,
                status,
                amount: new Prisma.Decimal('10.00'),
            });

            const html = renderToString(await PayResultPage({ searchParams: Promise.resolve({ order_id: ORDER_ID }) }));
            expect(html).toContain('订单异常');
            expect(html).toContain('LLmRoute');
        }
    });

    it('accepts legacy `out_trade_no` query as a fallback', async () => {
        // Some gateway redirect-back flows pass `out_trade_no` instead of
        // the W4-1 D2 canonical `order_id`. The page should treat them
        // equivalently.
        mockOrderFindUnique.mockResolvedValue({
            id: ORDER_ID,
            status: 'COMPLETED',
            amount: new Prisma.Decimal('5.00'),
        });

        const html = renderToString(await PayResultPage({ searchParams: Promise.resolve({ out_trade_no: ORDER_ID }) }));
        expect(html).toContain('付款成功');
        expect(mockOrderFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ORDER_ID } }));
    });

    it('prefers order_id over out_trade_no when both are present', async () => {
        mockOrderFindUnique.mockResolvedValue({
            id: 'real',
            status: 'COMPLETED',
            amount: new Prisma.Decimal('1.00'),
        });

        await PayResultPage({
            searchParams: Promise.resolve({ order_id: 'real', out_trade_no: 'legacy' }),
        });

        expect(mockOrderFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'real' } }));
    });
});
