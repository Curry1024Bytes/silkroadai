/** /support 三页 SSR smoke(zh 默认 + en)+ 线程合成。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const mockHeadersGet = vi.fn<(name: string) => string | null>();
vi.mock('next/headers', () => ({ headers: vi.fn(async () => ({ get: mockHeadersGet })) }));
vi.mock('next/navigation', () => ({
    notFound: () => {
        throw new Error('NEXT_NOT_FOUND');
    },
    usePathname: () => '/support',
}));
const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a) }));
const svc = { listTicketsForUser: vi.fn(), getTicketForUser: vi.fn() };
vi.mock('@/lib/tickets/service', async () => {
    const actual = await vi.importActual<typeof import('@/lib/tickets/service')>('@/lib/tickets/service');
    return {
        ...actual,
        listTicketsForUser: (...a: unknown[]) => svc.listTicketsForUser(...a),
        getTicketForUser: (...a: unknown[]) => svc.getTicketForUser(...a),
    };
});
const mockOrderFindMany = vi.fn();
vi.mock('@/lib/db', () => ({ prisma: { order: { findMany: (...a: unknown[]) => mockOrderFindMany(...a) } } }));
vi.mock('@/lib/r2/client', () => ({ getPublicUrl: (key: string) => `https://images.silkroadai.io/${key}` }));
const mockGetLocale = vi.fn(async () => 'zh');
vi.mock('@/lib/i18n/server', () => ({
    getLocale: () => mockGetLocale(),
    getMessages: async (d: { zh: unknown; en: unknown }) => ((await mockGetLocale()) === 'en' ? d.en : d.zh),
}));

import SupportListPage from '@/app/(authenticated)/support/page';
import NewTicketPage from '@/app/(authenticated)/support/new/page';
import TicketDetailPage from '@/app/(authenticated)/support/[id]/page';
import { buildThread } from '@/app/(authenticated)/support/[id]/thread';
import { ticketsMessages } from '@/lib/i18n/messages/tickets';
import { Sidebar } from '@/app/(authenticated)/sidebar';

const USER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', email: 'c@test.io' };
const TID = '0b0b0b0b-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ticket = {
    id: TID,
    number: 12,
    user_id: USER.id,
    category: 'billing',
    status: 'resolved',
    priority: 'normal',
    subject: 'gpt-5.5 扣费不对',
    request_id: 'RID1234567890',
    order_id: null,
    model: 'gpt-5.5',
    disputed_cny: 0.5,
    resolution: 'credited',
    credit_cny: 0.5,
    reopen_count: 0,
    created_at: new Date('2026-11-06T06:32:00Z'),
    updated_at: new Date('2026-11-06T08:00:00Z'),
    resolved_at: null,
    closed_at: null,
    messages: [
        {
            id: 'm1',
            author_type: 'customer',
            body: '返回空内容但扣了费',
            internal: false,
            attachments: [
                {
                    key: `tickets/${USER.id}/0b0b0b0b-bbbb-4ccc-8ddd-eeeeeeeeeeee.png`,
                    name: 'shot.png',
                    size: 10,
                    type: 'image/png',
                },
            ],
            created_at: new Date('2026-11-06T06:32:00Z'),
        },
        {
            id: 'm2',
            author_type: 'staff',
            body: '已核实并补额',
            internal: false,
            created_at: new Date('2026-11-06T08:00:00Z'),
        },
    ],
    events: [
        { id: 'e1', type: 'created', payload: {}, created_at: new Date('2026-11-06T06:32:00Z') },
        {
            id: 'e2',
            type: 'request_located',
            payload: { model: 'gpt-5.5', cost_cny: 0.5, created_at: 1793946000, failed: false },
            created_at: new Date('2026-11-06T06:32:01Z'),
        },
        { id: 'e3', type: 'credited', payload: { amount_cny: 0.5 }, created_at: new Date('2026-11-06T08:00:01Z') },
        { id: 'e4', type: 'assigned', payload: { to: 'ops' }, created_at: new Date('2026-11-06T07:00:00Z') },
    ],
};

beforeEach(() => {
    vi.clearAllMocks();
    mockGetLocale.mockResolvedValue('zh');
    mockHeadersGet.mockReturnValue('silkroad_session=fake');
    mockGetCurrentUser.mockResolvedValue(USER);
    svc.listTicketsForUser.mockResolvedValue([]);
    mockOrderFindMany.mockResolvedValue([]);
});

describe('/support list', () => {
    it('zh: heading + empty state + new button; default filter active', async () => {
        const html = renderToString(await SupportListPage({}));
        expect(html).toContain('>工单<');
        expect(html).toContain('还没有工单');
        expect(html).toContain('href="/support/new"');
        expect(svc.listTicketsForUser).toHaveBeenCalledWith(USER.id, 'active');
    });
    it('renders rows with number / status badge and honours ?status=resolved', async () => {
        svc.listTicketsForUser.mockResolvedValue([
            {
                id: TID,
                number: 'T-000012',
                subject: 'gpt-5.5 扣费不对',
                category: 'billing',
                status: 'waiting_customer',
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        ]);
        const html = renderToString(await SupportListPage({ searchParams: Promise.resolve({ status: 'resolved' }) }));
        expect(svc.listTicketsForUser).toHaveBeenCalledWith(USER.id, 'resolved');
        expect(html).toContain('T-000012');
        expect(html).toContain('计费争议');
        expect(html).toContain('data-status="waiting_customer"');
        expect(html).toContain(`href="/support/${TID}"`);
    });
    it('en: no CJK in the shell', async () => {
        mockGetLocale.mockResolvedValue('en');
        const html = renderToString(await SupportListPage({}));
        expect(html).toContain('Support tickets');
        expect(html).toContain('No tickets yet');
        expect(html).not.toMatch(/[一-鿿]/);
    });
});

describe('/support/new', () => {
    it('renders the form with 5 categories and the recent orders passed through', async () => {
        mockOrderFindMany.mockResolvedValue([
            { id: 'ord1', amount: 100, status: 'COMPLETED', createdAt: new Date('2026-11-01T00:00:00Z') },
        ]);
        const html = renderToString(await NewTicketPage());
        expect(html).toContain('data-testid="new-ticket-form"');
        expect((html.match(/name="category"/g) ?? []).length).toBe(5);
        expect(html).toContain('计费争议');
        expect(html).toContain('href="/logs"');
        expect(mockOrderFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { user_id: USER.id }, take: 10 }),
        );
    });
    it('still renders when the order query fails', async () => {
        mockOrderFindMany.mockRejectedValue(new Error('db'));
        expect(renderToString(await NewTicketPage())).toContain('data-testid="new-ticket-form"');
    });
});

describe('/support/[id]', () => {
    it('renders meta, thread (customer + staff) and the resolved actions', async () => {
        svc.getTicketForUser.mockResolvedValue(ticket);
        const html = renderToString(await TicketDetailPage({ params: Promise.resolve({ id: TID }) }));
        expect(html).toContain('T-000012');
        expect(html).toContain('gpt-5.5 扣费不对');
        expect(html).toContain('data-author="customer"');
        expect(html).toContain('data-author="staff"');
        expect(html).toContain('Silk Road AI 客服');
        expect(html).toContain('已定位到调用:gpt-5.5');
        expect(html).toContain('已补额 ¥0.50');
        expect(html).toContain('data-testid="ticket-resolved-actions"');
        expect(html).toContain('data-testid="attachments"');
        expect(html).toContain(`https://images.silkroadai.io/tickets/${USER.id}/`);
        expect(html).toContain('问题已解决');
        expect(html).toContain('仍未解决');
        // internal-ish event hidden
        expect(html).not.toContain('assigned');
    });
    it('closed ticket shows the closed notice instead of a reply box', async () => {
        svc.getTicketForUser.mockResolvedValue({ ...ticket, status: 'closed' });
        const html = renderToString(await TicketDetailPage({ params: Promise.resolve({ id: TID }) }));
        expect(html).toContain('工单已关闭');
        expect(html).not.toContain('data-testid="ticket-reply"');
    });
    it('en detail', async () => {
        mockGetLocale.mockResolvedValue('en');
        svc.getTicketForUser.mockResolvedValue({ ...ticket, status: 'open', subject: 'wrong charge' });
        const html = renderToString(await TicketDetailPage({ params: Promise.resolve({ id: TID }) }));
        expect(html).toContain('Call located: gpt-5.5');
        expect(html).toContain('Silk Road AI Support');
        expect(html).toContain('data-testid="ticket-reply"');
        expect(html).toContain('data-testid="attachment-picker"');
    });
    it('404 for a non-uuid id and for someone else’s ticket', async () => {
        await expect(TicketDetailPage({ params: Promise.resolve({ id: 'abc' }) })).rejects.toThrow('NEXT_NOT_FOUND');
        svc.getTicketForUser.mockResolvedValue(null);
        await expect(TicketDetailPage({ params: Promise.resolve({ id: TID }) })).rejects.toThrow('NEXT_NOT_FOUND');
        expect(svc.getTicketForUser).toHaveBeenCalledWith(TID, USER.id);
    });
});

describe('buildThread', () => {
    it('orders by time, drops unknown events, uses Beijing time', () => {
        const items = buildThread(ticket as never, ticketsMessages.zh, 'zh-CN');
        expect(items.map((i) => (i.kind === 'event' ? i.type : i.author))).toEqual([
            'customer',
            'created',
            'request_located',
            'staff',
            'credited',
        ]);
        const located = items.find((i) => i.kind === 'event' && i.type === 'request_located');
        expect(located && located.kind === 'event' ? located.text : '').toContain('2026/11/6 14:20:00');
    });
});

describe('sidebar', () => {
    it('has the 工单 entry linking to /support', () => {
        const html = renderToString(<Sidebar />);
        expect(html).toContain('>工单<');
        expect(html).toMatch(/href="\/support"/);
    });
});
