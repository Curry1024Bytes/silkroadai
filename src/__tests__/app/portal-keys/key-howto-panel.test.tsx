/**
 * KeyHowtoPanel SSR smoke (W7 D4 PR-G — Tier 1).
 *
 * Asserts the closed/open state transition (driven by the `open`
 * prop, parent owns the toggle) plus the snippet contract in both
 * placeholder and revealed states.
 *
 * Same react-dom/server pattern as keys-list-ui.test.tsx — no jsdom,
 * just markup assertions.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { KeyHowtoPanel } from '@/app/(authenticated)/keys/key-howto-panel';

describe('<KeyHowtoPanel /> closed (default)', () => {
    it('renders the toggle button labeled 如何使用此 Key with aria-expanded=false', () => {
        const html = renderToString(
            <KeyHowtoPanel revealedKey={null} open={false} onToggle={() => {}} />,
        );
        expect(html).toContain('如何使用此 Key');
        expect(html).toMatch(/aria-expanded="false"/);
    });

    it('does NOT render the snippet contents when closed', () => {
        const html = renderToString(
            <KeyHowtoPanel revealedKey={null} open={false} onToggle={() => {}} />,
        );
        // Snippet code blocks stay hidden until the panel opens — keeps
        // the table compact and SSR payload small.
        expect(html).not.toContain('from openai import OpenAI');
        expect(html).not.toContain('import OpenAI from');
    });

    it('shows a hint about expanding to see snippets', () => {
        const html = renderToString(
            <KeyHowtoPanel revealedKey={null} open={false} onToggle={() => {}} />,
        );
        expect(html).toContain('点击展开');
    });
});

describe('<KeyHowtoPanel /> open + sk- placeholder (no reveal)', () => {
    it('renders both base URLs (OpenAI /v1 + Anthropic root)', () => {
        const html = renderToString(
            <KeyHowtoPanel revealedKey={null} open={true} onToggle={() => {}} />,
        );
        expect(html).toContain('https://ai.silkroadai.io/v1');
        expect(html).toContain('https://ai.silkroadai.io');
        expect(html).toContain('OpenAI 兼容');
        expect(html).toContain('Anthropic 兼容');
    });

    it('renders 3 snippet blocks (curl + Python + Node) labeled correctly', () => {
        const html = renderToString(
            <KeyHowtoPanel revealedKey={null} open={true} onToggle={() => {}} />,
        );
        // Snippet header labels
        expect(html).toContain('curl');
        expect(html).toContain('Python (openai)');
        expect(html).toContain('Node / TypeScript (openai)');
        // Snippet contents — distinctive strings per snippet. React's
        // renderToString HTML-escapes single quotes in text nodes
        // (`'` → `&#x27;`), so the Node import line is matched via a
        // regex that accepts either form.
        expect(html).toContain('Authorization: Bearer');
        expect(html).toContain('from openai import OpenAI');
        expect(html).toMatch(/import OpenAI from\s*(?:'|&#x27;)openai(?:'|&#x27;);/);
    });

    it('shows the "替换为您的实际 key" hint when no reveal', () => {
        const html = renderToString(
            <KeyHowtoPanel revealedKey={null} open={true} onToggle={() => {}} />,
        );
        expect(html).toContain('替换为您的实际 key');
        // The placeholder string is `sk-…` (literal); our snippets and
        // the tip both use it.
        expect(html).toContain('sk-…');
    });

    it('does NOT leak the sk- when revealedKey is null/undefined', () => {
        const html = renderToString(
            <KeyHowtoPanel revealedKey={undefined} open={true} onToggle={() => {}} />,
        );
        // No literal "sk-" followed by alphanumerics longer than the
        // placeholder shape (the placeholder is `sk-…` with the ellipsis
        // character). Make sure we're not somehow rendering a fallback
        // sample key.
        expect(html).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    });

    it('links 如何选模型? to /models and 完整集成指南 to /docs', () => {
        const html = renderToString(
            <KeyHowtoPanel revealedKey={null} open={true} onToggle={() => {}} />,
        );
        expect(html).toMatch(/href="\/models"/);
        expect(html).toMatch(/href="\/docs"/);
    });
});

describe('<KeyHowtoPanel /> open + revealed sk-', () => {
    const FAKE_SK = 'sk-fakekey-XXXX-1234567890abcdefABCDEF';

    it('inlines the revealed sk- into all 3 snippets', () => {
        const html = renderToString(
            <KeyHowtoPanel revealedKey={FAKE_SK} open={true} onToggle={() => {}} />,
        );
        // The fake key appears in curl + Python + Node snippets — at
        // least 3 occurrences (one per snippet).
        const occurrences = (html.match(new RegExp(FAKE_SK, 'g')) ?? []).length;
        expect(occurrences).toBeGreaterThanOrEqual(3);
    });

    it('does NOT show the "替换为您的实际 key" placeholder hint when revealed', () => {
        const html = renderToString(
            <KeyHowtoPanel revealedKey={FAKE_SK} open={true} onToggle={() => {}} />,
        );
        // When the key is revealed (e.g. just-created auto-reveal or
        // user clicked 显示), the placeholder hint is suppressed since
        // the snippets are already drop-in usable.
        expect(html).not.toContain('替换为您的实际 key');
    });

    it('still uses sk-… placeholder is absent — no double rendering', () => {
        const html = renderToString(
            <KeyHowtoPanel revealedKey={FAKE_SK} open={true} onToggle={() => {}} />,
        );
        expect(html).not.toContain('sk-…');
    });
});

describe('<KeyHowtoPanel /> accessibility', () => {
    it('toggle button has aria-controls pointing at the same id used by the content panel', () => {
        const html = renderToString(
            <KeyHowtoPanel revealedKey={null} open={true} onToggle={() => {}} />,
        );
        const ariaControlsMatch = html.match(/aria-controls="([^"]+)"/);
        expect(ariaControlsMatch).not.toBeNull();
        const id = ariaControlsMatch![1];
        // The content div should carry the same id.
        expect(html).toMatch(new RegExp(`<div[^>]*id="${id}"`));
    });

    it('toggle button has aria-expanded that matches the open prop', () => {
        const closed = renderToString(
            <KeyHowtoPanel revealedKey={null} open={false} onToggle={() => {}} />,
        );
        expect(closed).toMatch(/aria-expanded="false"/);
        const open = renderToString(
            <KeyHowtoPanel revealedKey={null} open={true} onToggle={() => {}} />,
        );
        expect(open).toMatch(/aria-expanded="true"/);
    });
});
