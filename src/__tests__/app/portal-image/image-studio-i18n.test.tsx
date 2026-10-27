/**
 * /image — `<ImageStudio />` island SSR smoke in zh and en (first paint:
 * selectors + empty state + cost preview + generate button). The page
 * shell itself needs prisma + request headers, so `generateMetadata` is the
 * only page-level export covered here.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { LocaleProvider } from '@/lib/i18n/client';
import { ImageStudio } from '@/app/(authenticated)/image/image-studio';

const localeState = { value: 'zh' as 'zh' | 'en' };
vi.mock('@/lib/i18n/server', () => ({
    getLocale: async () => localeState.value,
    getMessages: async (d: { zh: unknown; en: unknown }) => (localeState.value === 'en' ? d.en : d.zh),
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: async () => null }));
vi.mock('@/lib/r2/client', () => ({ getPublicUrl: (k: string) => k }));

const { generateMetadata } = await import('@/app/(authenticated)/image/page');
const HAN = /[\u4e00-\u9fff]/;

describe('<ImageStudio /> — zh default', () => {
    it('renders the Chinese labels, empty state and generate CTA', () => {
        const html = renderToString(<ImageStudio initialLatest={null} />);
        expect(html).toContain('模型');
        expect(html).toContain('尺寸');
        expect(html).toContain('数量');
        expect(html).toContain('你的第一张图等你创造');
        expect(html).toContain('本次约');
        expect(html).toContain('生成 →');
    });

    it('metadata title is Chinese by default', async () => {
        localeState.value = 'zh';
        expect((await generateMetadata()).title).toBe('AI 生图 — Silk Road AI');
    });
});

describe('<ImageStudio /> — en', () => {
    it('renders English labels, sample prompts and CTA with no Chinese left', () => {
        const html = renderToString(
            <LocaleProvider locale="en">
                <ImageStudio initialLatest={null} />
            </LocaleProvider>,
        );
        expect(html).toContain('Model');
        expect(html).toContain('Size');
        expect(html).toContain('Count');
        expect(html).toContain('Your first image is waiting');
        expect(html).toContain('Estimated cost');
        expect(html).toContain('Generate →');
        expect(html).toContain('Square');
        expect(html).not.toMatch(HAN);
    });

    it('metadata title is English under locale=en', async () => {
        localeState.value = 'en';
        expect((await generateMetadata()).title).toBe('Image Studio — Silk Road AI');
        localeState.value = 'zh';
    });
});
