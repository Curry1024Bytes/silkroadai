'use client';

import { useState } from 'react';
import Link from 'next/link';

/**
 * Per-row "如何使用此 Key" panel (W7 D4 PR-G — Tier 1).
 *
 * Renders inline below each key row in the /keys table. Default state
 * is collapsed; the parent flips this open automatically once for a
 * newly-created key (the only case where eager onboarding helps —
 * established keys already have customer-side integration).
 *
 * Each snippet has its own copy-to-clipboard button. When `revealedKey`
 * is non-empty (the row's "显示" action just unwrapped the sk-, or the
 * key was auto-revealed after creation), the snippets interpolate the
 * actual value; otherwise the placeholder `sk-…` shows + a one-liner
 * tells the user to grab their key from the row's "复制" button. This
 * tracks the existing reveal-state machine without adding a second
 * fetch path.
 *
 * The panel exposes both the OpenAI-compatible base URL (used by the
 * 3 snippets) and the Anthropic-compatible base URL for users who want
 * to wire Claude Code Desktop / Anthropic SDK separately.
 */

const OPENAI_BASE = 'https://ai.silkroadai.io/v1';
const ANTHROPIC_BASE = 'https://ai.silkroadai.io';
const SAMPLE_MODEL = 'claude-sonnet-4-6';

interface KeyHowtoPanelProps {
    /** Either the actual revealed sk- (when the row's reveal map has it)
     *  or null/undefined → snippet shows the `sk-…` placeholder. */
    revealedKey: string | null | undefined;
    /** Whether this row's panel should render in the open state. The
     *  parent owns the toggle so it can apply the "auto-expand on create"
     *  semantic. */
    open: boolean;
    /** Called when the user clicks the panel's collapse/expand toggle. */
    onToggle: () => void;
}

type CopyMap = Record<string, boolean>;

export function KeyHowtoPanel({ revealedKey, open, onToggle }: KeyHowtoPanelProps) {
    const [copied, setCopied] = useState<CopyMap>({});
    const keyForSnippet = revealedKey || 'sk-…';

    const curl = [
        `curl ${OPENAI_BASE}/chat/completions \\`,
        `  -H "Authorization: Bearer ${keyForSnippet}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{`,
        `    "model": "${SAMPLE_MODEL}",`,
        `    "messages": [{"role": "user", "content": "Hello"}]`,
        `  }'`,
    ].join('\n');

    const python = [
        `from openai import OpenAI`,
        ``,
        `client = OpenAI(`,
        `    base_url="${OPENAI_BASE}",`,
        `    api_key="${keyForSnippet}",`,
        `)`,
        ``,
        `resp = client.chat.completions.create(`,
        `    model="${SAMPLE_MODEL}",`,
        `    messages=[{"role": "user", "content": "Hello"}],`,
        `)`,
        `print(resp.choices[0].message.content)`,
    ].join('\n');

    const node = [
        `import OpenAI from 'openai';`,
        ``,
        `const client = new OpenAI({`,
        `  baseURL: '${OPENAI_BASE}',`,
        `  apiKey: '${keyForSnippet}',`,
        `});`,
        ``,
        `const resp = await client.chat.completions.create({`,
        `  model: '${SAMPLE_MODEL}',`,
        `  messages: [{ role: 'user', content: 'Hello' }],`,
        `});`,
        `console.log(resp.choices[0].message.content);`,
    ].join('\n');

    async function handleCopy(slot: string, value: string) {
        try {
            await navigator.clipboard.writeText(value);
            setCopied((prev) => ({ ...prev, [slot]: true }));
            setTimeout(() => {
                setCopied((prev) => {
                    const next = { ...prev };
                    delete next[slot];
                    return next;
                });
            }, 1500);
        } catch {
            // Older browsers / non-https — silent. The text is still
            // visible for a manual copy.
        }
    }

    return (
        <div className="bg-paper-muted border-t border-brand-border">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                aria-controls={`howto-content-${slug(keyForSnippet)}`}
                className={[
                    'w-full text-left px-4 py-2.5 text-sm font-medium text-muted-ink',
                    'hover:bg-paper-muted/60 hover:text-navy transition-colors duration-150 ease-brand',
                    'flex items-center gap-2 cursor-pointer',
                    'border-0 bg-transparent',
                ].join(' ')}
            >
                <span
                    className="inline-block transition-transform duration-150 ease-brand"
                    style={{
                        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
                    }}
                    aria-hidden="true"
                >
                    ▸
                </span>
                <span>如何使用此 Key</span>
                {!open ? (
                    <span className="text-xs text-minor-ink ml-auto">点击展开 base URL + curl / Python / Node 示例</span>
                ) : null}
            </button>

            {open ? (
                <div
                    id={`howto-content-${slug(keyForSnippet)}`}
                    className="px-4 pb-4 pt-1 space-y-4"
                >
                    {/* Base URLs */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <BaseUrlCard
                            label="OpenAI 兼容"
                            value={OPENAI_BASE}
                            copied={copied['openai-base'] ?? false}
                            onCopy={() => handleCopy('openai-base', OPENAI_BASE)}
                        />
                        <BaseUrlCard
                            label="Anthropic 兼容"
                            value={ANTHROPIC_BASE}
                            copied={copied['anthropic-base'] ?? false}
                            onCopy={() => handleCopy('anthropic-base', ANTHROPIC_BASE)}
                        />
                    </div>

                    {!revealedKey ? (
                        <p className="m-0 text-xs text-minor-ink">
                            示例中 <code className="font-mono text-xs bg-surface px-1 py-0.5 rounded border border-brand-border text-navy">sk-…</code>{' '}
                            是占位 — 复制后替换为您的实际 key(行内点 「复制」 按钮取)。
                        </p>
                    ) : null}

                    {/* Snippets */}
                    <SnippetBlock
                        title="curl"
                        code={curl}
                        copied={copied['curl'] ?? false}
                        onCopy={() => handleCopy('curl', curl)}
                    />
                    <SnippetBlock
                        title="Python (openai)"
                        code={python}
                        copied={copied['python'] ?? false}
                        onCopy={() => handleCopy('python', python)}
                    />
                    <SnippetBlock
                        title="Node / TypeScript (openai)"
                        code={node}
                        copied={copied['node'] ?? false}
                        onCopy={() => handleCopy('node', node)}
                    />

                    <p className="m-0 text-xs text-muted-ink">
                        如何选模型? →{' '}
                        <Link
                            href="/models"
                            className="text-navy font-medium hover:text-brand-accent"
                        >
                            /models
                        </Link>{' '}
                        · 完整集成指南 →{' '}
                        <Link
                            href="/docs"
                            className="text-navy font-medium hover:text-brand-accent"
                        >
                            /docs
                        </Link>
                    </p>
                </div>
            ) : null}
        </div>
    );
}

function BaseUrlCard({
    label,
    value,
    copied,
    onCopy,
}: {
    label: string;
    value: string;
    copied: boolean;
    onCopy: () => void;
}) {
    return (
        <div className="flex items-center gap-2 bg-surface border border-brand-border rounded-lg px-3 py-2">
            <div className="flex-1 min-w-0">
                <p className="m-0 text-xs text-muted-ink">{label}</p>
                <p className="m-0 font-mono text-sm text-navy truncate" title={value}>
                    {value}
                </p>
            </div>
            <button
                type="button"
                onClick={onCopy}
                className={[
                    'shrink-0 text-xs px-2.5 py-1 rounded-lg cursor-pointer',
                    'border transition-colors duration-150 ease-brand',
                    copied
                        ? 'bg-status-success-bg border-status-success-border text-status-success-text'
                        : 'bg-paper border-brand-border text-muted-ink hover:border-brand-accent hover:text-navy',
                ].join(' ')}
                aria-label={`复制 ${label} base URL`}
            >
                {copied ? '已复制 ✓' : '复制'}
            </button>
        </div>
    );
}

function SnippetBlock({
    title,
    code,
    copied,
    onCopy,
}: {
    title: string;
    code: string;
    copied: boolean;
    onCopy: () => void;
}) {
    return (
        <div className="rounded-lg overflow-hidden border border-brand-border bg-navy-strong">
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                <span className="text-xs font-mono uppercase tracking-wider text-paper-muted opacity-70">
                    {title}
                </span>
                <button
                    type="button"
                    onClick={onCopy}
                    className={[
                        'text-xs px-2.5 py-1 rounded cursor-pointer',
                        'transition-colors duration-150 ease-brand',
                        copied
                            ? 'bg-status-success-text text-paper'
                            : 'bg-white/10 text-paper-muted hover:bg-brand-accent hover:text-navy-strong',
                    ].join(' ')}
                    aria-label={`复制 ${title} 示例`}
                >
                    {copied ? '已复制 ✓' : '复制'}
                </button>
            </div>
            <pre className="m-0 px-3 py-3 overflow-x-auto text-xs leading-relaxed">
                <code
                    className="font-mono text-paper-muted block"
                    style={{ whiteSpace: 'pre', wordBreak: 'normal' }}
                >
                    {code}
                </code>
            </pre>
        </div>
    );
}

/** Sanitize the revealed key (or the placeholder) into something safe
 *  to embed in an `id=` attribute. We just take the last 8 chars of
 *  whatever non-whitespace remains; collisions across rows are fine
 *  because the panel id is scoped under each <tr>. */
function slug(s: string): string {
    return s.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'panel';
}
