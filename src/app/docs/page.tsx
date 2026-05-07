/**
 * /docs — public quickstart for connecting various AI coding agents +
 * official OpenAI SDKs to ai.silkroadai.io (W7 D4 PR-G).
 *
 * Server-rendered, no client JS — copy buttons live in the /keys
 * inline panel where customers actually have a key in hand. Here on
 * /docs the goal is reference + linkability (anchor TOC, deep-link
 * to a specific agent section).
 *
 * Endpoint truth verified via curl probe before writing this page:
 *   - OpenAI compat:    https://ai.silkroadai.io/v1     (POST /v1/chat/completions → 401 unauth, confirmed live)
 *   - Anthropic compat: https://ai.silkroadai.io        (POST /v1/messages → 401 unauth, confirmed live)
 *
 * Per W7 D4 PR-G brief: where the official docs site for an agent did
 * not surface concrete UI navigation paths during pre-build research,
 * we link the docs and describe the universal fields rather than
 * invent menu names. Source URLs:
 *   Cursor          https://cursor.com/docs
 *   Cline           https://docs.cline.bot
 *   Continue        https://docs.continue.dev
 *   Claude Code     https://code.claude.com/docs/en/env-vars        (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN ground-truthed)
 *   Python SDK      https://github.com/openai/openai-python         (base_url + api_key ground-truthed)
 *   Node SDK        https://github.com/openai/openai-node           (baseURL + apiKey ground-truthed)
 */
import Link from 'next/link';
import { Logo } from '@/components/brand/Logo';
import { Card } from '@/components/ui/Card';

export const metadata = {
    title: '集成文档 — Silk Road AI',
    description:
        'Silk Road AI 一键集成文档:Cursor、Cline、Continue、Claude Code Desktop、Python / Node SDK。OpenAI / Anthropic 兼容协议,5 分钟接入。',
};

interface AgentSection {
    id: string;
    label: string;
    /** Brief one-liner shown in the section heading area. */
    blurb: string;
}

const AGENTS: AgentSection[] = [
    {
        id: 'cursor',
        label: 'Cursor',
        blurb: 'Cursor 编辑器,自定义 OpenAI 兼容模型。',
    },
    { id: 'cline', label: 'Cline (VS Code)', blurb: 'Cline VS Code 扩展,OpenAI 兼容 provider。' },
    {
        id: 'continue',
        label: 'Continue (VS Code / JetBrains)',
        blurb: 'Continue 扩展,YAML / JSON 配置 OpenAI provider。',
    },
    {
        id: 'claude-code',
        label: 'Claude Code Desktop / CLI',
        blurb: 'Claude Code 第三方 API:ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN 环境变量。',
    },
    { id: 'python-sdk', label: 'Python (openai SDK)', blurb: '官方 openai Python 包,实测可调通。' },
    { id: 'node-sdk', label: 'Node / TypeScript (openai SDK)', blurb: '官方 openai Node 包,实测可调通。' },
];

const OPENAI_BASE = 'https://ai.silkroadai.io/v1';
const ANTHROPIC_BASE = 'https://ai.silkroadai.io';
const SAMPLE_OPENAI_MODEL = 'gpt-5.4';
const SAMPLE_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

export default function DocsPage() {
    return (
        <main className="min-h-screen bg-paper">
            <header className="border-b border-brand-border bg-paper sticky top-0 z-30">
                <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between gap-4">
                    <Logo variant="primary-flat" size={28} />
                    <nav className="flex items-center gap-3 text-sm">
                        <Link href="/models" className="text-muted-ink hover:text-navy no-underline">
                            模型清单
                        </Link>
                        <Link href="/login" className="text-muted-ink hover:text-navy no-underline">
                            登录
                        </Link>
                        <Link
                            href="/dashboard"
                            className="px-3 py-1.5 border border-navy rounded-lg text-navy no-underline hover:bg-paper-muted"
                        >
                            进入控制台 →
                        </Link>
                    </nav>
                </div>
            </header>

            <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10">
                <section className="mb-10">
                    <h1 className="m-0 mb-3 text-3xl font-semibold text-navy">集成文档</h1>
                    <p className="m-0 mb-2 text-base text-muted-ink leading-relaxed max-w-3xl">
                        Silk Road AI 完全 OpenAI 兼容(同时提供 Anthropic 兼容协议),
                        所有支持自定义 base URL 的客户端 / SDK 一行替换即可接入。
                    </p>
                    <p className="m-0 text-sm text-muted-ink">
                        没有 key?先{' '}
                        <Link href="/portal/register" className="text-navy font-medium hover:text-brand-accent">
                            注册一个账户
                        </Link>{' '}
                        — 30 秒拿到能用的 <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">sk-…</code>。
                    </p>
                </section>

                <Card className="p-5 mb-10">
                    <h2 className="m-0 mb-3 text-base font-semibold text-navy">通用配置</h2>
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 m-0 text-sm">
                        <div>
                            <dt className="text-xs text-muted-ink mb-1">OpenAI 兼容 Base URL</dt>
                            <dd className="m-0 font-mono text-sm text-navy break-all">{OPENAI_BASE}</dd>
                        </div>
                        <div>
                            <dt className="text-xs text-muted-ink mb-1">Anthropic 兼容 Base URL</dt>
                            <dd className="m-0 font-mono text-sm text-navy break-all">{ANTHROPIC_BASE}</dd>
                        </div>
                        <div>
                            <dt className="text-xs text-muted-ink mb-1">API Key</dt>
                            <dd className="m-0 text-sm text-ink">
                                portal{' '}
                                <Link href="/keys" className="text-navy font-medium hover:text-brand-accent">
                                    /keys
                                </Link>{' '}
                                创建,形如{' '}
                                <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                    sk-…
                                </code>
                            </dd>
                        </div>
                        <div>
                            <dt className="text-xs text-muted-ink mb-1">模型清单</dt>
                            <dd className="m-0 text-sm text-ink">
                                完整清单 →{' '}
                                <Link href="/models" className="text-navy font-medium hover:text-brand-accent">
                                    /models
                                </Link>
                            </dd>
                        </div>
                    </dl>
                </Card>

                <nav aria-label="目录" className="mb-10">
                    <h2 className="m-0 mb-3 text-sm font-semibold uppercase tracking-wide text-muted-ink">
                        目录
                    </h2>
                    <ol className="grid grid-cols-1 sm:grid-cols-2 gap-2 list-none p-0 m-0">
                        {AGENTS.map((a, i) => (
                            <li key={a.id}>
                                <a
                                    href={`#${a.id}`}
                                    className="block px-3 py-2 bg-surface border border-brand-border rounded-lg no-underline text-sm text-ink hover:border-brand-accent hover:bg-paper-muted transition-colors duration-150 ease-brand"
                                >
                                    <span className="text-brand-accent font-semibold mr-2 tabular-nums">
                                        {String(i + 1).padStart(2, '0')}
                                    </span>
                                    <span className="font-medium text-navy">{a.label}</span>
                                    <span className="block mt-0.5 text-xs text-muted-ink">{a.blurb}</span>
                                </a>
                            </li>
                        ))}
                    </ol>
                </nav>

                {/* ─── Cursor ─── */}
                <AgentBlock
                    id="cursor"
                    number="01"
                    title="Cursor"
                    docsUrl="https://cursor.com/docs"
                    docsLabel="cursor.com/docs"
                >
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        Cursor 设置里有 OpenAI 自定义模型入口,填入 base URL + API Key + 模型名即可。
                        各版本 Cursor 设置面板路径偶有调整,以官方最新文档为准。
                    </p>
                    <ConfigList
                        items={[
                            ['Override OpenAI Base URL', OPENAI_BASE],
                            ['OpenAI API Key', 'sk-… (portal /keys)'],
                            ['Model name', SAMPLE_OPENAI_MODEL + ' / claude-sonnet-4-6 / 等'],
                        ]}
                    />
                    <p className="m-0 mt-3 text-xs text-minor-ink">
                        注:Cursor 的"自定义 OpenAI 模型"开关位置随版本变动,建议直接搜索 Cursor docs
                        中的 "OpenAI" 关键字定位最新指引。
                    </p>
                </AgentBlock>

                {/* ─── Cline ─── */}
                <AgentBlock
                    id="cline"
                    number="02"
                    title="Cline (VS Code)"
                    docsUrl="https://docs.cline.bot"
                    docsLabel="docs.cline.bot"
                >
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        Cline 在 VS Code 设置里支持 OpenAI Compatible provider,base URL + API Key
                        + 手填模型 ID 即可。具体下拉选项名称以官方最新文档为准。
                    </p>
                    <ConfigList
                        items={[
                            ['API Provider', 'OpenAI Compatible(下拉选项)'],
                            ['Base URL', OPENAI_BASE],
                            ['API Key', 'sk-… (portal /keys)'],
                            ['Model ID', SAMPLE_OPENAI_MODEL],
                        ]}
                    />
                </AgentBlock>

                {/* ─── Continue ─── */}
                <AgentBlock
                    id="continue"
                    number="03"
                    title="Continue (VS Code / JetBrains)"
                    docsUrl="https://docs.continue.dev"
                    docsLabel="docs.continue.dev"
                >
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        Continue 通过 <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">config.yaml</code>{' '}
                        / <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">config.json</code>{' '}
                        管理模型。OpenAI provider 加一条即可:
                    </p>
                    <CodeBlock language="yaml">
{`models:
  - name: Silk Road AI · gpt-5.4
    provider: openai
    apiBase: ${OPENAI_BASE}
    apiKey: sk-…   # portal /keys
    model: ${SAMPLE_OPENAI_MODEL}
    roles:
      - chat
      - edit`}
                    </CodeBlock>
                    <p className="m-0 mt-3 text-xs text-minor-ink">
                        字段名(provider / apiBase / apiKey / model)以 Continue 官方 schema 为准,
                        不同版本可能略有差异。模型名替换为{' '}
                        <code className="font-mono text-xs">claude-sonnet-4-6</code> 等亦可。
                    </p>
                </AgentBlock>

                {/* ─── Claude Code Desktop / CLI ─── */}
                <AgentBlock
                    id="claude-code"
                    number="04"
                    title="Claude Code Desktop / CLI"
                    docsUrl="https://code.claude.com/docs/en/env-vars"
                    docsLabel="code.claude.com/docs/en/env-vars"
                >
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        Claude Code 通过两个环境变量切到 Anthropic 兼容的第三方网关,启动前导出即可。
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            ANTHROPIC_AUTH_TOKEN
                        </code>{' '}
                        会以 Bearer 形式注入 Authorization 头。
                    </p>
                    <CodeBlock language="bash">
{`# macOS / Linux
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE}"
export ANTHROPIC_AUTH_TOKEN="sk-…"   # portal /keys
claude

# Windows PowerShell
$env:ANTHROPIC_BASE_URL = "${ANTHROPIC_BASE}"
$env:ANTHROPIC_AUTH_TOKEN = "sk-…"
claude`}
                    </CodeBlock>
                    <p className="m-0 mt-3 text-xs text-minor-ink">
                        Claude Code 检测到 ANTHROPIC_BASE_URL 指向非官方主机时,默认会停用 MCP tool
                        search;若需要可同时设置{' '}
                        <code className="font-mono text-xs">ENABLE_TOOL_SEARCH=true</code>。
                    </p>
                </AgentBlock>

                {/* ─── Python SDK ─── */}
                <AgentBlock
                    id="python-sdk"
                    number="05"
                    title="Python(openai SDK)"
                    docsUrl="https://github.com/openai/openai-python"
                    docsLabel="github.com/openai/openai-python"
                >
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        官方 <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">openai</code>{' '}
                        Python 包构造函数接受 <code className="font-mono text-xs">base_url</code> +{' '}
                        <code className="font-mono text-xs">api_key</code>(snake_case),改一行即可。
                    </p>
                    <CodeBlock language="python">
{`from openai import OpenAI

client = OpenAI(
    base_url="${OPENAI_BASE}",
    api_key="sk-…",   # portal /keys
)

resp = client.chat.completions.create(
    model="${SAMPLE_OPENAI_MODEL}",
    messages=[
        {"role": "user", "content": "你好,简短自我介绍一下。"},
    ],
)
print(resp.choices[0].message.content)`}
                    </CodeBlock>
                </AgentBlock>

                {/* ─── Node SDK ─── */}
                <AgentBlock
                    id="node-sdk"
                    number="06"
                    title="Node / TypeScript(openai SDK)"
                    docsUrl="https://github.com/openai/openai-node"
                    docsLabel="github.com/openai/openai-node"
                >
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        官方 <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">openai</code>{' '}
                        Node 包构造函数接受 <code className="font-mono text-xs">baseURL</code> +{' '}
                        <code className="font-mono text-xs">apiKey</code>(camelCase),改一行即可。
                    </p>
                    <CodeBlock language="typescript">
{`import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${OPENAI_BASE}',
  apiKey: 'sk-…',   // portal /keys
});

const resp = await client.chat.completions.create({
  model: '${SAMPLE_OPENAI_MODEL}',
  messages: [
    { role: 'user', content: '你好,简短自我介绍一下。' },
  ],
});
console.log(resp.choices[0].message.content);`}
                    </CodeBlock>
                </AgentBlock>

                <section className="mt-12 mb-6 text-center">
                    <h2 className="m-0 mb-2 text-base font-semibold text-navy">遇到问题?</h2>
                    <p className="m-0 text-sm text-muted-ink">
                        微信{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            Global_Ads
                        </code>{' '}
                        · 邮箱{' '}
                        <a
                            href="mailto:support@silkroadai.io"
                            className="text-navy no-underline border-b border-dotted border-navy hover:text-brand-accent hover:border-brand-accent"
                        >
                            support@silkroadai.io
                        </a>
                    </p>
                </section>
            </div>
        </main>
    );
}

/* ──────────────────────────────────────────────────────────────────── */

function AgentBlock({
    id,
    number,
    title,
    docsUrl,
    docsLabel,
    children,
}: {
    id: string;
    number: string;
    title: string;
    docsUrl: string;
    docsLabel: string;
    children: React.ReactNode;
}) {
    return (
        <section id={id} className="mb-10 scroll-mt-20">
            <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4 pb-3 border-b-2 border-brand-accent">
                <h2 className="m-0 text-2xl font-semibold text-navy">
                    <span className="text-brand-accent font-bold mr-3 tabular-nums">{number}</span>
                    {title}
                </h2>
                <a
                    href={docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-muted-ink no-underline hover:text-navy"
                >
                    官方文档 → <span className="font-mono text-xs">{docsLabel}</span>
                </a>
            </div>
            {children}
        </section>
    );
}

function ConfigList({ items }: { items: Array<[string, string]> }) {
    return (
        <ul className="list-none p-0 m-0 grid grid-cols-1 gap-2">
            {items.map(([k, v]) => (
                <li
                    key={k}
                    className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3 text-sm"
                >
                    <span className="text-muted-ink min-w-[180px] text-xs uppercase tracking-wide">
                        {k}
                    </span>
                    <span className="font-mono text-sm text-navy break-all">{v}</span>
                </li>
            ))}
        </ul>
    );
}

function CodeBlock({
    language,
    children,
}: {
    language: 'bash' | 'python' | 'typescript' | 'yaml' | 'json';
    children: string;
}) {
    return (
        <div
            className="rounded-lg overflow-hidden border border-brand-border bg-navy-strong"
            data-language={language}
        >
            <div className="flex items-center justify-between px-4 py-2 border-b border-white/10">
                <span className="text-xs font-mono uppercase tracking-wider text-paper-muted opacity-70">
                    {language}
                </span>
            </div>
            <pre className="m-0 p-4 overflow-x-auto text-sm leading-relaxed">
                <code
                    className="font-mono text-paper-muted block"
                    style={{ whiteSpace: 'pre', wordBreak: 'normal' }}
                >
                    {children}
                </code>
            </pre>
        </div>
    );
}
