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
        tokenName: o.tokenName ?? 'prod-openai',
        requestId: o.requestId ?? '202607052055427215383818268d9d6Zl7iiHJo',
        useTimeMs: o.useTimeMs ?? 1200,
        promptTokens: o.promptTokens ?? 100,
        completionTokens: o.completionTokens ?? 200,
        cacheReadTokens: o.cacheReadTokens ?? 0,
        cacheWriteTokens: o.cacheWriteTokens ?? 0,
        perImageBilled: o.perImageBilled ?? false,
        quota: o.quota ?? 500_000,
        costCny: o.costCny ?? 0.2,
        type: o.type ?? 2,
        content: o.content ?? '',
    };
}

describe('<CallDetailTable /> SSR', () => {
    it('empty rows → empty state', () => {
        const html = renderToString(<CallDetailTable rows={[]} />);
        expect(html).toContain('暂无调用记录');
    });

    it('success row (type=2) → 成功 + ¥ from server-passed costCny (not client-derived)', () => {
        // costCny is computed server-side (correct FX) and passed in; this client
        // island must render it verbatim. Re-deriving from quota in the browser
        // would bake the stale client default (500k/7.2) and over-display ¥ ~2×.
        const html = renderToString(<CallDetailTable rows={[row({ type: 2, quota: 28_570, costCny: 0.2 })]} />);
        expect(html).toContain('成功');
        expect(html).not.toContain('失败');
        expect(html).toMatch(/¥(<!-- -->)?0\.20/);
        // client-side quotaToCny(28570) with stale defaults would render ¥0.41 — guard against regression
        expect(html).not.toContain('0.41');
        expect(html).toContain('1.2s');
        expect(html).toContain('100 / 200');
    });

    it('surfaces the key alias (token_name) + request id per row (customer ask)', () => {
        const html = renderToString(renderRow({ tokenName: 'test-claude', requestId: '20260705ABCDEF0123456789' }));
        // Key column header + value
        expect(html).toContain('Key');
        expect(html).toContain('test-claude');
        // Request ID column header + value + copy affordance
        expect(html).toContain('Request ID');
        expect(html).toContain('20260705ABCDEF0123456789');
        expect(html).toContain('复制');
    });

    it('empty request id → "—" (no copy button, no blank cell)', () => {
        const html = renderToString(renderRow({ tokenName: '', requestId: '' }));
        expect(html).toContain('—');
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

    it('按张计费的生图行(perImageBilled)→ token 显示 "—"(即使上游报了噪声 token)', () => {
        const html = renderToString(
            renderRow({
                model: 'gemini-3-pro-image-preview',
                perImageBilled: true,
                promptTokens: 31,
                completionTokens: 765,
                useTimeMs: 800,
            }),
        );
        expect(html).toContain('gemini-3-pro-image-preview');
        expect(html).toContain('—');
        expect(html).not.toContain('31 / 765'); // 噪声 token 不外显
    });

    it('按 token 计费的生图行(gpt-image-2, perImageBilled=false)→ 如实显示 token(客户被计费的依据)', () => {
        const html = renderToString(
            renderRow({ model: 'gpt-image-2', perImageBilled: false, promptTokens: 3054, completionTokens: 196 }),
        );
        expect(html).toContain('gpt-image-2');
        expect(html).toContain('3,054 / 196');
    });

    it('有缓存读写 → Tokens 列渲染缓存副行(参照 new-api;prompt-cache 重度用户"输入 2 却 ¥0.07"的解释)', () => {
        const html = renderToString(
            renderRow({
                model: 'claude-opus-5',
                promptTokens: 2,
                completionTokens: 272,
                cacheReadTokens: 127_885,
                cacheWriteTokens: 178,
            }),
        );
        expect(html).toContain('2 / 272');
        expect(html).toContain('缓存读 127,885');
        expect(html).toContain('缓存写 178');
    });

    it('无缓存(读写都 0,绝大多数调用)→ 不渲染缓存副行(表格不加噪)', () => {
        const html = renderToString(renderRow({ cacheReadTokens: 0, cacheWriteTokens: 0 }));
        expect(html).not.toContain('缓存读');
        expect(html).not.toContain('缓存写');
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
