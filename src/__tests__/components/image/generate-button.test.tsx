/**
 * PR-T2 — GenerateButton SSR smoke. State-machine assertions.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { GenerateButton } from '@/components/image/GenerateButton';

describe('<GenerateButton />', () => {
    it('idle: shows "生成 →"', () => {
        const html = renderToString(<GenerateButton state="idle" onClick={() => {}} />);
        expect(html).toContain('生成');
        expect(html).not.toContain('生成中');
        expect(html).not.toContain('重试');
    });

    it('loading: shows "生成中…" + disabled', () => {
        const html = renderToString(<GenerateButton state="loading" onClick={() => {}} />);
        expect(html).toContain('生成中');
        expect(html).toMatch(/<button[^>]*disabled=""/);
    });

    it('error: shows "重试" + the supplied error message in role=alert', () => {
        const html = renderToString(<GenerateButton state="error" onClick={() => {}} errorMessage="余额不足" />);
        expect(html).toContain('重试');
        expect(html).toMatch(/role="alert"/);
        expect(html).toContain('余额不足');
    });

    it('disabled prop forces disabled regardless of state', () => {
        const html = renderToString(<GenerateButton state="idle" disabled onClick={() => {}} />);
        expect(html).toMatch(/<button[^>]*disabled=""/);
    });
});
