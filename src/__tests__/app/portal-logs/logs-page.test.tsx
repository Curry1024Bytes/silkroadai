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
import { logModelOptions, LogsViewer } from '@/app/(authenticated)/logs/logs-viewer';
import { LocaleProvider } from '@/lib/i18n/client';
import { getLogDatePresets } from '@/components/date-range-picker';

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
        expect(html).toContain('全部 Key');
        expect(html).toContain('全部模型');
        expect(html).toContain('渠道 ID');
        expect(html).toContain('导出 CSV');
        expect(html).toContain('查询中…');
        expect(html).toContain('正在加载调用记录…');
        expect(html).toContain('上一页');
        expect(await generateMetadata()).toEqual({ title: '调用日志 · LLmRoute' });
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
        expect(html).toContain('Searching…');
        expect(html).toContain('Loading request logs…');
        expect(html).toContain('Page 1');
        expect(html).toContain('Previous');
        for (const zh of ['调用日志', '起始时间', '导出 CSV', '搜索', '上一页']) expect(html, zh).not.toContain(zh);
        expect(await generateMetadata()).toEqual({ title: 'Request logs · LLmRoute' });
    });

    it('viewer filter controls follow the locale', () => {
        const html = renderToString(
            <LocaleProvider locale="en">
                <LogsViewer />
            </LocaleProvider>,
        );
        expect(html).toContain('placeholder="Exact match"');
        expect(html).toContain('All keys');
        expect(html).toContain('All models');
        expect(html).toContain('Enter manually');
        expect(html).not.toContain('精确匹配');
    });
});

describe('log filter controls', () => {
    it('selects models for the Key tier and keeps both tiers for shared aliases', () => {
        const keys = [
            { key_alias: 'video', tier: 'sd' },
            { key_alias: 'shared', tier: 'sd' },
            { key_alias: 'shared', tier: 'kiro' },
        ];
        const models = [
            { model_name: 'seedance-2.5', enable_groups: ['sd'] },
            { model_name: 'claude-opus', enable_groups: ['kiro'] },
        ];
        expect(logModelOptions(models, keys, 'video')).toEqual(['seedance-2.5']);
        expect(logModelOptions(models, keys, 'shared')).toEqual(['claude-opus', 'seedance-2.5']);
        expect(logModelOptions(models, keys, 'archived-key')).toEqual(['claude-opus', 'seedance-2.5']);
    });

    it('includes the last second of yesterday and defaults to a non-zero range', () => {
        const presets = getLogDatePresets(new Date(2026, 10, 23, 15, 50, 0));
        expect(presets.yesterday).toEqual({ start: '2026-11-22T00:00', end: '2026-11-22T23:59:59' });
        expect(presets.last7d).toEqual({ start: '2026-11-16T15:50', end: '2026-11-23T15:50' });
    });
});
