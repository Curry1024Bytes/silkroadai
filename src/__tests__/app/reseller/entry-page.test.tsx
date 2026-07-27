/**
 * fix/reseller-entry-discovery — /reseller entry page polymorphic render.
 *
 * Server-side gating:
 *   - status='active' → redirect to /reseller/dashboard
 *   - status='suspended' → render "账户已暂停" view
 *   - status='banned' → render "账户已封禁" view
 *   - status=null → render join page (agreement + form)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockHeadersGet = vi.fn();
vi.mock('next/headers', () => ({
    headers: vi.fn(async () => ({ get: mockHeadersGet })),
}));

const mockRedirect = vi.fn((url: string) => {
    throw Object.assign(new Error('REDIRECT'), { _redirectUrl: url });
});
vi.mock('next/navigation', () => ({
    redirect: (url: string) => mockRedirect(url),
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const mockFetchResellerStatus = vi.fn();
vi.mock('@/lib/reseller/fetch-status', () => ({
    fetchResellerStatus: (...args: unknown[]) => mockFetchResellerStatus(...args),
}));

import ResellerEntryPage from '@/app/(authenticated)/reseller/page';

const USER = { id: 'aaaa-1111-1111-1111', email: 'a@b.io' };

beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockReturnValue(USER);
    mockHeadersGet.mockReturnValue('silkroad_session=fake');
});

describe('/reseller entry page', () => {
    it('status=active → redirects to /reseller/dashboard', async () => {
        mockFetchResellerStatus.mockResolvedValueOnce({
            status: 'active',
            isReseller: true,
            tier: 'bronze',
        });
        await expect(ResellerEntryPage()).rejects.toThrow('REDIRECT');
        expect(mockRedirect).toHaveBeenCalledWith('/reseller/dashboard');
    });

    it('status=null → renders join page (agreement + form)', async () => {
        mockFetchResellerStatus.mockResolvedValueOnce({ status: null, isReseller: false });
        const el = await ResellerEntryPage();
        const html = renderToString(el);
        expect(html).toContain('加入 LLmRoute 代理');
        expect(html).toContain('代理合作协议'); // disclosure toggle
        expect(html).toContain('我已阅读并同意'); // join form checkbox
    });

    it('status=suspended → renders 账户已暂停 view (NOT join form)', async () => {
        mockFetchResellerStatus.mockResolvedValueOnce({ status: 'suspended', isReseller: false });
        const el = await ResellerEntryPage();
        const html = renderToString(el);
        expect(html).toContain('账户已暂停');
        // Join form should NOT be rendered for suspended users
        expect(html).not.toContain('我已阅读并同意');
    });

    it('status=banned → renders 账户已封禁 view', async () => {
        mockFetchResellerStatus.mockResolvedValueOnce({ status: 'banned', isReseller: false });
        const el = await ResellerEntryPage();
        const html = renderToString(el);
        expect(html).toContain('账户已封禁');
        expect(html).not.toContain('我已阅读并同意');
    });
});
