/**
 * Input primitive — SSR smoke + state assertions.
 *
 * Focuses on the props that change behavior (error / disabled / type
 * passthrough) rather than every Tailwind class. The `error` flag flips
 * the border + adds aria-invalid, which is the contract callers depend on.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Input } from '@/components/ui/Input';

describe('<Input />', () => {
    it('renders an <input type="text"> by default with full width', () => {
        const html = renderToString(<Input />);
        expect(html).toMatch(/^<input[^>]*type="text"/);
        expect(html).toContain('w-full');
    });

    it('passes type / name / value / placeholder / autoComplete through', () => {
        const html = renderToString(
            <Input
                type="email"
                name="email"
                placeholder="you@example.com"
                autoComplete="email"
                defaultValue="foo@bar.com"
            />,
        );
        expect(html).toMatch(/type="email"/);
        expect(html).toMatch(/name="email"/);
        expect(html).toMatch(/placeholder="you@example.com"/);
        expect(html).toMatch(/autoComplete="email"|autocomplete="email"/i);
        expect(html).toMatch(/value="foo@bar.com"/);
    });

    it('error=true sets aria-invalid + swaps the border tint', () => {
        const html = renderToString(<Input error />);
        expect(html).toMatch(/aria-invalid="true"/);
        expect(html).toContain('border-status-error-border');
        expect(html).not.toContain('border-brand-border'); // ok-state class shouldn't co-exist
    });

    it('error=false (default) does NOT set aria-invalid', () => {
        const html = renderToString(<Input />);
        expect(html).not.toMatch(/aria-invalid/);
        expect(html).toContain('border-brand-border');
    });

    it('disabled=true passes through to the native input', () => {
        const html = renderToString(<Input disabled />);
        expect(html).toMatch(/disabled(?:="")?/);
    });

    it('block=false drops w-full (used for inline filters)', () => {
        const html = renderToString(<Input block={false} />);
        expect(html).not.toContain('w-full');
    });

    it('forwards ref (smoke: render does not throw with a ref)', () => {
        // SSR can't actually attach the ref, but the component must accept it.
        const ref = { current: null };
        // Should not throw at render time.
        expect(() => renderToString(<Input ref={ref} />)).not.toThrow();
    });
});
