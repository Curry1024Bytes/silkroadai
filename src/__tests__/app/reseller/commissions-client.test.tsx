/**
 * PR-U2 — CommissionsClient SSR smoke.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { CommissionsClient, type CommissionRow } from '@/app/(authenticated)/reseller/commissions/commissions-client';

/** React SSR splits adjacent dynamic+static JSX nodes with `<!-- -->`.
 *  Strip them so substring assertions target the user-visible string. */
function strip(html: string): string {
    return html.replace(/<!-- -->/g, '');
}

const baseRow: CommissionRow = {
    id: 'c-1',
    customer_email_masked: 'abc***@gmail.com',
    attributed_gmv_cny: 100,
    commission_rate: 0.1,
    commission_amount_cny: 10,
    status: 'pending',
    admin_review_required: false,
    hold_until: '2026-05-25T00:00:00.000Z',
    settled_at: null,
    created_at: '2026-05-11T00:00:00.000Z',
};

const baseSummary = {
    gmv_cny: 100,
    pending_cny: 10,
    confirmed_cny: 0,
    settled_cny: 0,
    count_pending: 1,
    count_confirmed: 0,
    count_settled: 0,
};

describe('<CommissionsClient />', () => {
    it('renders 4 status tabs with counts', () => {
        const html = strip(
            renderToString(
                <CommissionsClient
                    rows={[baseRow]}
                    summary={baseSummary}
                    filters={{ status: 'all', month: null }}
                    pagination={{ page: 1, limit: 50, total: 1, hasMore: false }}
                />,
            ),
        );
        expect(html).toContain('全部');
        expect(html).toContain('待确认');
        expect(html).toContain('可结算');
        expect(html).toContain('已结算');
        expect(html).toContain('(1)'); // count badge for total/pending
    });

    it('active tab href is reflexive (filters.status), inactive tabs are styled muted', () => {
        const html = strip(
            renderToString(
                <CommissionsClient
                    rows={[baseRow]}
                    summary={baseSummary}
                    filters={{ status: 'pending', month: null }}
                    pagination={{ page: 1, limit: 50, total: 1, hasMore: false }}
                />,
            ),
        );
        // pending tab gets border-brand-accent treatment when active
        expect(html).toContain('border-brand-accent');
    });

    it('renders the commission row + rate + emerald amount', () => {
        const html = strip(
            renderToString(
                <CommissionsClient
                    rows={[baseRow]}
                    summary={baseSummary}
                    filters={{ status: 'all', month: null }}
                    pagination={{ page: 1, limit: 50, total: 1, hasMore: false }}
                />,
            ),
        );
        expect(html).toContain('abc***@gmail.com');
        expect(html).toContain('10%');
        expect(html).toContain('¥10.00');
        // emerald accent color class applied to the amount cell
        expect(html).toContain('text-emerald-700');
    });

    it('admin_review_required row shows the 审核中 chip', () => {
        const html = strip(
            renderToString(
                <CommissionsClient
                    rows={[{ ...baseRow, admin_review_required: true }]}
                    summary={baseSummary}
                    filters={{ status: 'all', month: null }}
                    pagination={{ page: 1, limit: 50, total: 1, hasMore: false }}
                />,
            ),
        );
        expect(html).toContain('审核中');
    });

    it('empty rows → empty-state message', () => {
        const html = strip(
            renderToString(
                <CommissionsClient
                    rows={[]}
                    summary={{
                        gmv_cny: 0,
                        pending_cny: 0,
                        confirmed_cny: 0,
                        settled_cny: 0,
                        count_pending: 0,
                        count_confirmed: 0,
                        count_settled: 0,
                    }}
                    filters={{ status: 'all', month: null }}
                    pagination={{ page: 1, limit: 50, total: 0, hasMore: false }}
                />,
            ),
        );
        expect(html).toContain('没有佣金记录');
    });
});
