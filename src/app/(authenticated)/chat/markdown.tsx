'use client';

/**
 * Chat UI v1 — dependency-free markdown renderer.
 *
 * We deliberately avoid pulling in react-markdown / remark / a syntax
 * highlighter: Chat UI v1 is a "pure new frontend, zero collision" drop,
 * and adding a markdown toolchain (+ its transitive deps + lockfile
 * churn) is exactly the kind of cross-cutting change v1 is meant to
 * avoid. This renderer covers the markdown an LLM actually emits:
 *
 *   - Fenced code blocks (```lang) → styled block + language label +
 *     copy button.
 *   - Headings (#..######), unordered (-, *, +) and ordered (1.) lists,
 *     blockquotes (>), horizontal rules (---), paragraphs.
 *   - Inline: **bold**, *italic* / _italic_, `code`, [text](url).
 *
 * It does NOT do per-token syntax coloring (that needs a highlighter
 * lib) — code renders in a clean monospace block. If operators later
 * want colored tokens, swap CodeBlock's <pre> body for a highlighter
 * without touching the block parser.
 *
 * Streaming-safe: this renders whatever partial markdown has arrived so
 * far. An unterminated ``` fence renders as an open code block until the
 * closing fence streams in — acceptable for a live token feed.
 */
import { useState, type ReactNode } from 'react';

interface MarkdownProps {
    content: string;
}

export function Markdown({ content }: MarkdownProps) {
    return <div className="chat-md flex flex-col gap-2">{renderBlocks(content)}</div>;
}

// ── Block-level ────────────────────────────────────────────────────────

/** Split into fenced-code vs prose segments, then render each. A fence
 *  is a line starting with ``` (optionally followed by a language). */
function renderBlocks(src: string): ReactNode[] {
    const out: ReactNode[] = [];
    const lines = src.split('\n');
    let i = 0;
    let key = 0;

    while (i < lines.length) {
        const fence = /^```(.*)$/.exec(lines[i]);
        if (fence) {
            const lang = fence[1].trim();
            const codeLines: string[] = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i])) {
                codeLines.push(lines[i]);
                i++;
            }
            // Skip the closing fence if present (may be absent mid-stream).
            if (i < lines.length) i++;
            out.push(<CodeBlock key={key++} lang={lang} code={codeLines.join('\n')} />);
            continue;
        }

        // Gather a prose run up to the next fence.
        const proseLines: string[] = [];
        while (i < lines.length && !/^```/.test(lines[i])) {
            proseLines.push(lines[i]);
            i++;
        }
        out.push(...renderProse(proseLines, () => key++));
    }

    return out;
}

/** Render a run of non-code lines into headings / lists / quotes / paras. */
function renderProse(lines: string[], nextKey: () => number): ReactNode[] {
    const out: ReactNode[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Blank line — separator.
        if (line.trim() === '') {
            i++;
            continue;
        }

        // Horizontal rule.
        if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
            out.push(<hr key={nextKey()} className="border-0 border-t border-brand-border my-1" />);
            i++;
            continue;
        }

        // Heading.
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) {
            const level = h[1].length;
            const sizes = ['text-xl', 'text-lg', 'text-base', 'text-base', 'text-sm', 'text-sm'];
            out.push(
                <p key={nextKey()} className={`m-0 font-semibold text-navy ${sizes[level - 1]}`}>
                    {renderInline(h[2])}
                </p>,
            );
            i++;
            continue;
        }

        // Blockquote (consecutive > lines).
        if (/^\s*>\s?/.test(line)) {
            const quote: string[] = [];
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
                quote.push(lines[i].replace(/^\s*>\s?/, ''));
                i++;
            }
            out.push(
                <blockquote key={nextKey()} className="m-0 pl-3 border-0 border-l-2 border-brand-border text-muted-ink">
                    {renderInline(quote.join(' '))}
                </blockquote>,
            );
            continue;
        }

        // Ordered list.
        if (/^\s*\d+\.\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
                items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
                i++;
            }
            out.push(
                <ol key={nextKey()} className="m-0 pl-5 list-decimal flex flex-col gap-0.5">
                    {items.map((it, idx) => (
                        <li key={idx}>{renderInline(it)}</li>
                    ))}
                </ol>,
            );
            continue;
        }

        // Unordered list.
        if (/^\s*[-*+]\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
                items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
                i++;
            }
            out.push(
                <ul key={nextKey()} className="m-0 pl-5 list-disc flex flex-col gap-0.5">
                    {items.map((it, idx) => (
                        <li key={idx}>{renderInline(it)}</li>
                    ))}
                </ul>,
            );
            continue;
        }

        // Paragraph — gather consecutive plain lines (join with space).
        const para: string[] = [];
        while (
            i < lines.length &&
            lines[i].trim() !== '' &&
            !/^(#{1,6})\s+/.test(lines[i]) &&
            !/^\s*>\s?/.test(lines[i]) &&
            !/^\s*\d+\.\s+/.test(lines[i]) &&
            !/^\s*[-*+]\s+/.test(lines[i]) &&
            !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])
        ) {
            para.push(lines[i]);
            i++;
        }
        out.push(
            <p key={nextKey()} className="m-0 leading-relaxed whitespace-pre-wrap break-words">
                {renderInline(para.join('\n'))}
            </p>,
        );
    }

    return out;
}

// ── Inline ─────────────────────────────────────────────────────────────

/** Tokenize inline markdown into React nodes. Order of precedence:
 *  inline code (protects its contents) → links → bold → italic. */
function renderInline(text: string): ReactNode[] {
    return splitCode(text);
}

/** First split out `code` spans so their contents aren't re-parsed. */
function splitCode(text: string): ReactNode[] {
    const out: ReactNode[] = [];
    const re = /`([^`]+)`/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let key = 0;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(...splitLink(text.slice(last, m.index), `t${key++}`));
        out.push(
            <code
                key={`c${key++}`}
                className="font-mono text-[0.85em] bg-paper-muted text-navy px-1 py-0.5 rounded border border-brand-border"
            >
                {m[1]}
            </code>,
        );
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push(...splitLink(text.slice(last), `t${key++}`));
    return out;
}

/** Split out [label](url) links. */
function splitLink(text: string, keyPrefix: string): ReactNode[] {
    const out: ReactNode[] = [];
    const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let key = 0;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(...splitEmphasis(text.slice(last, m.index), `${keyPrefix}e${key++}`));
        out.push(
            <a
                key={`${keyPrefix}l${key++}`}
                href={m[2]}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-accent underline hover:no-underline break-all"
            >
                {m[1]}
            </a>,
        );
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push(...splitEmphasis(text.slice(last), `${keyPrefix}e${key++}`));
    return out;
}

/** Split out **bold** and *italic* / _italic_. Bold checked first. */
function splitEmphasis(text: string, keyPrefix: string): ReactNode[] {
    const out: ReactNode[] = [];
    const re = /\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let key = 0;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index));
        const bold = m[1] ?? m[2];
        const italic = m[3] ?? m[4];
        if (bold != null) {
            out.push(
                <strong key={`${keyPrefix}b${key++}`} className="font-semibold text-navy">
                    {bold}
                </strong>,
            );
        } else {
            out.push(
                <em key={`${keyPrefix}i${key++}`} className="italic">
                    {italic}
                </em>,
            );
        }
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

// ── Code block ─────────────────────────────────────────────────────────

function CodeBlock({ lang, code }: { lang: string; code: string }) {
    const [copied, setCopied] = useState(false);

    async function handleCopy() {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            /* non-https / old browser — user can select manually */
        }
    }

    return (
        <div className="rounded-lg border border-brand-border overflow-hidden bg-paper-muted">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-brand-border bg-surface">
                <span className="text-[11px] font-mono uppercase tracking-wide text-minor-ink">{lang || 'code'}</span>
                <button
                    type="button"
                    onClick={handleCopy}
                    className={[
                        'text-[11px] px-2 py-0.5 rounded transition-colors duration-150 ease-brand cursor-pointer',
                        copied ? 'text-status-success-text' : 'text-muted-ink hover:text-navy',
                    ].join(' ')}
                >
                    {copied ? '已复制 ✓' : '复制'}
                </button>
            </div>
            <pre className="m-0 p-3 overflow-x-auto text-[13px] leading-relaxed">
                <code className="font-mono text-navy whitespace-pre">{code}</code>
            </pre>
        </div>
    );
}
