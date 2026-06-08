'use client';

/**
 * Chat UI v2 — assistant message markdown renderer.
 *
 * Replaces v1's zero-dependency `markdown.tsx`. Uses assistant-ui's
 * streaming-aware `MarkdownTextPrimitive` (re-renders safely as tokens
 * arrive) + real Prism syntax highlighting via
 * `@assistant-ui/react-syntax-highlighter`. The `SyntaxHighlighter` +
 * `CodeHeader` are isolated here so swapping the highlighter later is a
 * single-file change.
 *
 * Styling is our own Tailwind/brand — assistant-ui primitives are headless,
 * so we don't pull in their CSS preset (keeps brand tokens intact).
 */
import { useCallback, useState, type ComponentPropsWithoutRef } from 'react';
import { MarkdownTextPrimitive, type CodeHeaderProps } from '@assistant-ui/react-markdown';
import { makePrismAsyncLightSyntaxHighlighter } from '@assistant-ui/react-syntax-highlighter';
import remarkGfm from 'remark-gfm';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

/** Async-light Prism: loads only the languages actually used, keeping the
 *  bundle lean. Returns a component assistant-ui drops into fenced blocks. */
const SyntaxHighlighter = makePrismAsyncLightSyntaxHighlighter({
    style: oneDark,
    customStyle: {
        margin: 0,
        background: 'transparent',
        padding: '0.85rem 1rem',
        fontSize: '0.8125rem',
        lineHeight: 1.6,
    },
    codeTagProps: { style: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' } },
});

/** Fenced-code header: language label + copy button. */
function CodeHeader({ language, code }: CodeHeaderProps) {
    const [copied, setCopied] = useState(false);
    const onCopy = useCallback(() => {
        if (!code) return;
        void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        });
    }, [code]);
    return (
        <div className="flex items-center justify-between gap-3 rounded-t-lg border-b border-white/10 bg-[#1e2330] px-3 py-1.5">
            <span className="font-mono text-[11px] uppercase tracking-wide text-white/55">{language || 'code'}</span>
            <button
                type="button"
                onClick={onCopy}
                className="text-[11px] text-white/70 transition-colors hover:text-white cursor-pointer"
            >
                {copied ? '已复制' : '复制'}
            </button>
        </div>
    );
}

/** Brand-styled overrides for the common markdown elements (fenced code is
 *  handled by SyntaxHighlighter/CodeHeader above). Keeps prose readable
 *  without pulling in @tailwindcss/typography. */
const components = {
    SyntaxHighlighter,
    CodeHeader,
    p: (props: ComponentPropsWithoutRef<'p'>) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0" {...props} />,
    h1: (props: ComponentPropsWithoutRef<'h1'>) => (
        <h1 className="mt-4 mb-2 text-lg font-semibold text-navy first:mt-0" {...props} />
    ),
    h2: (props: ComponentPropsWithoutRef<'h2'>) => (
        <h2 className="mt-4 mb-2 text-base font-semibold text-navy first:mt-0" {...props} />
    ),
    h3: (props: ComponentPropsWithoutRef<'h3'>) => (
        <h3 className="mt-3 mb-1.5 text-sm font-semibold text-navy first:mt-0" {...props} />
    ),
    ul: (props: ComponentPropsWithoutRef<'ul'>) => <ul className="my-2 list-disc pl-5 space-y-1" {...props} />,
    ol: (props: ComponentPropsWithoutRef<'ol'>) => <ol className="my-2 list-decimal pl-5 space-y-1" {...props} />,
    li: (props: ComponentPropsWithoutRef<'li'>) => <li className="leading-relaxed" {...props} />,
    a: (props: ComponentPropsWithoutRef<'a'>) => (
        <a
            className="text-brand-accent underline underline-offset-2 hover:opacity-80"
            target="_blank"
            rel="noopener noreferrer"
            {...props}
        />
    ),
    blockquote: (props: ComponentPropsWithoutRef<'blockquote'>) => (
        <blockquote className="my-2 border-l-2 border-brand-border pl-3 text-muted-ink italic" {...props} />
    ),
    hr: (props: ComponentPropsWithoutRef<'hr'>) => <hr className="my-3 border-brand-border" {...props} />,
    code: (props: ComponentPropsWithoutRef<'code'>) => (
        // Inline code only — fenced blocks are routed to SyntaxHighlighter.
        <code className="rounded bg-paper-muted px-1 py-0.5 font-mono text-[0.85em] text-navy" {...props} />
    ),
    table: (props: ComponentPropsWithoutRef<'table'>) => (
        <div className="my-2 overflow-x-auto">
            <table className="w-full border-collapse text-xs" {...props} />
        </div>
    ),
    th: (props: ComponentPropsWithoutRef<'th'>) => (
        <th className="border border-brand-border bg-paper-muted px-2 py-1 text-left font-semibold" {...props} />
    ),
    td: (props: ComponentPropsWithoutRef<'td'>) => <td className="border border-brand-border px-2 py-1" {...props} />,
};

/** The `Text` part renderer for assistant messages. */
export function AssistantMarkdown() {
    return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} components={components} smooth />;
}
