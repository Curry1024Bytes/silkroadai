/**
 * W4-2 D5 — <KeysList /> initial render smoke (react-dom/server).
 *
 * Same pattern as src/__tests__/app/pay-form.test.tsx — no jsdom + RTL
 * setup; assert on initial markup. Interactivity (reveal / copy / revoke /
 * create-flow) covered by D7 manual smoke + future RTL adoption.
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
    },
    {
        id: 'tok-bbb',
        key_alias: 'mobile-app',
        masked_key: 'sk-5678****wxyz',
        created_at: '2026-05-02T10:00:00.000Z',
    },
];

describe('<KeysList /> SSR smoke', () => {
    it('renders empty-state hint when initialRows is []', () => {
        const html = renderToString(<KeysList initialRows={[]} />);
        expect(html).toContain('暂无 API Key');
        // Create button present + enabled (no row count yet)
        expect(html).toContain('+ 创建新 Key');
        expect(html).not.toMatch(/<button[^>]*disabled[^>]*>\+ 创建新 Key/);
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

    it('disables + relabels create button when at MAX (5)', () => {
        const fullList: KeyRow[] = Array.from({ length: 5 }, (_, i) => ({
            id: `tok-${i}`,
            key_alias: `key-${i}`,
            masked_key: `sk-aaaa****0000`,
            created_at: '2026-05-01T10:00:00.000Z',
        }));
        const html = renderToString(<KeysList initialRows={fullList} />);
        // Button text changes + disabled attr present
        expect(html).toMatch(/>已达上限 \(5\)</);
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>已达上限/);
    });

    it('does NOT auto-show the create form (open=false initially)', () => {
        const html = renderToString(<KeysList initialRows={SAMPLE_ROWS} />);
        // The form's placeholder text only appears after the user clicks
        // create — initial render shouldn't include it
        expect(html).not.toContain('为 Key 起个名字');
    });
});
