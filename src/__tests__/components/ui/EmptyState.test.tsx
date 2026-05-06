/**
 * EmptyState primitive — SSR smoke.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';

describe('<EmptyState />', () => {
    it('renders title only (minimal usage)', () => {
        const html = renderToString(<EmptyState title="还没有 API key" />);
        expect(html).toMatch(/<h3[^>]*>还没有 API key<\/h3>/);
        // No icon, no body, no action — just the headline.
        expect(html).not.toContain('aria-hidden="true"'); // icon wrapper has aria-hidden
    });

    it('renders icon + body + action when provided', () => {
        const html = renderToString(
            <EmptyState
                icon={<svg data-testid="empty-icon" />}
                title="还没有 API key"
                body="创建第一个 key 即可调用"
                action={<Button>新建 key</Button>}
            />,
        );
        expect(html).toContain('data-testid="empty-icon"');
        expect(html).toContain('aria-hidden="true"'); // icon wrapper
        expect(html).toContain('创建第一个 key 即可调用');
        expect(html).toContain('新建 key');
    });

    it('icon → title → body → action visual order is preserved', () => {
        const html = renderToString(
            <EmptyState
                icon={<svg id="ico" />}
                title="标题"
                body="说明"
                action={<button type="button">动作</button>}
            />,
        );
        const iIcon = html.indexOf('id="ico"');
        const iTitle = html.indexOf('标题');
        const iBody = html.indexOf('说明');
        const iAction = html.indexOf('动作');
        expect(iIcon).toBeGreaterThan(-1);
        expect(iIcon).toBeLessThan(iTitle);
        expect(iTitle).toBeLessThan(iBody);
        expect(iBody).toBeLessThan(iAction);
    });

    it('renders rich body content (not just strings)', () => {
        const html = renderToString(
            <EmptyState
                title="x"
                body={
                    <>
                        Take a <a href="/help">tour</a>
                    </>
                }
            />,
        );
        expect(html).toMatch(/<a[^>]*href="\/help">tour<\/a>/);
    });
});
