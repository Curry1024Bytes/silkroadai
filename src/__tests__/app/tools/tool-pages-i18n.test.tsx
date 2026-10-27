/**
 * /tools/{chat,image,seedance} SSR smoke in both locales. The client
 * islands render their initial (no-key) state, so the API-key box copy is
 * covered too. zh = pre-i18n byte-identical copy; en = translated.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { LocaleProvider } from '@/lib/i18n/client';
import ChatToolPage, { generateMetadata as chatMeta } from '@/app/tools/chat/page';
import ImageToolPage, { generateMetadata as imageMeta } from '@/app/tools/image/page';
import SeedanceToolPage, { generateMetadata as seedanceMeta } from '@/app/tools/seedance/page';

const localeState = { value: 'zh' as 'zh' | 'en' };
vi.mock('@/lib/i18n/server', () => ({
    getLocale: async () => localeState.value,
    getMessages: async (d: { zh: unknown; en: unknown }) => (localeState.value === 'en' ? d.en : d.zh),
}));

const HAN = /[\u4e00-\u9fff]/;

describe('/tools/* pages — zh default', () => {
    it('chat / image / seedance render the Chinese shell + key box', async () => {
        localeState.value = 'zh';
        const chat = renderToString(await ChatToolPage());
        expect(chat).toContain('AI 对话测试工具');
        expect(chat).toContain('你的 API Key');
        expect(chat).toContain('加载模型');
        const image = renderToString(await ImageToolPage());
        expect(image).toContain('AI 生图测试工具');
        expect(image).toContain('Key 只用于本次调用、不保存。在「API 密钥」页用复制按钮取。');
        const seedance = renderToString(await SeedanceToolPage());
        expect(seedance).toContain('Seedance 视频测试工具');
        expect(seedance).toContain('避免手敲混淆');
        expect((await seedanceMeta()).title).toBe('Seedance 视频测试工具 · Silk Road AI');
    });
});

describe('/tools/* pages — en', () => {
    it('chat / image / seedance render English copy with no Chinese left', async () => {
        localeState.value = 'en';
        const wrap = (node: React.ReactNode) => renderToString(<LocaleProvider locale="en">{node}</LocaleProvider>);
        const chat = wrap(await ChatToolPage());
        expect(chat).toContain('AI Chat Tester');
        expect(chat).toContain('Your API key');
        expect(chat).toContain('Load models');
        expect(chat).toContain('← Back');
        expect(chat).not.toMatch(HAN);
        const image = wrap(await ImageToolPage());
        expect(image).toContain('Image Generation Tester');
        expect(image).not.toMatch(HAN);
        const seedance = wrap(await SeedanceToolPage());
        expect(seedance).toContain('Seedance Video Tester');
        expect(seedance).toContain('Copy it from the API Keys page to avoid typos.');
        expect(seedance).not.toMatch(HAN);
        expect((await chatMeta()).title).toBe('AI Chat Tester · Silk Road AI');
        expect((await imageMeta()).title).toBe('Image Generation Tester · Silk Road AI');
        localeState.value = 'zh';
    });
});
