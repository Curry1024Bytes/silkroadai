/**
 * PR-U2 — CustomersClient SSR smoke.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { CustomersClient, type CustomerRow } from '@/app/(authenticated)/reseller/customers/customers-client';

/** React SSR splits adjacent dynamic+static JSX nodes with `<!-- -->`.
 *  Strip them so substring assertions target the user-visible string. */
function strip(html: string): string {
    return html.replace(/<!-- -->/g, '');
}

const baseRow: CustomerRow = {
    seq_no: '#001',
    email_masked: 'abc***@gmail.com',
    joined_at: '2026-04-01T00:00:00.000Z',
    attribution_expires_at: '2028-04-01T00:00:00.000Z',
    attribution_active: true,
    total_recharged_cny: 12.5,
    last_recharge_at: '2026-05-01T00:00:00.000Z',
    status: 'active',
    inviter_code: 'FRANK-WX-2026',
};

describe('<CustomersClient />', () => {
    it('empty rows → EmptyState + 去管理邀请码 CTA', () => {
        const html = renderToString(
            <CustomersClient rows={[]} pagination={{ page: 1, limit: 20, total: 0, hasMore: false }} />,
        );
        expect(html).toContain('还没有引流客户');
        expect(html).toContain('去管理邀请码');
        expect(html).toContain('href="/reseller/codes"');
    });

    it('renders the seq_no + masked email + GMV', () => {
        const html = renderToString(
            <CustomersClient rows={[baseRow]} pagination={{ page: 1, limit: 20, total: 1, hasMore: false }} />,
        );
        expect(html).toContain('#001');
        expect(html).toContain('abc***@gmail.com');
        expect(html).toContain('FRANK-WX-2026');
        expect(html).toContain('¥12.50');
    });

    it('shows "归因中" chip when attribution active + 归因已结束 when expired', () => {
        const active = renderToString(
            <CustomersClient rows={[baseRow]} pagination={{ page: 1, limit: 20, total: 1, hasMore: false }} />,
        );
        expect(active).toContain('归因中');

        const expired = renderToString(
            <CustomersClient
                rows={[{ ...baseRow, attribution_active: false }]}
                pagination={{ page: 1, limit: 20, total: 1, hasMore: false }}
            />,
        );
        expect(expired).toContain('归因已结束');
    });

    it('shows pagination links when total > limit', () => {
        const html = renderToString(
            <CustomersClient rows={[baseRow]} pagination={{ page: 2, limit: 20, total: 45, hasMore: true }} />,
        );
        expect(html).toContain('上一页');
        expect(html).toContain('下一页');
        expect(html).toContain('?page=1'); // previous link target
        expect(html).toContain('?page=3'); // next link target
    });

    it('banned customer → red chip', () => {
        const html = renderToString(
            <CustomersClient
                rows={[{ ...baseRow, status: 'banned', attribution_active: true }]}
                pagination={{ page: 1, limit: 20, total: 1, hasMore: false }}
            />,
        );
        expect(html).toContain('已封');
    });
});
