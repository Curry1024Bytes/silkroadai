/**
 * Label primitive — SSR smoke.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Label } from '@/components/ui/Label';

describe('<Label />', () => {
    it('renders <label htmlFor="..."> with the children', () => {
        const html = renderToString(<Label htmlFor="email">邮箱</Label>);
        expect(html).toMatch(/^<label[^>]*for="email"/);
        expect(html).toContain('邮箱');
    });

    it('required=true appends an aria-hidden asterisk', () => {
        const html = renderToString(<Label required>邮箱</Label>);
        expect(html).toContain('邮箱');
        expect(html).toMatch(/aria-hidden="true"/);
        expect(html).toContain('*');
    });

    it('required=false (default) renders no asterisk', () => {
        const html = renderToString(<Label>邮箱</Label>);
        expect(html).not.toMatch(/aria-hidden/);
        expect(html).not.toContain('>*<');
    });
});
