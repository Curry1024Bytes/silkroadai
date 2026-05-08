/**
 * KeysSnippetsPanel SSR smoke (W7 D4 PR-R Item C).
 *
 * Replaces the W7 PR-G `key-howto-panel.test.tsx`. PR-R drops the
 * per-row collapsible "如何使用此 Key" panel and surfaces a single
 * unified 调用示例 panel at the bottom of /keys with three tabs
 * (curl / Python / Node) and a static `YOUR_API_KEY` placeholder.
 *
 * Same shallow `react-dom/server` pattern used elsewhere — assert the
 * markup contract on initial render. The default tab (curl) is the
 * first to mount, so SSR assertions pin the curl snippet copy. Tab
 * switching itself is client-only and out of scope for SSR smoke.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { KeysSnippetsPanel } from '@/app/(authenticated)/keys/keys-snippets-panel';

describe('<KeysSnippetsPanel /> initial render (curl tab)', () => {
    it('renders the 调用示例 heading + YOUR_API_KEY placeholder hint', () => {
        const html = renderToString(<KeysSnippetsPanel />);
        expect(html).toContain('调用示例');
        // The placeholder is the contract surface — customers swap it
        // for their actual sk-... after copying from the table above.
        expect(html).toContain('YOUR_API_KEY');
    });

    it('exposes both base URLs (OpenAI /v1 + Anthropic root)', () => {
        const html = renderToString(<KeysSnippetsPanel />);
        expect(html).toContain('https://ai.silkroadai.io/v1');
        expect(html).toContain('https://ai.silkroadai.io');
        expect(html).toContain('OpenAI 兼容 Base URL');
        expect(html).toContain('Anthropic 兼容 Base URL');
    });

    it('renders 3 tab buttons (curl / Python / Node SDK)', () => {
        const html = renderToString(<KeysSnippetsPanel />);
        // Tab labels — Node SDK label disambiguates from generic Node
        // inside the snippet content.
        expect(html).toMatch(/<button[^>]*role="tab"[^>]*>curl<\/button>/);
        expect(html).toMatch(/<button[^>]*role="tab"[^>]*>Python<\/button>/);
        expect(html).toMatch(/<button[^>]*role="tab"[^>]*>Node SDK<\/button>/);
    });

    it('marks curl as the default selected tab (aria-selected="true")', () => {
        const html = renderToString(<KeysSnippetsPanel />);
        // Only one tab can be selected; the default is curl on first
        // paint. Python + Node are aria-selected="false" until the
        // user clicks them.
        expect(html).toMatch(
            /<button[^>]*aria-selected="true"[^>]*>curl<\/button>/,
        );
    });

    it('renders the curl snippet body with sample model + Authorization header', () => {
        const html = renderToString(<KeysSnippetsPanel />);
        // curl snippet body — these strings are how operators verify
        // the customer is hitting the right endpoint.
        expect(html).toContain('Authorization: Bearer YOUR_API_KEY');
        expect(html).toContain('claude-sonnet-4-6');
        expect(html).toContain('ai.silkroadai.io/v1/chat/completions');
    });

    it('renders the in-snippet 复制 button (top-right of code block)', () => {
        const html = renderToString(<KeysSnippetsPanel />);
        expect(html).toMatch(/<button[^>]*aria-label="复制 curl 示例代码"/);
        expect(html).toContain('>复制<');
    });

    it('links the sample model to /models and the docs CTA to /docs', () => {
        const html = renderToString(<KeysSnippetsPanel />);
        expect(html).toMatch(/href="\/models"/);
        expect(html).toMatch(/href="\/docs"/);
        expect(html).toContain('完整集成指南');
    });

    it('does NOT inline a fake sample sk- key inside the snippets', () => {
        const html = renderToString(<KeysSnippetsPanel />);
        // The PR-G per-row panel used to interpolate either the real
        // revealed sk- or an `sk-…` placeholder. PR-R standardizes on
        // `YOUR_API_KEY` so the snippet is unambiguous + the customer
        // knows exactly which string to swap. The header hint paragraph
        // references the customer's "sk-…" key in prose (that's fine —
        // it's body copy, not a snippet placeholder); we only need to
        // assert no fake sk- of meaningful length leaks into the code
        // blocks.
        expect(html).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    });
});

describe('<KeysSnippetsPanel /> accessibility', () => {
    it('every tab button has aria-controls pointing at a tabpanel id', () => {
        const html = renderToString(<KeysSnippetsPanel />);
        const matches = [...html.matchAll(/aria-controls="([^"]+)"/g)];
        expect(matches.length).toBeGreaterThanOrEqual(3);
        for (const [, id] of matches) {
            // The tabpanel for the active tab is rendered with the
            // matching id; inactive tabs don't render their panel,
            // but their aria-controls still points at the well-known
            // panel id (so screen readers can find it once active).
            expect(id).toMatch(/^keys-snippet-panel-/);
        }
    });

    it('the rendered tabpanel has role="tabpanel" and aria-labelledby pointing at a tab id', () => {
        const html = renderToString(<KeysSnippetsPanel />);
        expect(html).toMatch(/role="tabpanel"/);
        // The section wrapper itself uses aria-labelledby="keys-snippets-heading"
        // (pointing at the panel's outer h2), so a naïve first-match
        // grab returns the wrapper's labelledby. Pin the assertion to
        // the tabpanel's labelledby attribute specifically.
        expect(html).toMatch(
            /<div[^>]*role="tabpanel"[^>]*aria-labelledby="keys-snippet-tab-curl"/,
        );
    });
});
