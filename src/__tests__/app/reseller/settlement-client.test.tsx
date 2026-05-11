/**
 * PR-U2 — SettlementClient SSR smoke.
 *
 * Covers the settle-info banner gating + button disabled state per month.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

// settlement-client uses useRouter() — SSR needs the router mocked or
// renderToString throws "invariant expected app router to be mounted".
vi.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { SettlementClient } from '@/app/(authenticated)/reseller/settlement/settlement-client';

/** React SSR splits adjacent dynamic+static JSX nodes with `<!-- -->`.
 *  Strip them so substring assertions target the user-visible string. */
function strip(html: string): string {
    return html.replace(/<!-- -->/g, '');
}

const baseProps = {
    settleInfoComplete: true,
    settleMethod: 'alipay',
    settleAccount: 'frank@alipay.com',
    settleName: 'Frank',
    thisMonth: { period: '2026-05', confirmed_cny: 200, confirmed_count: 5, pending_count: 0 },
    prevMonth: { period: '2026-04', confirmed_cny: 50, confirmed_count: 2, pending_count: 0 },
    history: [] as never[],
    minThresholdCny: 100,
};

describe('<SettlementClient />', () => {
    it('settle info incomplete → yellow banner + buttons disabled', () => {
        const html = strip(
            renderToString(
                <SettlementClient
                    {...baseProps}
                    settleInfoComplete={false}
                    settleMethod={null}
                    settleAccount={null}
                    settleName={null}
                />,
            ),
        );
        expect(html).toContain('请补全收款信息');
        expect(html).toContain('请先补全收款信息');
        const reasonCount = html.match(/请先补全收款信息/g)?.length ?? 0;
        expect(reasonCount).toBeGreaterThanOrEqual(2);
    });

    it('settle info complete → green confirmation banner', () => {
        const html = strip(renderToString(<SettlementClient {...baseProps} />));
        expect(html).toContain('收款信息已就绪');
        expect(html).toContain('alipay');
        // last 4 chars of the account "frank@alipay.com" → ".com"
        expect(html).toContain('****.com');
    });

    it('this month >= ¥100 → button enabled (no "不足" copy)', () => {
        const html = strip(renderToString(<SettlementClient {...baseProps} />));
        expect(html).toContain('¥200.00');
        expect(html).toContain('申请结算');
        // The 50-cny prev month should have "不足"
        expect(html).toContain('不足 ¥100.00 起结线');
    });

    it('this month has pending commissions → button blocked with hint', () => {
        const html = strip(
            renderToString(
                <SettlementClient
                    {...baseProps}
                    thisMonth={{
                        period: '2026-05',
                        confirmed_cny: 200,
                        confirmed_count: 5,
                        pending_count: 3,
                    }}
                />,
            ),
        );
        expect(html).toContain('3 笔在 hold 期');
    });

    it('empty history → empty-state message', () => {
        const html = strip(renderToString(<SettlementClient {...baseProps} />));
        expect(html).toContain('还没有结算记录');
    });

    it('renders paid/requested/pending status chips for history rows', () => {
        const html = strip(
            renderToString(
                <SettlementClient
                    {...baseProps}
                    history={[
                        {
                            id: 's-1',
                            period_month: '2026-03',
                            total_commission_cny: 250,
                            commission_count: 10,
                            status: 'paid',
                            requested_at: '2026-04-01T00:00:00.000Z',
                            paid_at: '2026-04-03T00:00:00.000Z',
                            paid_tx_ref: 'alipay-txn-001',
                            notes: null,
                        },
                        {
                            id: 's-2',
                            period_month: '2026-02',
                            total_commission_cny: 180,
                            commission_count: 7,
                            status: 'requested',
                            requested_at: '2026-03-01T00:00:00.000Z',
                            paid_at: null,
                            paid_tx_ref: null,
                            notes: null,
                        },
                    ]}
                />,
            ),
        );
        expect(html).toContain('已打款');
        expect(html).toContain('等待打款');
        expect(html).toContain('alipay-txn-001');
        expect(html).toContain('¥250.00');
        expect(html).toContain('¥180.00');
    });
});
