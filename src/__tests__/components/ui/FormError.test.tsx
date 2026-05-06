/**
 * FormError primitive — SSR smoke + null-render contract.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { FormError } from '@/components/ui/FormError';

describe('<FormError />', () => {
    it('renders nothing when children is undefined / null / false / empty string', () => {
        // React.renderToString of null returns ''.
        expect(renderToString(<FormError>{undefined}</FormError>)).toBe('');
        expect(renderToString(<FormError>{null}</FormError>)).toBe('');
        expect(renderToString(<FormError>{false}</FormError>)).toBe('');
        expect(renderToString(<FormError>{''}</FormError>)).toBe('');
    });

    it('renders with role="alert" so AT announces the message when it appears', () => {
        const html = renderToString(<FormError>邮箱不能为空</FormError>);
        expect(html).toMatch(/role="alert"/);
        expect(html).toContain('邮箱不能为空');
    });

    it('default severity=inline uses tight margin-top for under-field placement', () => {
        const html = renderToString(<FormError>错误</FormError>);
        expect(html).toContain('mt-1.5');
        expect(html).not.toContain('rounded-lg'); // banner-only
    });

    it('severity=banner uses error-tinted card layout', () => {
        const html = renderToString(<FormError severity="banner">服务暂时不可达</FormError>);
        expect(html).toContain('bg-status-error-bg');
        expect(html).toContain('border-status-error-border');
        expect(html).toContain('rounded-lg');
    });

    it('renders rich children (e.g. error + retry button), not just strings', () => {
        const html = renderToString(
            <FormError severity="banner">
                <span>失败</span>
                <button type="button">重试</button>
            </FormError>,
        );
        expect(html).toContain('<span>失败</span>');
        expect(html).toMatch(/<button[^>]*>重试<\/button>/);
    });
});
