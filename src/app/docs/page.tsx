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
        'Silk Road AI 一键集成文档:Cursor、Cline、Continue、Claude Code Desktop、OpenAI Codex(CLI / IDE 插件 / 桌面 app)、Python / Node SDK。OpenAI / Anthropic 兼容协议,5 分钟接入。',
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
    {
        id: 'codex-cli',
        label: 'OpenAI Codex(CLI / IDE / Desktop)',
        blurb: 'Codex 三客户端形态共享 ~/.codex/config.toml — wire_api = "chat" 走标准 OpenAI 兼容路径,可指定 gpt-5.4 等模型。',
    },
    { id: 'python-sdk', label: 'Python (openai SDK)', blurb: '官方 openai Python 包,实测可调通。' },
    { id: 'node-sdk', label: 'Node / TypeScript (openai SDK)', blurb: '官方 openai Node 包,实测可调通。' },
    {
        id: 'gemini',
        label: 'Google Gemini · 同一 base URL',
        blurb: 'Gemini 3.1 / Nano Banana / imagen-4 / veo-3.1 全部 OpenAI 兼容路径调用。',
    },
    {
        id: 'errors',
        label: '常见错误码',
        blurb: '401 / 403 insufficient_user_quota / 503 no available channel — body code 优先于 status。',
    },
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
                    {/* W7 D4 PR-R Item D — back-to-landing link, sits
                     *  above the h1 so customers who deep-linked into
                     *  /docs from a chat or a docs search have an
                     *  explicit way back. Small + muted per spec. */}
                    <Link
                        href="/"
                        className="inline-flex items-center gap-1 mb-3 text-xs text-muted-ink hover:text-brand-accent transition-colors duration-150 ease-brand no-underline w-fit"
                    >
                        <span aria-hidden="true">←</span>
                        <span>返回首页</span>
                    </Link>
                    <h1 className="m-0 mb-3 text-3xl font-semibold text-navy">集成文档</h1>
                    <p className="m-0 mb-2 text-base text-muted-ink leading-relaxed max-w-3xl">
                        Silk Road AI 完全 OpenAI 兼容(同时提供 Anthropic 兼容协议), 所有支持自定义 base URL 的客户端 /
                        SDK 一行替换即可接入。
                    </p>
                    <p className="m-0 text-sm text-muted-ink">
                        没有 key?先{' '}
                        <Link href="/portal/register" className="text-navy font-medium hover:text-brand-accent">
                            注册一个账户
                        </Link>{' '}
                        — 30 秒拿到能用的{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            sk-…
                        </code>
                        。
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
                    <h2 className="m-0 mb-3 text-sm font-semibold uppercase tracking-wide text-muted-ink">目录</h2>
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
                        Cursor 设置里有 OpenAI 自定义模型入口,填入 base URL + API Key + 模型名即可。 各版本 Cursor
                        设置面板路径偶有调整,以官方最新文档为准。
                    </p>
                    <ConfigList
                        items={[
                            ['Override OpenAI Base URL', OPENAI_BASE],
                            ['OpenAI API Key', 'sk-… (portal /keys)'],
                            ['Model name', SAMPLE_OPENAI_MODEL + ' / claude-sonnet-4-6 / 等'],
                        ]}
                    />
                    <p className="m-0 mt-3 text-xs text-minor-ink">
                        注:Cursor 的「自定义 OpenAI 模型」开关位置随版本变动,建议直接搜索 Cursor docs
                        中的「OpenAI」关键字定位最新指引。
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
                        Cline 在 VS Code 设置里支持 OpenAI Compatible provider,base URL + API Key + 手填模型 ID
                        即可。具体下拉选项名称以官方最新文档为准。
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
                        Continue 通过{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            config.yaml
                        </code>{' '}
                        /{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            config.json
                        </code>{' '}
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
                        不同版本可能略有差异。模型名替换为 <code className="font-mono text-xs">claude-sonnet-4-6</code>{' '}
                        等亦可。
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
                        search;若需要可同时设置 <code className="font-mono text-xs">ENABLE_TOOL_SEARCH=true</code>。
                    </p>
                </AgentBlock>

                {/* ─── OpenAI Codex(CLI / IDE / Desktop)───
                 *  Codex 三客户端形态(CLI / IDE 插件 / 桌面 app)共享同一个
                 *  ~/.codex/config.toml 配置文件和同一个底层 agent
                 *  (https://developers.openai.com/codex/ide 明示)。客户配置
                 *  一次,所有客户端通用。关键约束:必须自定义一个
                 *  wire_api = "chat" 的 provider,旁路 Codex 内置 `openai`
                 *  provider 的默认 wire_api = "responses" 路径(与上游 sub2api
                 *  passthrough 的 instructions 字段约束冲突,gotcha #18)。
                 */}
                <AgentBlock
                    id="codex-cli"
                    number="05"
                    title="OpenAI Codex(CLI / IDE 插件 / 桌面 app)"
                    docsUrl="https://developers.openai.com/codex/config-advanced"
                    docsLabel="developers.openai.com/codex/config-advanced"
                >
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        Codex 有三个客户端形态 — 终端 CLI、IDE 插件(VS Code / Cursor / Windsurf / JetBrains)、桌面 app —— <strong className="text-navy">共享同一个{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            ~/.codex/config.toml
                        </code>{' '}
                        配置文件和同一个底层 agent</strong>。下面的步骤 1 配置文件只需写一次,3 个客户端共用。
                    </p>
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        Codex 内置的{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            openai
                        </code>{' '}
                        provider 默认走 OpenAI Responses API(<code className="font-mono text-xs">/v1/responses</code>
                        ),多数兼容网关不支持。要让 Codex 调 Silk Road AI 的{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            {SAMPLE_OPENAI_MODEL}
                        </code>{' '}
                        等模型,自定义一个{' '}
                        <code className="font-mono text-xs">wire_api = &quot;chat&quot;</code>{' '}
                        的 provider,使 Codex 走标准 OpenAI 兼容的{' '}
                        <code className="font-mono text-xs">/v1/chat/completions</code> 路径即可。
                    </p>

                    <p className="m-0 mt-4 mb-2 text-sm text-ink font-medium">
                        步骤 1:编辑共享配置{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            ~/.codex/config.toml
                        </code>
                        (三客户端通用)
                    </p>
                    <CodeBlock language="yaml">
                        {`# Silk Road AI provider — wire_api = "chat" 走 /v1/chat/completions
model = "${SAMPLE_OPENAI_MODEL}"
model_provider = "silkroadai"

[model_providers.silkroadai]
name = "Silk Road AI"
base_url = "${OPENAI_BASE}"
env_key = "OPENAI_API_KEY"
wire_api = "chat"`}
                    </CodeBlock>
                    <p className="m-0 mt-2 text-xs text-minor-ink">
                        如果{' '}
                        <code className="font-mono text-xs">~/.codex/</code>{' '}
                        目录不存在,先 <code className="font-mono text-xs">mkdir -p ~/.codex</code>{' '}
                        再创建文件。Windows 用户路径为{' '}
                        <code className="font-mono text-xs">%USERPROFILE%\.codex\config.toml</code>。
                    </p>

                    <p className="m-0 mt-5 mb-2 text-sm text-ink font-medium">步骤 2:挑你用的客户端安装 + 登录</p>

                    <p className="m-0 mb-2 mt-3 text-sm text-ink font-medium">2.1 终端 CLI</p>
                    <CodeBlock language="bash">
                        {`# 安装(macOS / Linux / Windows,需 Node 20+)
npm install -g @openai/codex
# 或 Homebrew(macOS): brew install --cask codex

# 启动(macOS / Linux)
export OPENAI_API_KEY="sk-…"   # portal /keys
codex

# 启动(Windows PowerShell)
$env:OPENAI_API_KEY = "sk-…"
codex`}
                    </CodeBlock>

                    <p className="m-0 mb-2 mt-4 text-sm text-ink font-medium">
                        2.2 IDE 插件(VS Code / Cursor / Windsurf / JetBrains 全系)
                    </p>
                    <ol className="m-0 mb-2 text-sm text-ink leading-relaxed list-decimal pl-5 space-y-1">
                        <li>
                            <span className="text-ink">VS Code / Cursor / Windsurf:</span> marketplace 搜{' '}
                            <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                Codex – OpenAI&apos;s coding agent
                            </code>{' '}
                            (发布者{' '}
                            <code className="font-mono text-xs">openai.chatgpt</code>)。JetBrains 系(IntelliJ / PyCharm / WebStorm / Rider):marketplace 搜{' '}
                            <code className="font-mono text-xs">Codex</code>。
                        </li>
                        <li>
                            打开 Codex 侧边栏 →{' '}
                            <strong className="text-navy">不要点 &quot;Sign in with ChatGPT&quot;</strong>,改点{' '}
                            <strong className="text-navy">&quot;Use API Key&quot;</strong>。
                        </li>
                        <li>
                            粘贴 portal{' '}
                            <Link href="/keys" className="text-navy font-medium hover:text-brand-accent">
                                /keys
                            </Link>{' '}
                            的{' '}
                            <code className="font-mono text-xs">sk-…</code> → 确定。
                        </li>
                        <li>
                            重启 IDE / reload extension,Codex 侧边栏自动读{' '}
                            <code className="font-mono text-xs">~/.codex/config.toml</code>{' '}
                            里的{' '}
                            <code className="font-mono text-xs">silkroadai</code>{' '}
                            provider 路由请求。
                        </li>
                    </ol>
                    <p className="m-0 mt-1 text-xs text-minor-ink">
                        VS Code 内也可走 Settings → Extensions → Codex → API Key 字段粘贴 sk-…,效果等同 2 + 3 步。
                    </p>

                    <p className="m-0 mb-2 mt-4 text-sm text-ink font-medium">2.3 桌面 app</p>
                    <CodeBlock language="bash">
                        {`# CLI 安装好后,内置桌面 app 子命令
codex app

# 首次打开会弹 sign-in 对话框,同 2.2 一样:
#   选 "Use API Key" → 粘贴 sk-… → 确定`}
                    </CodeBlock>

                    <p className="m-0 mt-5 text-xs text-minor-ink">
                        切换模型:把步骤 1 配置文件里的{' '}
                        <code className="font-mono text-xs">model = &quot;{SAMPLE_OPENAI_MODEL}&quot;</code>{' '}
                        改成任意 OpenAI 兼容模型(如{' '}
                        <code className="font-mono text-xs">gpt-5.5</code>、
                        <code className="font-mono text-xs">gpt-5.4-mini</code>),保存后无需重装客户端,下次启动生效。完整清单见{' '}
                        <Link href="/models" className="text-navy font-medium hover:text-brand-accent">
                            /models
                        </Link>
                        。
                    </p>
                    <p className="m-0 mt-2 text-xs text-minor-ink">
                        ⚠️ 三个客户端都不要使用 Codex 内置的{' '}
                        <code className="font-mono text-xs">openai</code> provider(默认{' '}
                        <code className="font-mono text-xs">wire_api = &quot;responses&quot;</code>),会收到{' '}
                        <code className="font-mono text-xs">403 forbidden_error · OpenAI codex passthrough requires a non-empty instructions field</code>。
                        必须按步骤 1 新建自定义 provider。
                    </p>
                    <p className="m-0 mt-2 text-xs text-minor-ink">
                        IDE 插件 + 桌面 app 的认证凭据缓存在{' '}
                        <code className="font-mono text-xs">~/.codex/auth.json</code>(明文),换 key 时记得{' '}
                        <code className="font-mono text-xs">rm ~/.codex/auth.json</code>{' '}
                        后重新登录。
                    </p>
                </AgentBlock>

                {/* ─── Python SDK ─── */}
                <AgentBlock
                    id="python-sdk"
                    number="06"
                    title="Python(openai SDK)"
                    docsUrl="https://github.com/openai/openai-python"
                    docsLabel="github.com/openai/openai-python"
                >
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        官方{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            openai
                        </code>{' '}
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
                    number="07"
                    title="Node / TypeScript(openai SDK)"
                    docsUrl="https://github.com/openai/openai-node"
                    docsLabel="github.com/openai/openai-node"
                >
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        官方{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            openai
                        </code>{' '}
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

                {/* PR-S — Gemini family note. Surfaces the new Gemini
                 *  3.1 / Nano Banana / imagen-4 / veo-3.1 SKUs as
                 *  callable via the same OpenAI-compat base URL — no
                 *  separate SDK / endpoint switch needed. The model
                 *  names listed here are routable as of PR-S apply
                 *  (verified via Stage 4 real-call). */}
                <section id="gemini" className="mt-12 mb-10 scroll-mt-20">
                    <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4 pb-3 border-b-2 border-brand-accent">
                        <h2 className="m-0 text-2xl font-semibold text-navy">
                            <span className="text-brand-accent font-bold mr-3 tabular-nums">08</span>
                            Google Gemini · 通过同一个 base URL 调用
                        </h2>
                    </div>
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        Gemini 全家(包括最新 Nano Banana 图像生成)与 OpenAI 兼容协议接入,base URL + SDK 都不变,只需把{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            model
                        </code>{' '}
                        换成 Gemini 模型名即可。
                    </p>
                    <ConfigList
                        items={[
                            ['Base URL', OPENAI_BASE],
                            ['Text · Pro 旗舰', 'gemini-3.1-pro-preview'],
                            ['Text · 高速 / 低成本', 'gemini-3.1-flash-lite'],
                            ['Image · Nano Banana 3 Pro', 'gemini-3-pro-image-preview / nano-banana-pro-preview'],
                            ['Image · Nano Banana 3.1 Flash', 'gemini-3.1-flash-image-preview'],
                            ['Image · Imagen 4 Ultra', 'imagen-4.0-ultra-generate-001'],
                            ['Video', 'veo-3.1-generate-preview / -fast / -lite'],
                            ['Embedding', 'gemini-embedding-2'],
                        ]}
                    />
                    <p className="m-0 mt-3 text-xs text-minor-ink">
                        完整可调用清单 →{' '}
                        <Link href="/models" className="text-navy font-medium hover:text-brand-accent">
                            /models
                        </Link>{' '}
                        · 图像 / 视频按官方价透传(无加价),文本同样透传,公式见 portal{' '}
                        <Link href="/pricing" className="text-navy font-medium hover:text-brand-accent">
                            /pricing
                        </Link>
                        (暂未上线 — 表见 landing 页)。
                    </p>
                </section>

                {/* W7 D4 PR-H Tier B: surface the most common upstream
                 *  error codes a customer will see + plain-language
                 *  explanation. The 402-vs-403 status rewriting for
                 *  `insufficient_user_quota` is queued under issue
                 *  #27 (launch follow-up); for now the customer
                 *  identifies the problem by the body code, which is
                 *  stable regardless of HTTP status. */}
                <section id="errors" className="mt-12 mb-10 scroll-mt-20">
                    <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4 pb-3 border-b-2 border-brand-accent">
                        <h2 className="m-0 text-2xl font-semibold text-navy">
                            <span className="text-brand-accent font-bold mr-3 tabular-nums">09</span>
                            常见错误码
                        </h2>
                    </div>
                    <p className="m-0 mb-4 text-sm text-ink leading-relaxed">
                        如果您调用返回非 2xx,请先看响应 body 中的{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            error.code
                        </code>{' '}
                        字段(比 HTTP status 更精准)。下表列出最常见的三种:
                    </p>
                    <div className="rounded-lg overflow-hidden border border-brand-border bg-surface">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        HTTP
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        body error.code
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        含义 / 处理
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-navy align-top">401</td>
                                    <td className="px-4 py-3 font-mono text-navy align-top">invalid_authentication</td>
                                    <td className="px-4 py-3 text-ink">
                                        API key 无效或缺 <code className="font-mono text-xs">sk-</code> 前缀。 portal{' '}
                                        <a href="/keys" className="text-navy font-medium hover:text-brand-accent">
                                            /keys
                                        </a>{' '}
                                        重新复制完整 51 字符串。
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-navy align-top">403</td>
                                    <td className="px-4 py-3 font-mono text-navy align-top">insufficient_user_quota</td>
                                    <td className="px-4 py-3 text-ink">
                                        <strong className="text-navy">账户余额不足</strong>(注:HTTP 语义上更接近 402
                                        Payment Required;新版会改 status 码,当前以 body 的 error.code 为准)。 前往{' '}
                                        <Link href="/balance" className="text-navy font-medium hover:text-brand-accent">
                                            /balance
                                        </Link>{' '}
                                        查看余额,
                                        <Link href="/pay" className="text-navy font-medium hover:text-brand-accent">
                                            /pay
                                        </Link>{' '}
                                        充值。
                                    </td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-3 font-mono text-navy align-top">503</td>
                                    <td className="px-4 py-3 font-mono text-navy align-top">no available channel</td>
                                    <td className="px-4 py-3 text-ink">
                                        模型名拼写错误,或该模型暂时下线。请用{' '}
                                        <a href="/models" className="text-navy font-medium hover:text-brand-accent">
                                            /models
                                        </a>{' '}
                                        页搜索一下确认模型 id。
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </section>

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
                <li key={k} className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3 text-sm">
                    <span className="text-muted-ink min-w-[180px] text-xs uppercase tracking-wide">{k}</span>
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
        <div className="rounded-lg overflow-hidden border border-brand-border bg-navy-strong" data-language={language}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-white/10">
                <span className="text-xs font-mono uppercase tracking-wider text-paper-muted opacity-70">
                    {language}
                </span>
            </div>
            <pre className="m-0 p-4 overflow-x-auto text-sm leading-relaxed">
                <code className="font-mono text-paper-muted block" style={{ whiteSpace: 'pre', wordBreak: 'normal' }}>
                    {children}
                </code>
            </pre>
        </div>
    );
}
