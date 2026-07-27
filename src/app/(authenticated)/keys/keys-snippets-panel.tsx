'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Check, Code2, Copy } from 'lucide-react';
import { ANTHROPIC_API_BASE_URL, OPENAI_API_BASE_URL } from '@/lib/public-config';

/**
 * Unified bottom "调用示例" panel for /keys (W7 D4 PR-R Item C).
 *
 * Replaces the W7 PR-G per-row `KeyHowtoPanel` (each table row had its
 * own collapsible "如何使用此 Key" footer — visually noisy with N
 * duplicated panels). This is a single panel sitting below the keys
 * table with three tabs (curl / Python / Node) and a `YOUR_API_KEY`
 * placeholder.
 *
 * Usage flow the customer follows:
 *   1. Reveal a key in the table above and copy it.
 *   2. Pick the matching tab here (curl / Python / Node).
 *   3. Click the in-snippet "复制" button (top-right of code block).
 *   4. Paste into their own code, swap `YOUR_API_KEY` for the sk-…
 *      they copied in step 1.
 *
 * Static — no per-row coupling, no reveal interpolation. The placeholder
 * is intentional: the keys-list above is the canonical "where do I get
 * my actual key" surface; this panel is the reference snippet shown to
 * everyone (matches chat.b.ai/key's design).
 */

const OPENAI_BASE = OPENAI_API_BASE_URL;
const ANTHROPIC_BASE = ANTHROPIC_API_BASE_URL;
const SAMPLE_MODEL = 'claude-sonnet-4-6';
const PLACEHOLDER = 'YOUR_API_KEY';

type TabId = 'curl' | 'python' | 'node';

interface TabDef {
    id: TabId;
    label: string;
    code: string;
}

const TABS: TabDef[] = [
    {
        id: 'curl',
        label: 'curl',
        code: [
            `curl ${OPENAI_BASE}/chat/completions \\`,
            `  -H "Authorization: Bearer ${PLACEHOLDER}" \\`,
            `  -H "Content-Type: application/json" \\`,
            `  -d '{`,
            `    "model": "${SAMPLE_MODEL}",`,
            `    "messages": [{"role": "user", "content": "Hello"}]`,
            `  }'`,
        ].join('\n'),
    },
    {
        id: 'python',
        label: 'Python',
        code: [
            `from openai import OpenAI`,
            ``,
            `client = OpenAI(`,
            `    base_url="${OPENAI_BASE}",`,
            `    api_key="${PLACEHOLDER}",`,
            `)`,
            ``,
            `resp = client.chat.completions.create(`,
            `    model="${SAMPLE_MODEL}",`,
            `    messages=[{"role": "user", "content": "Hello"}],`,
            `)`,
            `print(resp.choices[0].message.content)`,
        ].join('\n'),
    },
    {
        id: 'node',
        label: 'Node SDK',
        code: [
            `import OpenAI from 'openai';`,
            ``,
            `const client = new OpenAI({`,
            `  baseURL: '${OPENAI_BASE}',`,
            `  apiKey: '${PLACEHOLDER}',`,
            `});`,
            ``,
            `const resp = await client.chat.completions.create({`,
            `  model: '${SAMPLE_MODEL}',`,
            `  messages: [{ role: 'user', content: 'Hello' }],`,
            `});`,
            `console.log(resp.choices[0].message.content);`,
        ].join('\n'),
    },
];

export function KeysSnippetsPanel() {
    const [active, setActive] = useState<TabId>('curl');
    const [copied, setCopied] = useState(false);

    const tab = TABS.find((t) => t.id === active) ?? TABS[0];

    async function handleCopy() {
        try {
            await navigator.clipboard.writeText(tab.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Older browsers / non-https — silent. The code stays
            // visible for a manual copy.
        }
    }

    return (
        <section
            aria-labelledby="keys-snippets-heading"
            className="overflow-hidden rounded-lg border border-portal-line bg-portal-panel shadow-portal"
        >
            <header className="flex items-start gap-3 border-b border-portal-line px-4 py-4 sm:px-5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-portal-gold-soft text-portal-gold">
                    <Code2 size={18} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                    <h2 id="keys-snippets-heading" className="m-0 text-sm font-semibold text-portal-ink">
                        调用示例
                    </h2>
                    <p className="m-0 mt-1 text-xs leading-relaxed text-portal-muted">
                        复制代码后，将{' '}
                        <code className="rounded bg-portal-soft px-1.5 py-0.5 font-mono text-[11px] text-portal-ink">
                            {PLACEHOLDER}
                        </code>{' '}
                        替换为上方复制的密钥。
                    </p>
                </div>
            </header>

            <div className="grid grid-cols-1 border-b border-portal-line bg-portal-soft sm:grid-cols-2 sm:divide-x sm:divide-portal-line">
                <BaseUrlChip label="OpenAI 兼容 Base URL" value={OPENAI_BASE} />
                <BaseUrlChip label="Anthropic 兼容 Base URL" value={ANTHROPIC_BASE} />
            </div>

            <div
                role="tablist"
                aria-label="代码示例语言"
                className="flex gap-1 border-b border-portal-line px-4 pt-3 sm:px-5"
            >
                {TABS.map((t) => {
                    const isActive = t.id === active;
                    return (
                        <button
                            key={t.id}
                            role="tab"
                            type="button"
                            id={`keys-snippet-tab-${t.id}`}
                            aria-selected={isActive}
                            aria-controls={`keys-snippet-panel-${t.id}`}
                            onClick={() => {
                                setActive(t.id);
                                setCopied(false);
                            }}
                            className={[
                                'cursor-pointer px-3 py-2 text-sm font-medium',
                                'border-0 bg-transparent border-b-2',
                                'transition-colors duration-150 ease-brand',
                                isActive
                                    ? 'border-portal-gold text-portal-ink'
                                    : 'border-transparent text-portal-muted hover:text-portal-ink',
                            ].join(' ')}
                        >
                            {t.label}
                        </button>
                    );
                })}
            </div>

            <div
                role="tabpanel"
                id={`keys-snippet-panel-${tab.id}`}
                aria-labelledby={`keys-snippet-tab-${tab.id}`}
                className="relative"
            >
                <button
                    type="button"
                    onClick={handleCopy}
                    aria-label={`复制 ${tab.label} 示例代码`}
                    className={[
                        'absolute right-3 top-3 z-10 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium',
                        'transition-colors duration-150 ease-brand',
                        copied
                            ? 'border-status-success-text bg-status-success-text text-white'
                            : 'border-white/15 bg-white/10 text-white/75 hover:bg-white/15 hover:text-white',
                    ].join(' ')}
                >
                    {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                    <span>{copied ? '已复制' : '复制'}</span>
                </button>
                <pre className="m-0 min-h-[210px] overflow-x-auto bg-navy-strong px-4 py-5 pr-24 text-xs leading-relaxed sm:px-5">
                    <code
                        className="font-mono text-paper-muted block"
                        style={{ whiteSpace: 'pre', wordBreak: 'normal' }}
                    >
                        {tab.code}
                    </code>
                </pre>
            </div>

            <footer className="flex flex-wrap gap-x-5 gap-y-2 border-t border-portal-line px-4 py-3 text-xs text-portal-muted sm:px-5">
                <span>
                    模型示例{' '}
                    <Link
                        href="/workspace/models"
                        className="inline-flex items-center gap-0.5 font-medium text-portal-ink hover:text-portal-gold"
                    >
                        {SAMPLE_MODEL}
                        <ArrowUpRight size={12} aria-hidden="true" />
                    </Link>
                </span>
                <span>
                    <Link
                        href="/workspace/docs"
                        className="inline-flex items-center gap-0.5 font-medium text-portal-ink hover:text-portal-gold"
                    >
                        完整集成指南
                        <ArrowUpRight size={12} aria-hidden="true" />
                    </Link>
                </span>
            </footer>
        </section>
    );
}

function BaseUrlChip({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0 px-4 py-3 sm:px-5">
            <div className="min-w-0">
                <p className="m-0 text-[11px] font-medium text-portal-subtle">{label}</p>
                <p className="m-0 mt-1 truncate font-mono text-xs text-portal-ink" title={value}>
                    {value}
                </p>
            </div>
        </div>
    );
}
