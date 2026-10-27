/**
 * feat/i18n-zh-en — /reseller entry page in English.
 *
 * Mirrors entry-page.test.tsx but with `@/lib/i18n/server` mocked to `en`
 * (the server page) and the client islands wrapped in
 * `<LocaleProvider locale="en">` (the way the root layout does it).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { LocaleProvider } from '@/lib/i18n/client';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockHeadersGet = vi.fn();
vi.mock('next/headers', () => ({
    headers: vi.fn(async () => ({ get: mockHeadersGet })),
}));

vi.mock('next/navigation', () => ({
    redirect: vi.fn(),
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const mockFetchResellerStatus = vi.fn();
vi.mock('@/lib/reseller/fetch-status', () => ({
    fetchResellerStatus: (...args: unknown[]) => mockFetchResellerStatus(...args),
}));

vi.mock('@/lib/i18n/server', () => ({
    getLocale: async () => 'en',
    getMessages: async (d: { en: unknown }) => d.en,
}));

import ResellerEntryPage, { generateMetadata } from '@/app/(authenticated)/reseller/page';

const USER = { id: 'aaaa-1111-1111-1111', email: 'a@b.io' };

beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockReturnValue(USER);
    mockHeadersGet.mockReturnValue('silkroad_session=fake');
});

describe('/reseller entry page (en)', () => {
    it('generateMetadata → English title', async () => {
        await expect(generateMetadata()).resolves.toEqual({ title: 'Join the reseller program — Silk Road AI' });
    });

    it('status=null → English join page (intro + bullets + agreement + form)', async () => {
        mockFetchResellerStatus.mockResolvedValueOnce({ status: null, isReseller: false });
        const el = await ResellerEntryPage();
        const html = renderToString(<LocaleProvider locale="en">{el}</LocaleProvider>);
        expect(html).toContain('Reseller program');
        expect(html).toContain('Become a Silk Road AI reseller');
        expect(html).toContain('24-month attribution window');
        expect(html).toContain('Bronze 10% → Silver 15% → Gold 20%');
        expect(html).toContain('Open enrollment');
        expect(html).toContain('Silk Road AI Reseller Agreement'); // disclosure toggle
        expect(html).toContain('I have read and agree'); // join form checkbox
        expect(html).not.toContain('加入 Silk Road AI 代理');
        expect(html).not.toContain('我已阅读并同意');
    });

    it('status=suspended → English suspended view (no join form)', async () => {
        mockFetchResellerStatus.mockResolvedValueOnce({ status: 'suspended', isReseller: false });
        const el = await ResellerEntryPage();
        const html = renderToString(<LocaleProvider locale="en">{el}</LocaleProvider>);
        expect(html).toContain('Reseller status');
        expect(html).toContain('Account suspended');
        expect(html).toContain('new referrals no longer earn commission');
        expect(html).not.toContain('I have read and agree');
        expect(html).not.toContain('账户已暂停');
    });

    it('status=banned → English banned view', async () => {
        mockFetchResellerStatus.mockResolvedValueOnce({ status: 'banned', isReseller: false });
        const el = await ResellerEntryPage();
        const html = renderToString(<LocaleProvider locale="en">{el}</LocaleProvider>);
        expect(html).toContain('Account banned');
        expect(html).not.toContain('账户已封禁');
    });
});
