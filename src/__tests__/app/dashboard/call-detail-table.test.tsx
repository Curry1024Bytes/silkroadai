/**
 * 客户控制台三合一 — CallDetailTable SSR smoke (brief §3 + §5).
 *
 * renderToString gives the initial (page 1, collapsed) render. Asserts the
 * column contract: 成功/失败 badges, ¥ from quota, friendly duration, tokens
 * (with 生图 token=0 → "—"), error content surfaced, and first-page-only
 * pagination. Click-driven page changes / expand are interactivity left to
 * manual smoke (same shallow pattern as the other authenticated component
 * tests).
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { CallDetailTable, type CallRow } from '@/app/(authenticated)/dashboard/call-detail-table';

function row(o: Partial<CallRow> = {}): CallRow {
    return {
        id: o.id ?? 1,
        createdAt: o.createdAt ?? 1_700_000_000,
        model: o.model ?? 'gpt-5.4',
        useTimeMs: o.useTimeMs ?? 1200,
        promptTokens: o.promptTokens ?? 100,
        completionTokens: o.completionTokens ?? 200,
        quota: o.quota ?? 500_000,
        type: o.type ?? 2,
        content: o.content ?? '',
    };
}

describe('<CallDetailTable /> SSR', () => {
    it('empty rows → empty state', () => {
        const html = renderToString(<CallDetailTable rows={[]} />);
        expect(html).toContain('暂无调用记录');
    });

    it('success row (type=2) → 成功 + ¥ from quota + friendly duration + tokens', () => {
        // 500_000 quota = 1 USD = ¥7.20
        const html = renderToString(<CallDetailTable rows={[row({ type: 2 })]} />);
        expect(html).toContain('成功');
        expect(html).not.toContain('失败');
        expect(html).toMatch(/¥(<!-- -->)?7\.20/);
        expect(html).toContain('1.2s');
        expect(html).toContain('100 / 200');
    });

    it('error row (type=5) → 失败 + error content surfaced (展开/hover 详情)', () => {
        const html = renderToString(
            renderRow({ type: 5, quota: 0, content: 'rate limit exceeded', model: 'claude-opus-4-8' }),
        );
        expect(html).toContain('失败');
        expect(html).toContain('claude-opus-4-8');
        // content surfaced via the badge title attr (also expandable on click)
        expect(html).toContain('rate limit exceeded');
    });

    it('image-gen row (token=0) → "—" not "0 / 0" (生图友好)', () => {
        const html = renderToString(
            renderRow({ model: 'gemini-3-pro-image-preview', promptTokens: 0, completionTokens: 0, useTimeMs: 800 }),
        );
        expect(html).toContain('gemini-3-pro-image-preview');
        expect(html).toContain('—');
        expect(html).not.toContain('0 / 0');
    });

    it('paginates — first 20 rows only, pager controls present', () => {
        const rows = Array.from({ length: 25 }, (_, i) => row({ id: i + 1, model: `mdl-${i + 1}` }));
        const html = renderToString(<CallDetailTable rows={rows} />);
        expect(html).toContain('mdl-20'); // last row on page 1
        expect(html).not.toContain('mdl-21'); // page 2 not rendered initially
        expect(html).toContain('上一页');
        expect(html).toContain('下一页');
        expect(html).toContain('页');
    });
});

function renderRow(o: Partial<CallRow>) {
    return <CallDetailTable rows={[row(o)]} />;
}
