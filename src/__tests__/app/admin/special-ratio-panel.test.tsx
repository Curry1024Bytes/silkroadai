import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { SpecialRatioPanel } from '@/app/admin/(console)/customers/[id]/special-ratio-panel';

describe('<SpecialRatioPanel /> SSR smoke', () => {
    it('renders the section title and loading state (data arrives client-side)', () => {
        const html = renderToString(
            <SpecialRatioPanel customerId="u-1" isDark={false} card="c" sectionTitle="s" muted="m" />,
        );
        expect(html).toContain('专属倍率');
        expect(html).toContain('读取中');
        expect(html).toContain('data-testid="special-ratio-panel"');
    });
});
