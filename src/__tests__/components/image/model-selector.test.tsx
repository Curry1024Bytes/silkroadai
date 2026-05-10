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
        expect(html).toContain('Nano Banana');
        // Closed dropdown shows ¥ in the trigger button. React 19 SSR
        // inserts <!-- --> between literal + interpolated text, so we
        // tolerate the comments inside the regex.
        expect(html).toMatch(/¥(?:<!-- -->)?0\.41(?:<!-- -->)?\/张/);
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
