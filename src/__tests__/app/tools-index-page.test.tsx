/**
 * /tools 工具箱索引页 SSR smoke — 控制台侧边栏「工具箱」指向此页(不跳落地页)。
 * 断言 5 张工具卡的标题 + href 都在。next/link 在 renderToString 下渲染为 <a href>。
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import ToolsIndexPage, { generateMetadata } from '@/app/tools/page';

// i18n: the locale is switchable per test (default zh = pre-i18n behaviour).
const localeState = { value: 'zh' as 'zh' | 'en' };
vi.mock('@/lib/i18n/server', () => ({
    getLocale: async () => localeState.value,
    getMessages: async (d: { zh: unknown; en: unknown }) => (localeState.value === 'en' ? d.en : d.zh),
}));

describe('工具箱 /tools index', () => {
    it('renders the 5 tool cards with correct hrefs', async () => {
        localeState.value = 'zh';
        const html = renderToString(await ToolsIndexPage());
        expect(html).toContain('工具箱');
        expect(html).toContain('Seedance 视频测试工具');
        expect(html).toContain('AI 对话测试工具');
        expect(html).toContain('AI 生图测试工具');
        expect(html).toMatch(/href="\/tools\/seedance"/);
        expect(html).toMatch(/href="\/tools\/chat"/);
        expect(html).toMatch(/href="\/tools\/image"/);
        expect(html).toMatch(/href="\/docs#codex-cli"/);
        expect(html).toMatch(/href="\/docs#claude-code"/);
    });

    it('renders English copy + title when the locale is en (hrefs unchanged)', async () => {
        localeState.value = 'en';
        const html = renderToString(await ToolsIndexPage());
        expect(html).toContain('Tools');
        expect(html).toContain('Seedance Video Tester');
        expect(html).toContain('AI Chat Tester');
        expect(html).toContain('Image Generation Tester');
        expect(html).toContain('Connect OpenAI Codex');
        expect(html).toContain('← Back');
        expect(html).not.toMatch(/[\u4e00-\u9fff]/);
        expect(html).toMatch(/href="\/tools\/seedance"/);
        expect(html).toMatch(/href="\/docs#claude-code"/);
        const meta = await generateMetadata();
        expect(meta.title).toBe('Tools · Silk Road AI');
        localeState.value = 'zh';
    });
});
