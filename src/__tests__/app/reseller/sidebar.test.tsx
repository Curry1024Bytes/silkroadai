/**
 * PR-U2 — Sidebar conditional reseller entry.
 *
 * Layout passes isReseller; we verify the "代理后台" entry only appears
 * when the prop is true.
 *
 * usePathname is mocked because the Sidebar is a client component using
 * next/navigation hooks.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';

const mockUsePathname = vi.fn();
vi.mock('next/navigation', () => ({
    usePathname: () => mockUsePathname(),
}));

import { Sidebar } from '@/app/(authenticated)/sidebar';

beforeEach(() => {
    mockUsePathname.mockReturnValue('/dashboard');
});

describe('<Sidebar />', () => {
    it('hides 代理后台 entry by default (no prop)', () => {
        const html = renderToString(<Sidebar />);
        expect(html).not.toContain('代理后台');
        // Existing entries still render
        expect(html).toContain('概览');
        expect(html).toContain('API Keys');
    });

    it('hides 代理后台 when isReseller=false', () => {
        const html = renderToString(<Sidebar isReseller={false} />);
        expect(html).not.toContain('代理后台');
    });

    it('shows 代理后台 when isReseller=true (between /docs and /gpu)', () => {
        const html = renderToString(<Sidebar isReseller={true} />);
        expect(html).toContain('代理后台');
        expect(html).toContain('href="/reseller"');
        // Order: /docs → /reseller → /gpu (reseller injected before last entry)
        const docsIdx = html.indexOf('文档');
        const resellerIdx = html.indexOf('代理后台');
        const gpuIdx = html.indexOf('GPU 租赁');
        expect(docsIdx).toBeGreaterThan(-1);
        expect(resellerIdx).toBeGreaterThan(docsIdx);
        expect(gpuIdx).toBeGreaterThan(resellerIdx);
    });

    it('active state highlights /reseller when pathname matches', () => {
        mockUsePathname.mockReturnValue('/reseller');
        const html = renderToString(<Sidebar isReseller={true} />);
        // aria-current=page set on the active link
        expect(html).toContain('aria-current="page"');
    });
});
