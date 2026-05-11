/**
 * fix/reseller-entry-discovery — Sidebar polymorphic reseller entry.
 *
 * Behavior:
 *   - Always renders the reseller entry (CTA discoverability)
 *   - Label depends on status: null → "邀请赚佣金"; active → "代理后台";
 *     suspended/banned → "代理后台" + muted text color
 *   - Same href "/reseller" in all cases
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
    it('non-reseller (default / no prop) → 邀请赚佣金 entry visible', () => {
        const html = renderToString(<Sidebar />);
        expect(html).toContain('邀请赚佣金');
        expect(html).not.toContain('代理后台');
        // Same href, regardless of label
        expect(html).toContain('href="/reseller"');
        // Existing entries unchanged
        expect(html).toContain('概览');
        expect(html).toContain('API Keys');
    });

    it('resellerStatus=null → same as no prop (邀请赚佣金 entry)', () => {
        const html = renderToString(<Sidebar resellerStatus={null} />);
        expect(html).toContain('邀请赚佣金');
        expect(html).not.toContain('代理后台');
    });

    it('resellerStatus=active → 代理后台 (not muted)', () => {
        const html = renderToString(<Sidebar resellerStatus="active" />);
        expect(html).toContain('代理后台');
        expect(html).not.toContain('邀请赚佣金');
        expect(html).toContain('data-status="active"');
        // Active is NOT muted (uses standard nav text color)
        expect(html).not.toMatch(/text-minor-ink\/70/);
    });

    it('resellerStatus=suspended → 代理后台 with muted text', () => {
        const html = renderToString(<Sidebar resellerStatus="suspended" />);
        expect(html).toContain('代理后台');
        expect(html).toContain('data-status="suspended"');
        // Suspended uses text-minor-ink/70 (grey-out)
        expect(html).toMatch(/text-minor-ink\/70/);
    });

    it('resellerStatus=banned → 代理后台 with muted text', () => {
        const html = renderToString(<Sidebar resellerStatus="banned" />);
        expect(html).toContain('代理后台');
        expect(html).toContain('data-status="banned"');
        expect(html).toMatch(/text-minor-ink\/70/);
    });

    it('reseller entry sits between /docs and /gpu in nav order', () => {
        const html = renderToString(<Sidebar resellerStatus="active" />);
        const docsIdx = html.indexOf('文档');
        const resellerIdx = html.indexOf('代理后台');
        const gpuIdx = html.indexOf('GPU 租赁');
        expect(docsIdx).toBeGreaterThan(-1);
        expect(resellerIdx).toBeGreaterThan(docsIdx);
        expect(gpuIdx).toBeGreaterThan(resellerIdx);
    });

    it('active state highlight on /reseller path', () => {
        mockUsePathname.mockReturnValue('/reseller');
        const html = renderToString(<Sidebar resellerStatus="active" />);
        expect(html).toContain('aria-current="page"');
    });
});
