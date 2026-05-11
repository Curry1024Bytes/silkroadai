/**
 * PR-U2 — CodesClient SSR smoke.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

// codes-client uses useRouter() in handleDelete — SSR needs the router
// mocked or renderToString throws "invariant expected app router to be mounted".
vi.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { CodesClient, type CodeRow } from '@/app/(authenticated)/reseller/codes/codes-client';

/** React SSR inserts `<!-- -->` between adjacent dynamic/static text
 *  nodes (e.g. `{count} 位客户` → `5<!-- --> 位客户`). Strip them so
 *  assertions can target the user-visible string. */
function stripSSRMarkers(html: string): string {
    return html.replace(/<!-- -->/g, '');
}

const baseRow: CodeRow = {
    id: 'code-uuid',
    code: 'FRANK-DEFAULT',
    label: '默认',
    is_active: true,
    attributed_user_count: 5,
    total_attributed_gmv_cny: 250,
    created_at: '2026-05-01T00:00:00.000Z',
};

describe('<CodesClient />', () => {
    it('empty → EmptyState w/ create CTA', () => {
        const html = renderToString(<CodesClient initialRows={[]} />);
        expect(html).toContain('还没有邀请码');
        expect(html).toContain('创建你的第一个邀请码');
    });

    it('renders rows with code + label + counts', () => {
        const html = stripSSRMarkers(renderToString(<CodesClient initialRows={[baseRow]} />));
        expect(html).toContain('FRANK-DEFAULT');
        expect(html).toContain('默认');
        expect(html).toContain('5 位客户');
        expect(html).toContain('¥250.00');
    });

    it('inactive row shows 已停用 chip + opacity-60 class', () => {
        const html = renderToString(<CodesClient initialRows={[{ ...baseRow, is_active: false }]} />);
        expect(html).toContain('已停用');
        expect(html).toContain('opacity-60');
    });

    it('shows active count in the create button label', () => {
        const html = renderToString(<CodesClient initialRows={[baseRow]} />);
        // 1 active, max 10
        expect(html).toContain('1/10');
    });

    it('at-cap (10 active codes) → shows the cap warning banner', () => {
        const tenActive = Array.from({ length: 10 }, (_, i) => ({
            ...baseRow,
            id: `id-${i}`,
            code: `CODE-${i}`,
        }));
        const html = stripSSRMarkers(renderToString(<CodesClient initialRows={tenActive} />));
        expect(html).toContain('已达到最大 10 个活跃邀请码上限');
    });
});
