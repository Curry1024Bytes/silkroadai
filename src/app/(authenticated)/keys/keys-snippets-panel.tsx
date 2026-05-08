'use client';

import { useState } from 'react';
import Link from 'next/link';

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

const OPENAI_BASE = 'https://ai.silkroadai.io/v1';
const ANTHROPIC_BASE = 'https://ai.silkroadai.io';
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
            className="mt-8 rounded-xl border border-brand-border bg-surface overflow-hidden"
        >
            <header className="px-5 py-4 border-b border-brand-border bg-paper-muted">
                <h2
                    id="keys-snippets-heading"
                    className="m-0 text-base font-semibold text-navy"
                >
                    调用示例
                </h2>
                <p className="m-0 mt-1 text-xs text-muted-ink">
                    复制代码 · 把 <code className="font-mono text-xs bg-surface px-1 py-0.5 rounded border border-brand-border text-navy">{PLACEHOLDER}</code>{' '}
                    换成上方表格里 <strong className="text-navy">显示</strong> + <strong className="text-navy">复制</strong> 到的 sk-… 即可。
                </p>
            </header>

            <div className="px-5 pt-4 pb-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <BaseUrlChip
                    label="OpenAI 兼容 Base URL"
                    value={OPENAI_BASE}
                />
                <BaseUrlChip
                    label="Anthropic 兼容 Base URL"
                    value={ANTHROPIC_BASE}
                />
            </div>

            <div
                role="tablist"
                aria-label="代码示例语言"
                className="px-5 pt-3 flex gap-1 border-b border-brand-border"
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
                                'px-3 py-2 text-sm font-medium cursor-pointer',
                                'border-0 bg-transparent border-b-2',
                                'transition-colors duration-150 ease-brand',
                                isActive
                                    ? 'text-navy border-brand-accent'
                                    : 'text-muted-ink border-transparent hover:text-navy',
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
                        'absolute top-3 right-3 z-10 text-xs px-2.5 py-1 rounded cursor-pointer',
                        'transition-colors duration-150 ease-brand',
                        copied
                            ? 'bg-status-success-text text-paper'
                            : 'bg-white/10 text-paper-muted hover:bg-brand-accent hover:text-navy-strong',
                    ].join(' ')}
                >
                    {copied ? '已复制 ✓' : '复制'}
                </button>
                <pre className="m-0 px-5 py-4 bg-navy-strong overflow-x-auto text-xs leading-relaxed">
                    <code
                        className="font-mono text-paper-muted block"
                        style={{ whiteSpace: 'pre', wordBreak: 'normal' }}
                    >
                        {tab.code}
                    </code>
                </pre>
            </div>

            <footer className="px-5 py-3 border-t border-brand-border text-xs text-muted-ink flex flex-wrap gap-x-4 gap-y-1">
                <span>
                    模型示例 →{' '}
                    <Link
                        href="/models"
                        className="text-navy font-medium hover:text-brand-accent"
                    >
                        {SAMPLE_MODEL}
                    </Link>
                </span>
                <span>
                    完整集成指南 →{' '}
                    <Link
                        href="/docs"
                        className="text-navy font-medium hover:text-brand-accent"
                    >
                        /docs
                    </Link>
                </span>
            </footer>
        </section>
    );
}

function BaseUrlChip({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center gap-2 bg-paper-muted border border-brand-border rounded-lg px-3 py-2">
            <div className="flex-1 min-w-0">
                <p className="m-0 text-xs text-muted-ink">{label}</p>
                <p
                    className="m-0 font-mono text-sm text-navy truncate"
                    title={value}
                >
                    {value}
                </p>
            </div>
        </div>
    );
}
