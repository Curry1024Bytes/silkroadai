/**
 * W4-2 D5 + W6 D4 — <KeysList /> initial render smoke (react-dom/server).
 *
 * Same pattern as src/__tests__/app/pay-form.test.tsx — no jsdom + RTL
 * setup; assert on initial markup. Interactivity (reveal / copy / revoke /
 * create-flow) covered by manual smoke + future RTL adoption.
 *
 * W6 D4 additions:
 *   - usage subline (累计 + 最近调用) renders per row
 *   - "从未调用" copy when last_used_at is null
 *   - max bumped 5 → 10 (button label assertion)
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { KeysList, type KeyRow } from '@/app/(authenticated)/keys/keys-list';

const SAMPLE_ROWS: KeyRow[] = [
    {
        id: 'tok-aaa',
        key_alias: 'production',
        masked_key: 'sk-1234****abcd',
        created_at: '2026-05-01T10:00:00.000Z',
        used_quota: 0,
        last_used_at: null,
    },
    {
        id: 'tok-bbb',
        key_alias: 'mobile-app',
        masked_key: 'sk-5678****wxyz',
        created_at: '2026-05-02T10:00:00.000Z',
        used_quota: 0,
        last_used_at: null,
    },
];

describe('<KeysList /> SSR smoke', () => {
    it('renders empty-state hint when initialRows is []', () => {
        const html = renderToString(<KeysList initialRows={[]} />);
        // W7 P2: empty-state copy moved into the <EmptyState> primitive.
        // Title + body together; the title is the primary affordance.
        expect(html).toContain('还没有 API Key');
        expect(html).toContain('+ 创建新 Key');
        // Create button present + enabled (no row count yet). Tighten the
        // regex to the actual HTML `disabled=""` attribute since the new
        // Tailwind class strings contain the substring "disabled" (in
        // utility classes like `disabled:opacity-50`).
        expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>\+ 创建新 Key/);
    });

    it('renders one row per token with alias + masked key + 显示/复制/撤销 actions', () => {
        const html = renderToString(<KeysList initialRows={SAMPLE_ROWS} />);
        expect(html).toContain('production');
        expect(html).toContain('mobile-app');
        expect(html).toContain('sk-1234****abcd');
        expect(html).toContain('sk-5678****wxyz');
        // 3 actions per row × 2 rows = 6 occurrences each
        const showCount = (html.match(/>显示</g) ?? []).length;
        const copyCount = (html.match(/>复制</g) ?? []).length;
        const revokeCount = (html.match(/>撤销</g) ?? []).length;
        expect(showCount).toBe(2);
        expect(copyCount).toBe(2);
        expect(revokeCount).toBe(2);
    });

    it('does NOT leak full sk- in masked rendering (only the masked variant)', () => {
        const html = renderToString(<KeysList initialRows={SAMPLE_ROWS} />);
        // Masked form shows sk-XXXX****YYYY but the actual full middle is
        // never present client-side until user clicks 显示
        expect(html).not.toContain('sk-1234567');
        expect(html).not.toContain('sk-5678abc');
    });

    it('disables + relabels create button when at MAX (10)', () => {
        const fullList: KeyRow[] = Array.from({ length: 10 }, (_, i) => ({
            id: `tok-${i}`,
            key_alias: `key-${i}`,
            masked_key: `sk-aaaa****0000`,
            created_at: '2026-05-01T10:00:00.000Z',
            used_quota: 0,
            last_used_at: null,
        }));
        const html = renderToString(<KeysList initialRows={fullList} />);
        // Button text changes + disabled attr present (W6 D4 limit 10)
        expect(html).toMatch(/>已达上限 \(10\)</);
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>已达上限/);
    });

    it('does NOT disable create button at 9 keys (just below the 10 cap)', () => {
        const nineKeys: KeyRow[] = Array.from({ length: 9 }, (_, i) => ({
            id: `tok-${i}`,
            key_alias: `key-${i}`,
            masked_key: 'sk-aaaa****0000',
            created_at: '2026-05-01T10:00:00.000Z',
            used_quota: 0,
            last_used_at: null,
        }));
        const html = renderToString(<KeysList initialRows={nineKeys} />);
        expect(html).toContain('+ 创建新 Key');
        // Tighten to the HTML `disabled=""` attribute (Tailwind utility
        // classes like `disabled:opacity-50` would false-match a looser
        // `[^>]*disabled[^>]*` regex on the new className string).
        expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>\+ 创建新 Key/);
    });

    it('does NOT auto-show the create form (open=false initially)', () => {
        const html = renderToString(<KeysList initialRows={SAMPLE_ROWS} />);
        // Brand-new placeholder format introduced in W6 D4
        expect(html).not.toContain('prod-openai');
    });
});

describe('<KeysList /> W6 D4 — per-key usage subline', () => {
    it('shows "从未调用" + ¥0.00 when last_used_at is null', () => {
        const rows: KeyRow[] = [
            {
                id: 'tok-fresh',
                key_alias: 'freshly-created',
                masked_key: 'sk-1111****2222',
                created_at: '2026-05-05T10:00:00.000Z',
                used_quota: 0,
                last_used_at: null,
            },
        ];
        const html = renderToString(<KeysList initialRows={rows} />);
        expect(html).toContain('从未调用');
        // React 19 SSR inserts <!-- --> between adjacent text + dynamic
        // nodes (the literal "¥" plus the formatted CNY number).
        expect(html).toMatch(/累计 ¥(<!-- -->)?0\.00/);
    });

    it('renders ¥X.XX accumulated + relative last-used time when last_used_at is set', () => {
        // 695_000 raw quota ≈ 1 USD ≈ ¥7.20 (default rates)
        const aboutADayAgo = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
        const rows: KeyRow[] = [
            {
                id: 'tok-active',
                key_alias: 'prod-openai',
                masked_key: 'sk-3333****4444',
                created_at: '2026-04-01T10:00:00.000Z',
                used_quota: 695_000,
                last_used_at: aboutADayAgo,
            },
        ];
        const html = renderToString(<KeysList initialRows={rows} />);
        // CNY conversion: 695000 / 500000 * 7.2 = 10.008 → "¥10.01"
        // React 19 inserts <!-- --> between literal ¥ and dynamic value.
        expect(html).toMatch(/累计 ¥(<!-- -->)?10\./);
        // 26h ago → "1 天前" (with optional comment)
        expect(html).toMatch(/最近调用 (<!-- -->)?1 天前/);
    });

    it('shows "用量数据暂不可用" when used_quota is null (server fetch failed)', () => {
        const rows: KeyRow[] = [
            {
                id: 'tok-broken',
                key_alias: 'experimental',
                masked_key: 'sk-9999****eeee',
                created_at: '2026-05-04T10:00:00.000Z',
                used_quota: null,
                last_used_at: null,
            },
        ];
        const html = renderToString(<KeysList initialRows={rows} />);
        expect(html).toContain('用量数据暂不可用');
        // The fallback hides the 累计/最近调用 line entirely
        expect(html).not.toMatch(/累计 ¥/);
    });
});

describe('<KeysList /> W6 D4 — alias placeholder hint', () => {
    // The create form is hidden initially, so an SSR snapshot can't see
    // the alias input directly. Asserting on the unrendered state:
    it('does not render the env-purpose hint until the create form opens', () => {
        const html = renderToString(<KeysList initialRows={[]} />);
        expect(html).not.toContain('env-purpose');
        expect(html).not.toContain('prod-openai');
    });
});
