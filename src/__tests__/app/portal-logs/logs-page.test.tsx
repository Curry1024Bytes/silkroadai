/**
 * /logs page + <LogsViewer /> SSR smoke (zh default + English). Effects don't
 * run under renderToString, so no fetch is issued — this pins the static
 * markup contract (headings, filter labels, buttons, empty state).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const mockLocale = vi.fn<() => Promise<'zh' | 'en'>>(async () => 'zh');
vi.mock('@/lib/i18n/server', () => ({
    getLocale: () => mockLocale(),
    getMessages: async (d: { zh: unknown; en: unknown }) => ((await mockLocale()) === 'en' ? d.en : d.zh),
}));

import LogsPage, { generateMetadata } from '@/app/(authenticated)/logs/page';
import { LogsViewer } from '@/app/(authenticated)/logs/logs-viewer';
import { LocaleProvider } from '@/lib/i18n/client';

afterEach(() => {
    mockLocale.mockResolvedValue('zh');
});

describe('/logs (zh default)', () => {
    it('renders heading, filter labels, search / export buttons and the empty state in Chinese', async () => {
        const html = renderToString(await LogsPage());
        expect(html).toContain('调用日志');
        expect(html).toContain('起始时间');
        expect(html).toContain('结束时间');
        expect(html).toContain('令牌名(Key)');
        expect(html).toContain('渠道 ID');
        expect(html).toContain('导出 CSV');
        expect(html).toContain('>搜索<');
        expect(html).toContain('该时间段 / 条件下暂无调用记录');
        expect(html).toContain('上一页');
        expect(await generateMetadata()).toEqual({ title: '调用日志 · Silk Road AI' });
    });
});

describe('/logs (English)', () => {
    it('server shell + client viewer render in English', async () => {
        mockLocale.mockResolvedValue('en');
        const page = await LogsPage();
        const html = renderToString(<LocaleProvider locale="en">{page}</LocaleProvider>);
        expect(html).toContain('Request logs');
        expect(html).toContain('>From<');
        expect(html).toContain('>To<');
        expect(html).toContain('API key name');
        expect(html).toContain('Channel ID');
        expect(html).toContain('Export CSV');
        expect(html).toContain('>Search<');
        expect(html).toContain('No requests match this period / filter');
        expect(html).toContain('Page 1');
        expect(html).toContain('Previous');
        for (const zh of ['调用日志', '起始时间', '导出 CSV', '搜索', '上一页']) expect(html, zh).not.toContain(zh);
        expect(await generateMetadata()).toEqual({ title: 'Request logs · Silk Road AI' });
    });

    it('viewer placeholders follow the locale', () => {
        const html = renderToString(
            <LocaleProvider locale="en">
                <LogsViewer />
            </LocaleProvider>,
        );
        expect(html).toContain('placeholder="Exact match"');
        expect(html).toContain('placeholder="e.g. prod-openai"');
        expect(html).not.toContain('精确匹配');
    });
});
