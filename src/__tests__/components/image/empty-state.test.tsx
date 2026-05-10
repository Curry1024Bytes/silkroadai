/**
 * PR-T2 — ImageEmptyState SSR smoke. Sample prompts rendered as
 * accessible buttons.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ImageEmptyState } from '@/components/image/EmptyState';
import { SAMPLE_PROMPTS } from '@/data/image-models';

describe('<ImageEmptyState />', () => {
    it('renders the headline + sample buttons', () => {
        const html = renderToString(<ImageEmptyState onPickSample={() => {}} />);
        expect(html).toContain('你的第一张图等你创造');
        for (const p of SAMPLE_PROMPTS) {
            expect(html).toContain(p);
        }
    });

    it('every sample is a button (clickable to pick the prompt)', () => {
        const html = renderToString(<ImageEmptyState onPickSample={() => {}} />);
        const buttonOpens = (html.match(/<button[^>]*type="button"/g) ?? []).length;
        // Should be at least SAMPLE_PROMPTS.length buttons (one per sample).
        expect(buttonOpens).toBeGreaterThanOrEqual(SAMPLE_PROMPTS.length);
    });
});
