/**
 * /chat — page shell + `<ChatConsole />` island SSR smoke in zh and en.
 * `listChatModels` is mocked (server-only new-api client). assistant-ui's
 * `<ThreadPrimitive.Empty>` does not paint under renderToString, so the
 * toolbar / composer chrome is what gets asserted.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { LocaleProvider } from '@/lib/i18n/client';

const localeState = { value: 'zh' as 'zh' | 'en' };
vi.mock('@/lib/i18n/server', () => ({
    getLocale: async () => localeState.value,
    getMessages: async (d: { zh: unknown; en: unknown }) => (localeState.value === 'en' ? d.en : d.zh),
}));

const modelsState = { total: 2 };
vi.mock('@/lib/chat/models', () => ({
    listChatModels: async () => {
        if (modelsState.total === 0) return { groups: [], flat: [], totalModels: 0 };
        const models = [
            { id: 'gpt-5.4', vendor: 'OpenAI', vision: false, priceMultiplier: 2 },
            { id: 'claude-opus-4-8', vendor: 'Anthropic', vision: true },
        ];
        return {
            groups: [
                { vendor: 'OpenAI', models: [models[0]] },
                { vendor: 'Anthropic', models: [models[1]] },
            ],
            flat: models,
            totalModels: 2,
        };
    },
}));

const { default: ChatPage, generateMetadata } = await import('@/app/(authenticated)/chat/page');
const HAN = /[\u4e00-\u9fff]/;

describe('/chat page — zh default', () => {
    it('renders the Chinese heading + console chrome', async () => {
        localeState.value = 'zh';
        modelsState.total = 2;
        const html = renderToString(await ChatPage());
        expect(html).toContain('AI 对话');
        expect(html).toContain('新对话');
        expect(html).toContain('联网');
        expect(html).toContain('官方 2×');
        expect(html).toMatch(/placeholder="输入消息,Enter 发送,Shift\+Enter 换行"/);
        expect(html).toContain('gpt-5.4');
        expect((await generateMetadata()).title).toBe('AI 对话 — Silk Road AI');
    });

    it('empty model list → Chinese banner', async () => {
        modelsState.total = 0;
        const html = renderToString(await ChatPage());
        expect(html).toContain('当前无法获取可用模型,请稍后重试。');
    });
});

describe('/chat page — en', () => {
    it('renders English heading + console chrome with no Chinese left', async () => {
        localeState.value = 'en';
        modelsState.total = 2;
        const html = renderToString(<LocaleProvider locale="en">{await ChatPage()}</LocaleProvider>);
        expect(html).toContain('AI Chat');
        expect(html).toContain('New chat');
        expect(html).toContain('Official 2×');
        expect(html).toContain('Send');
        expect(html).toMatch(/placeholder="Type a message — Enter to send, Shift\+Enter for a new line"/);
        expect(html).not.toMatch(HAN);
        expect((await generateMetadata()).title).toBe('AI Chat — Silk Road AI');
    });

    it('empty model list → English banner', async () => {
        modelsState.total = 0;
        const html = renderToString(await ChatPage());
        expect(html).toContain('Model list is unavailable right now');
        localeState.value = 'zh';
    });
});
