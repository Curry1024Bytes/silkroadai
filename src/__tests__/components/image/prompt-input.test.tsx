/**
 * PR-T2 — PromptInput SSR smoke.
 *
 * Asserts char counter visibility + over-limit aria-invalid.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { PromptInput } from '@/components/image/PromptInput';
import { PROMPT_MAX_CHARS } from '@/data/image-models';

describe('<PromptInput />', () => {
    it('renders the textarea + counter with the right cap', () => {
        const html = renderToString(<PromptInput value="hi" onChange={() => {}} />);
        expect(html).toMatch(/<textarea/);
        // Counter "current/max" — React 19 inserts <!-- --> between
        // literal + interpolated text fragments.
        expect(html).toMatch(new RegExp(`2(?:<!-- -->)?\\s*\\/(?:<!-- -->)?\\s*${PROMPT_MAX_CHARS}`));
    });

    it('aria-invalid=true when value exceeds the cap', () => {
        const long = 'x'.repeat(PROMPT_MAX_CHARS + 5);
        const html = renderToString(<PromptInput value={long} onChange={() => {}} />);
        expect(html).toMatch(/aria-invalid="true"/);
    });

    it('aria-invalid=false when within the cap', () => {
        const html = renderToString(<PromptInput value="hello" onChange={() => {}} />);
        expect(html).toMatch(/aria-invalid="false"/);
    });

    it('disabled renders the textarea as disabled', () => {
        const html = renderToString(<PromptInput value="" onChange={() => {}} disabled />);
        expect(html).toMatch(/<textarea[^>]*disabled=""/);
    });
});
