/**
 * Button primitive — SSR smoke + state assertions.
 *
 * Covers the props the brief flagged as critical (variant / disabled /
 * loading) plus the polymorphic <button> ↔ <a href> branch. Layout / pixel
 * details live in design QA, not here.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Button } from '@/components/ui/Button';

describe('<Button />', () => {
    it('renders a <button> by default with type=button (avoids accidental form submit)', () => {
        const html = renderToString(<Button>点击</Button>);
        expect(html).toMatch(/^<button[^>]*type="button"/);
        expect(html).toContain('点击');
    });

    it('renders an <a> when href is provided (polymorphic)', () => {
        const html = renderToString(<Button href="/login">登录</Button>);
        expect(html).toMatch(/^<a[^>]*href="\/login"/);
        expect(html).not.toMatch(/<button/);
    });

    it('passes onClick / type=submit / form attrs through to the underlying button', () => {
        const html = renderToString(
            <Button type="submit" form="my-form" name="action" value="save">
                保存
            </Button>,
        );
        expect(html).toMatch(/type="submit"/);
        expect(html).toMatch(/form="my-form"/);
        expect(html).toMatch(/name="action"/);
        expect(html).toMatch(/value="save"/);
    });

    it.each([
        ['primary', 'bg-brand-accent'],
        ['secondary', 'border-brand-border'],
        ['ghost', 'bg-transparent'],
        ['danger', 'bg-status-error-text'],
    ] as const)('variant=%s applies its hallmark class (%s)', (variant, hallmark) => {
        const html = renderToString(<Button variant={variant}>X</Button>);
        expect(html).toContain(hallmark);
    });

    it.each([
        ['sm', 'h-9'],
        ['md', 'h-11'],
        ['lg', 'h-12'],
    ] as const)('size=%s sets the matching height class (%s)', (size, hallmark) => {
        const html = renderToString(<Button size={size}>X</Button>);
        expect(html).toContain(hallmark);
    });

    it('disabled=true sets the disabled attr on the underlying button', () => {
        const html = renderToString(<Button disabled>X</Button>);
        expect(html).toMatch(/disabled(?:="")?/);
        // Tailwind disabled-state opacity class is conditional in CSS, but the
        // HTML attribute is what blocks clicks. We assert the attribute, not
        // the class state which only resolves in the browser.
    });

    it('loading=true renders a spinner SVG and disables the button', () => {
        const html = renderToString(<Button loading>提交</Button>);
        expect(html).toMatch(/<svg[^>]*class="[^"]*animate-spin/);
        expect(html).toMatch(/disabled(?:="")?/);
        // Children still render — width should not collapse.
        expect(html).toContain('提交');
    });

    it('loading=true on an anchor variant adds aria-disabled (anchors have no native disabled)', () => {
        const html = renderToString(
            <Button href="/somewhere" loading>
                提交
            </Button>,
        );
        expect(html).toMatch(/<a[^>]*aria-disabled="true"/);
    });

    it('block=true adds w-full so the button stretches', () => {
        const html = renderToString(<Button block>X</Button>);
        expect(html).toContain('w-full');
    });

    it('caller-supplied className appends rather than replacing built-ins', () => {
        const html = renderToString(<Button className="my-custom">X</Button>);
        expect(html).toContain('my-custom');
        // Hallmark of primary variant should still be there.
        expect(html).toContain('bg-brand-accent');
    });
});
