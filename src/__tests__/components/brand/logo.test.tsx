/**
 * <Logo /> SSR smoke — same react-dom/server pattern as W4-1 D2 pay-form
 * tests / W6 D3 models page tests.
 *
 * Asserts:
 *   - Each variant resolves to its own asset src (via the static-import
 *     URL Next produces).
 *   - `size` prop drives both height and width-by-aspect.
 *   - `linkHome=true` (default) wraps in `<a href="/">` with the
 *     accessible label.
 *   - `linkHome=false` strips the wrapper.
 *   - Mark variant renders the square (1:1) aspect; full-logo variants
 *     render the 4:1 aspect.
 *
 * Uses the actual Logo.tsx — does NOT mock the SVG imports — to confirm
 * the asset URLs round-trip through Next's static-asset handling. Vitest
 * resolves `*.svg` to URL strings via Next's default loader (works
 * because the imported value satisfies StaticImageData in vitest's
 * jsdom-free env: src is the path, width/height come from the SVG's
 * intrinsic viewBox).
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Logo } from '@/components/brand/Logo';

describe('<Logo /> SSR (brand assets PR)', () => {
    it('default render: primary variant, size 24, wrapped in href="/"', () => {
        const html = renderToString(<Logo />);
        // Wrapped in a Next Link (renders <a href>)
        expect(html).toMatch(/<a[^>]*href="\/"/);
        // Accessible label on the link
        expect(html).toMatch(/aria-label="Silk Road AI"/);
        // <img> with alt + measured dims; full-logo aspect is 4:1, so
        // width = 4 × height = 96 at size=24.
        expect(html).toMatch(/<img[^>]*alt="Silk Road AI"/);
        expect(html).toMatch(/height="24"/);
        expect(html).toMatch(/width="96"/);
    });

    it('linkHome={false} strips the wrapping anchor', () => {
        const html = renderToString(<Logo linkHome={false} />);
        expect(html).not.toContain('<a ');
        expect(html).toMatch(/<img[^>]*alt="Silk Road AI"/);
    });

    it('size prop scales height + width by intrinsic aspect', () => {
        const html = renderToString(<Logo size={28} linkHome={false} />);
        // 4:1 horizontal logo at height=28 → width=112
        expect(html).toMatch(/height="28"/);
        expect(html).toMatch(/width="112"/);
    });

    it('mark variant has 1:1 aspect (square)', () => {
        const html = renderToString(<Logo variant="mark" size={32} linkHome={false} />);
        expect(html).toMatch(/height="32"/);
        // Mark is 24×24 viewBox → 1:1 aspect → width = height
        expect(html).toMatch(/width="32"/);
    });

    it('each variant resolves to a distinct asset src', () => {
        const variants = [
            'primary',
            'primary-flat',
            'inverse',
            'mono-dark',
            'mono-light',
            'mark',
        ] as const;
        const seen = new Set<string>();
        for (const v of variants) {
            const html = renderToString(<Logo variant={v} linkHome={false} />);
            // In production Next: src="/_next/static/media/foo.<hash>.svg".
            // In Vitest under Vite: src="data:image/svg+xml;base64,..."
            // Either form is a real URL the browser can render; we just
            // confirm a non-empty src is present and that variants don't
            // collide.
            const m = html.match(/src="([^"]+)"/);
            expect(m, `variant ${v} should render a src`).not.toBeNull();
            const url = m![1];
            expect(url.length, `variant ${v} src should be non-empty`).toBeGreaterThan(0);
            expect(
                seen.has(url),
                `variant ${v} url collides with another variant`,
            ).toBe(false);
            seen.add(url);
        }
        expect(seen.size).toBe(variants.length);
    });

    it('inverse variant SVG content carries the "inverse" desc text (signature check)', () => {
        // In Vitest the SVG inlines as a base64 data URI; decoding it lets
        // us verify the right asset reached the component without coupling
        // to a build-system-specific URL shape.
        const html = renderToString(<Logo variant="inverse" linkHome={false} />);
        const m = html.match(/src="([^"]+)"/);
        expect(m).not.toBeNull();
        const src = m![1];
        // If it's a data URI, decode + search the SVG. If it's an asset
        // URL (Next prod), we skip the content check — the distinct-src
        // test above already proves variants don't collide.
        if (src.startsWith('data:image/svg+xml;base64,')) {
            const b64 = src.slice('data:image/svg+xml;base64,'.length);
            const decoded = Buffer.from(b64, 'base64').toString('utf-8');
            expect(decoded).toContain('inverse');
        }
    });

    it('passes className through to the wrapper or img', () => {
        const linked = renderToString(<Logo className="logo-test" />);
        const bare = renderToString(<Logo linkHome={false} className="logo-test" />);
        // When linked, className lands on the <a>; when bare, on the <img>.
        expect(linked).toMatch(/class="logo-test"/);
        expect(bare).toMatch(/class="logo-test"/);
    });
});
