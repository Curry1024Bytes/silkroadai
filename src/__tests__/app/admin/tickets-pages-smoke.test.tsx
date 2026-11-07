/** /admin/tickets 两页首帧 SSR smoke(client 页,useEffect 不跑;只验 shell + zh/en)+ nav 入口。 */
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
    useSearchParams: () => search,
    usePathname: () => '/admin/tickets',
    useParams: () => ({ id: '0b0b0b0b-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
}));

import AdminTicketsPage from '@/app/admin/(console)/tickets/page';
import AdminTicketDetailPage from '@/app/admin/(console)/tickets/[id]/page';
import { AdminShell } from '@/app/admin/(console)/admin-shell';

describe('/admin/tickets smoke', () => {
    it('queue page renders title, 5 tabs, category filter and search (zh)', () => {
        search = new URLSearchParams();
        const html = renderToString(<AdminTicketsPage />);
        expect(html).toContain('客诉工单');
        expect((html.match(/role="tab"/g) ?? []).length).toBe(5);
        expect(html).toContain('计费争议');
        expect(html).toContain('工单号 T-000123');
    });
    it('queue page in English + dark', () => {
        search = new URLSearchParams('lang=en&theme=dark');
        const html = renderToString(<AdminTicketsPage />);
        expect(html).toContain('Support tickets');
        expect(html).toContain('data-theme="dark"');
        expect(html).not.toContain('客诉工单');
    });
    it('detail page first frame shows loading shell', () => {
        search = new URLSearchParams();
        const html = renderToString(<AdminTicketDetailPage />);
        expect(html).toContain('← 返回队列');
        expect(html).toContain('加载中');
    });
    it('nav: 客诉工单 visible to partner admin and superadmin', () => {
        search = new URLSearchParams();
        for (const role of ['admin', 'superadmin']) {
            const html = renderToString(
                <AdminShell adminEmail="a@b" adminRole={role}>
                    <div />
                </AdminShell>,
            );
            expect(html).toContain('客诉工单');
            expect(html).toMatch(/href="\/admin\/tickets/);
        }
    });
});
