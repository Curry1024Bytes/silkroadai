/**
 * PR-T2 — SizeSelector + CountSelector SSR smoke.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { SizeSelector, CountSelector } from '@/components/image/SizeCountSelectors';

describe('<SizeSelector />', () => {
    it('renders 3 radios with aria-checked reflecting value', () => {
        const html = renderToString(<SizeSelector value="1024x1024" onChange={() => {}} />);
        expect(html).toMatch(/role="radiogroup"/);
        // 3 radio buttons + aria-checked=true on the matching one
        const radios = html.match(/role="radio"/g) ?? [];
        expect(radios).toHaveLength(3);
        const checkedTrue = html.match(/aria-checked="true"/g) ?? [];
        expect(checkedTrue).toHaveLength(1);
        expect(html).toMatch(/aria-checked="true"[^>]*>\s*<span[^>]*>正方形/);
    });

    it('shows the dimension hint on each option (1024×1024 / 1024×1792 / 1792×1024)', () => {
        const html = renderToString(<SizeSelector value="1024x1024" onChange={() => {}} />);
        expect(html).toContain('1024×1024');
        expect(html).toContain('1024×1792');
        expect(html).toContain('1792×1024');
    });
});

describe('<CountSelector />', () => {
    it('renders 4 radios labeled 1..4', () => {
        const html = renderToString(<CountSelector value={1} onChange={() => {}} />);
        const radios = html.match(/role="radio"/g) ?? [];
        expect(radios).toHaveLength(4);
        for (const n of [1, 2, 3, 4]) {
            expect(html).toContain(`>${n}<`);
        }
    });

    it('marks the selected count with aria-checked=true (and only that one)', () => {
        const html = renderToString(<CountSelector value={3} onChange={() => {}} />);
        const checked = html.match(/aria-checked="true"/g) ?? [];
        expect(checked).toHaveLength(1);
        expect(html).toMatch(/aria-checked="true"[^>]*>\s*3\s*</);
    });
});
