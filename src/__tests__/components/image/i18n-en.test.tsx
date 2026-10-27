/**
 * i18n — `src/components/image/*` rendered under `<LocaleProvider locale="en">`.
 *
 * The sibling per-component tests keep asserting the Chinese default (no
 * provider → zh); this file covers the English edition of the same copy.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { LocaleProvider } from '@/lib/i18n/client';
import { BalanceShortfallModal } from '@/components/image/BalanceShortfallModal';
import { ContentFilterModal } from '@/components/image/ContentFilterModal';
import { LargeCostConfirmModal } from '@/components/image/LargeCostConfirmModal';
import { GenerateButton } from '@/components/image/GenerateButton';
import { ImageEmptyState } from '@/components/image/EmptyState';
import { ModelSelector } from '@/components/image/ModelSelector';
import { RateLimitToast } from '@/components/image/RateLimitToast';
import { SizeSelector } from '@/components/image/SizeCountSelectors';
import { PromptInput } from '@/components/image/PromptInput';
import { ImageModal } from '@/components/image/ImageModal';
import { DEFAULT_IMAGE_MODEL_ID, SAMPLE_PROMPTS_EN } from '@/data/image-models';
import type { ImageGenerationItem } from '@/components/image/types';

const en = (node: React.ReactNode) => renderToString(<LocaleProvider locale="en">{node}</LocaleProvider>);
const HAN = /[\u4e00-\u9fff]/;
/** The shared `ui/Modal` X button (`aria-label="关闭"`) is outside this
 *  area's scope — strip it so the no-Chinese check covers our copy only. */
const sansModalClose = (html: string) => html.replace(/aria-label="关闭"/g, '');

describe('components/image — English locale', () => {
    it('BalanceShortfallModal', () => {
        const html = en(<BalanceShortfallModal open onClose={() => {}} requiredCny={1.96} remainCny={0.5} />);
        expect(html).toContain('Insufficient balance');
        expect(html).toContain('current balance');
        expect(html).toContain('Top up →');
        expect(html).toContain('1.96');
        expect(sansModalClose(html)).not.toMatch(HAN);
    });

    it('ContentFilterModal', () => {
        const html = en(<ContentFilterModal open onClose={() => {}} />);
        expect(html).toContain('Content safety filter');
        expect(html).toContain('You were not charged.');
        expect(html).toContain('Violence / horror / gore');
        expect(sansModalClose(html)).not.toMatch(HAN);
    });

    it('LargeCostConfirmModal', () => {
        const html = en(
            <LargeCostConfirmModal open onCancel={() => {}} onConfirm={() => {}} costCny={7.84} remainCny={20} />,
        );
        expect(html).toContain('Confirm generation');
        expect(html).toContain('This will cost');
        expect(html).toContain('20.00');
        expect(html).not.toMatch(HAN);
    });

    it('GenerateButton states', () => {
        expect(en(<GenerateButton state="idle" onClick={() => {}} />)).toContain('Generate →');
        expect(en(<GenerateButton state="loading" onClick={() => {}} />)).toContain('Generating…');
        expect(en(<GenerateButton state="error" onClick={() => {}} errorMessage="x" />)).toContain('Retry');
    });

    it('ImageEmptyState uses the English sample prompts', () => {
        const html = en(<ImageEmptyState onPickSample={() => {}} />);
        expect(html).toContain('Your first image is waiting');
        for (const p of SAMPLE_PROMPTS_EN) expect(html).toContain(p);
        expect(html).not.toMatch(HAN);
    });

    it('ModelSelector shows English blurb / badge / per-image unit', () => {
        const html = en(<ModelSelector value={DEFAULT_IMAGE_MODEL_ID} onChange={() => {}} />);
        expect(html).toContain('GPT image-2');
        expect(html).toContain('Recommended');
        expect(html).toContain('OpenAI · GPT-5 multimodal image generation');
        expect(html).toMatch(/¥(?:<!-- -->)?0\.05(?:<!-- -->)?\/image/);
        expect(html).not.toMatch(HAN);
    });

    it('RateLimitToast', () => {
        const html = en(<RateLimitToast retryAfterMs={42_000} onExpire={() => {}} onDismiss={() => {}} />);
        expect(html).toContain('10 generations per minute');
        expect(html).toContain('42');
        expect(html).toMatch(/aria-label="Close"/);
    });

    it('SizeSelector labels + PromptInput placeholder', () => {
        const sizes = en(<SizeSelector value="1024x1024" onChange={() => {}} />);
        expect(sizes).toContain('Square');
        expect(sizes).toContain('Portrait');
        expect(sizes).toContain('Landscape');
        expect(sizes).toMatch(/aria-label="Image size"/);
        const prompt = en(<PromptInput value="" onChange={() => {}} />);
        expect(prompt).toContain('Describe the image you want...');
    });

    it('ImageModal fields + en-US date formatting (Asia/Shanghai)', () => {
        const item: ImageGenerationItem = {
            id: 'g1',
            prompt: 'a cat',
            model_name: 'gpt-image-2',
            size: '1024x1024',
            count: 1,
            image_urls: ['https://images.example/x.png'],
            cost_usd: 0.0071,
            is_favorite: false,
            created_at: '2026-05-23T07:52:00.000Z',
            expires_at: null,
        };
        const html = en(
            <ImageModal
                item={item}
                initialIndex={0}
                onClose={() => {}}
                onToggleFavorite={async () => {}}
                onDelete={async () => {}}
            />,
        );
        expect(html).toContain('Never (favorite)');
        expect(html).toContain('Copy prompt');
        expect(html).toContain('Download');
        // 07:52Z → 15:52 Beijing, rendered via en-US (12-hour clock).
        expect(html).toMatch(/3:52:00\s*PM/);
        expect(html).not.toMatch(HAN);
    });
});
