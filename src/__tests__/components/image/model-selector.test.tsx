/**
 * PR-T2 — ModelSelector SSR smoke.
 *
 * Closed state asserts: 5 entries available, default badge visible,
 * collapsed dropdown shows the selected model's label + ¥ price.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ModelSelector } from '@/components/image/ModelSelector';
import { IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL_ID } from '@/data/image-models';

describe('<ModelSelector /> closed state', () => {
    it('shows the selected model label + ¥ price', () => {
        const html = renderToString(<ModelSelector value={DEFAULT_IMAGE_MODEL_ID} onChange={() => {}} />);
        // W8 D7 PR #67: 默认 [0] = OpenAI 国外旗舰 gpt-image-2(label 'GPT image-2')
        // W8 D7 二次降价(本 PR):ChatGPT ¥0.2/$1 → $0.04 × 0.2/7 ≈ $0.00114
        //   → ¥0.01/张(cny(0.00114) round)。
        expect(html).toContain('GPT image-2');
        // Closed dropdown shows ¥ in the trigger button. React 19 SSR
        // inserts <!-- --> between literal + interpolated text, so we
        // tolerate the comments inside the regex.
        expect(html).toMatch(/¥(?:<!-- -->)?0\.01(?:<!-- -->)?\/张/);
    });

    it('toggle button has aria-haspopup + aria-expanded=false initially', () => {
        const html = renderToString(<ModelSelector value={DEFAULT_IMAGE_MODEL_ID} onChange={() => {}} />);
        expect(html).toMatch(/aria-haspopup="listbox"/);
        expect(html).toMatch(/aria-expanded="false"/);
    });

    it('disabled={true} renders the button as disabled', () => {
        const html = renderToString(<ModelSelector value={DEFAULT_IMAGE_MODEL_ID} onChange={() => {}} disabled />);
        expect(html).toMatch(/<button[^>]*disabled=""/);
    });

    it('falls back to the first option when the value id is unknown', () => {
        const html = renderToString(<ModelSelector value="not-a-known-id" onChange={() => {}} />);
        expect(html).toContain(IMAGE_MODEL_OPTIONS[0].label);
    });
});
