/**
 * AnnouncementBanner — dismiss 纯逻辑 + 单条渲染 SSR smoke。
 *
 * 项目暂无 RTL(见 balance-alert-form.test.tsx 注释),交互(点 ✕ 写 localStorage)
 * 留 manual smoke。这里覆盖:(1) filterDismissed 纯函数;(2) AnnouncementRow SSR
 * 渲染契约;(3) banner 的 mounted-gate —— SSR 首帧返回空,不泄露未过滤内容。
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { AnnouncementBanner, AnnouncementRow } from '@/app/(authenticated)/announcement-banner';
import { filterDismissed, LEVEL_META, type AnnouncementItem } from '@/lib/announcements/types';

const item = (over: Partial<AnnouncementItem> = {}): AnnouncementItem => ({
    id: 'a1',
    title: '系统维护通知',
    body: '今晚 02:00-03:00 维护',
    level: 'info',
    link_url: null,
    link_label: null,
    created_at: '2026-06-24T00:00:00.000Z',
    ...over,
});

describe('filterDismissed', () => {
    it('returns all when nothing dismissed', () => {
        const items = [item({ id: 'a' }), item({ id: 'b' })];
        expect(filterDismissed(items, [])).toHaveLength(2);
    });
    it('removes dismissed ids', () => {
        const items = [item({ id: 'a' }), item({ id: 'b' })];
        expect(filterDismissed(items, ['a']).map((x) => x.id)).toEqual(['b']);
    });
    it('ignores stale dismissed ids that no longer match', () => {
        const items = [item({ id: 'a' })];
        expect(filterDismissed(items, ['gone', 'x'])).toHaveLength(1);
    });
});

describe('LEVEL_META', () => {
    it('maps every level to a banner class + label', () => {
        for (const lvl of ['info', 'warning', 'critical'] as const) {
            expect(LEVEL_META[lvl].bannerClass).toMatch(/bg-status-/);
            expect(LEVEL_META[lvl].label.length).toBeGreaterThan(0);
        }
    });
    it('critical → error (red) token, info → info (blue) token', () => {
        expect(LEVEL_META.critical.bannerClass).toContain('status-error');
        expect(LEVEL_META.info.bannerClass).toContain('status-info');
    });
});

describe('<AnnouncementRow /> SSR', () => {
    it('renders title, body, date, and a dismiss button', () => {
        const html = renderToString(<AnnouncementRow item={item()} onDismiss={() => {}} />);
        expect(html).toContain('系统维护通知');
        expect(html).toContain('今晚 02:00-03:00 维护');
        expect(html).toContain('role="status"');
        expect(html).toContain('关闭公告');
        expect(html).toMatch(/2026/); // 2026-06-24 UTC → Asia/Shanghai 同日
    });
    it('renders a CTA link with custom label when link_url is set', () => {
        const html = renderToString(
            <AnnouncementRow item={item({ link_url: 'https://x.io/p', link_label: '去充值' })} onDismiss={() => {}} />,
        );
        expect(html).toContain('href="https://x.io/p"');
        expect(html).toContain('去充值');
        expect(html).toContain('rel="noopener noreferrer"');
    });
    it('falls back to 查看详情 when link has no label', () => {
        const html = renderToString(
            <AnnouncementRow item={item({ link_url: 'https://x.io/p', link_label: null })} onDismiss={() => {}} />,
        );
        expect(html).toContain('查看详情');
    });
    it('applies the level color class (warning → amber token)', () => {
        const html = renderToString(<AnnouncementRow item={item({ level: 'warning' })} onDismiss={() => {}} />);
        expect(html).toContain('bg-status-warning-bg');
    });
});

describe('<AnnouncementBanner /> mounted-gate', () => {
    it('renders nothing on the server (avoids flashing dismissed items)', () => {
        const html = renderToString(<AnnouncementBanner items={[item()]} />);
        // dismissed===null on first paint → returns null → no content leaks pre-mount
        expect(html).not.toContain('系统维护通知');
    });
});
