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
    {
        id: 'api-endpoints',
        label: 'API 接入速查',
        blurb: 'Base URL + 认证 + 四种接口路径(OpenAI / Anthropic / OpenAI 图像 / Gemini 原生)一览。',
    },
    {
        id: 'api-text',
        label: '文本调用示例',
        blurb: 'Python / Node / curl 三语言示例 + Claude 系 max_tokens ≤ 4096 注意。',
    },
    {
        id: 'api-image',
        label: 'Gemini 生图 · 2K / 4K 高清',
        blurb: 'Gemini Nano Banana / 3.1 Flash / 3 Pro;OpenAI 兼容自动出 2K / 4K,比例走 /v1beta 原生。',
    },
    {
        id: 'api-gpt-image',
        label: 'GPT image-2 生图',
        blurb: 'gpt-image-2 系(自适应 / 1k / 2k / 4k)· OpenAI Images API · 文生图 + 图生图 · ¥0.05/张。',
    },
    {
        id: 'api-billing',
        label: '计费 · 账户 · 网络',
        blurb: '余额 / 充值 / 用量明细入口 + 网络与流式调用建议。',
    },
    {
        id: 'seedance',
        label: 'Seedance 2.0 · 视频生成',
        blurb: 'ByteDance Seedance 2.0 视频生成(文生 / 图生 / 首尾帧 / 参考生)— 异步提交 / 轮询,按秒计费。',
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
                        Codex 有三个客户端形态 — 终端 CLI、IDE 插件(VS Code / Cursor / Windsurf / JetBrains)、桌面 app
                        ——{' '}
                        <strong className="text-navy">
                            共享同一个{' '}
                            <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                ~/.codex/config.toml
                            </code>{' '}
                            配置文件和同一个底层 agent
                        </strong>
                        。下面的步骤 1 配置文件只需写一次,3 个客户端共用。
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
                        等模型,自定义一个 <code className="font-mono text-xs">wire_api = &quot;chat&quot;</code> 的
                        provider,使 Codex 走标准 OpenAI 兼容的{' '}
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
                        如果 <code className="font-mono text-xs">~/.codex/</code> 目录不存在,先{' '}
                        <code className="font-mono text-xs">mkdir -p ~/.codex</code> 再创建文件。Windows 用户路径为{' '}
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
                            (发布者 <code className="font-mono text-xs">openai.chatgpt</code>)。JetBrains 系(IntelliJ /
                            PyCharm / WebStorm / Rider):marketplace 搜 <code className="font-mono text-xs">Codex</code>
                            。
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
                            的 <code className="font-mono text-xs">sk-…</code> → 确定。
                        </li>
                        <li>
                            重启 IDE / reload extension,Codex 侧边栏自动读{' '}
                            <code className="font-mono text-xs">~/.codex/config.toml</code> 里的{' '}
                            <code className="font-mono text-xs">silkroadai</code> provider 路由请求。
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
                        <code className="font-mono text-xs">model = &quot;{SAMPLE_OPENAI_MODEL}&quot;</code> 改成任意
                        OpenAI 兼容模型(如 <code className="font-mono text-xs">gpt-5.5</code>、
                        <code className="font-mono text-xs">gpt-5.4-mini</code>
                        ),保存后无需重装客户端,下次启动生效。完整清单见{' '}
                        <Link href="/models" className="text-navy font-medium hover:text-brand-accent">
                            /models
                        </Link>
                        。
                    </p>
                    <p className="m-0 mt-2 text-xs text-minor-ink">
                        ⚠️ 三个客户端都不要使用 Codex 内置的 <code className="font-mono text-xs">openai</code>{' '}
                        provider(默认 <code className="font-mono text-xs">wire_api = &quot;responses&quot;</code>
                        ),会收到{' '}
                        <code className="font-mono text-xs">
                            403 forbidden_error · OpenAI codex passthrough requires a non-empty instructions field
                        </code>
                        。 必须按步骤 1 新建自定义 provider。
                    </p>
                    <p className="m-0 mt-2 text-xs text-minor-ink">
                        IDE 插件 + 桌面 app 的认证凭据缓存在{' '}
                        <code className="font-mono text-xs">~/.codex/auth.json</code>(明文),换 key 时记得{' '}
                        <code className="font-mono text-xs">rm ~/.codex/auth.json</code> 后重新登录。
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

                {/* ─── 10 · API 接入速查 (W8 D8 customer API guide) ───
                 *  Consolidated reference for customers integrating their
                 *  own code (vs the per-agent setup in 01–07). Source:
                 *  operator-reviewed customer-api-guide 2026-06-04. */}
                <section id="api-endpoints" className="mt-12 mb-10 scroll-mt-20">
                    <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4 pb-3 border-b-2 border-brand-accent">
                        <h2 className="m-0 text-2xl font-semibold text-navy">
                            <span className="text-brand-accent font-bold mr-3 tabular-nums">10</span>
                            API 接入速查
                        </h2>
                    </div>
                    <p className="m-0 mb-4 text-sm text-ink leading-relaxed">
                        想直接写代码接入?一个 API Key 同时支持四种协议路径 —— 用哪条取决于你的客户端 / SDK 习惯。
                        文本对话推荐{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            /v1/chat/completions
                        </code>
                        ,Gemini 2K / 4K 高清图必须走{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            /v1beta
                        </code>{' '}
                        原生路径(见第 12 章)。
                    </p>
                    <ConfigList
                        items={[
                            ['Base URL', ANTHROPIC_BASE],
                            ['认证 Header', 'Authorization: Bearer sk-…'],
                            ['API Key 获取', 'portal /keys(注册登录后创建)'],
                        ]}
                    />
                    <div className="mt-4 rounded-lg overflow-hidden border border-brand-border bg-surface">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        路径
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        格式
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        用途
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">
                                        /v1/chat/completions
                                    </td>
                                    <td className="px-4 py-3 text-ink align-top">OpenAI 兼容</td>
                                    <td className="px-4 py-3 text-ink">所有文本 / 多模态模型(推荐主用)</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">/v1/messages</td>
                                    <td className="px-4 py-3 text-ink align-top">Anthropic 原生</td>
                                    <td className="px-4 py-3 text-ink">Claude 系列</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">
                                        /v1/images/generations
                                    </td>
                                    <td className="px-4 py-3 text-ink align-top">OpenAI 图像兼容</td>
                                    <td className="px-4 py-3 text-ink">gpt-image-2 / DALL·E 系</td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">
                                        /v1beta/models/&lt;model&gt;:generateContent
                                    </td>
                                    <td className="px-4 py-3 text-ink align-top">Gemini 原生</td>
                                    <td className="px-4 py-3 text-ink">
                                        Gemini 高清图像 <strong className="text-navy">2K / 4K</strong>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </section>

                {/* ─── 11 · 文本调用示例 ─── */}
                <section id="api-text" className="mt-12 mb-10 scroll-mt-20">
                    <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4 pb-3 border-b-2 border-brand-accent">
                        <h2 className="m-0 text-2xl font-semibold text-navy">
                            <span className="text-brand-accent font-bold mr-3 tabular-nums">11</span>
                            文本调用示例
                        </h2>
                    </div>
                    <div className="mb-4 rounded-lg border-l-4 border-brand-accent bg-paper-muted px-4 py-3 text-sm text-ink">
                        ⚠️ <strong className="text-navy">Claude 系列 + Cline / Cursor / Roo Code</strong> 请把{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            max_tokens
                        </code>{' '}
                        设为 <strong className="text-navy">≤ 4096</strong> —— 上游有此限制,超过会返
                        502(已知问题,持续跟进)。在 Cline 里请选 <strong className="text-navy">OpenAI Compatible</strong>{' '}
                        provider, 不要选 Anthropic provider(否则会被 SDK 锁住 max_tokens)。
                    </div>
                    <p className="m-0 mb-2 text-sm font-medium text-navy">Python(openai SDK)</p>
                    <CodeBlock language="python">
                        {`from openai import OpenAI

client = OpenAI(
    api_key="sk-…",                       # portal /keys
    base_url="${OPENAI_BASE}",
)

resp = client.chat.completions.create(
    model="${SAMPLE_OPENAI_MODEL}",
    max_tokens=4096,                      # Claude 系建议 ≤4096 避免上游 502
    messages=[{"role": "user", "content": "你好,介绍一下丝绸之路"}],
)
print(resp.choices[0].message.content)`}
                    </CodeBlock>
                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">Node / TypeScript(openai SDK)</p>
                    <CodeBlock language="typescript">
                        {`import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "sk-…",                         // portal /keys
  baseURL: "${OPENAI_BASE}",
});

const completion = await client.chat.completions.create({
  model: "${SAMPLE_ANTHROPIC_MODEL}",
  max_tokens: 4096,
  messages: [{ role: "user", content: "Hello" }],
});
console.log(completion.choices[0].message.content);`}
                    </CodeBlock>
                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">curl</p>
                    <CodeBlock language="bash">
                        {`curl -X POST ${OPENAI_BASE}/chat/completions \\
  -H "Authorization: Bearer sk-…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${SAMPLE_OPENAI_MODEL}",
    "max_tokens": 4096,
    "messages": [{"role":"user","content":"Hello"}]
  }'`}
                    </CodeBlock>
                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">Claude · Anthropic 原生格式(可选)</p>
                    <CodeBlock language="bash">
                        {`curl -X POST ${ANTHROPIC_BASE}/v1/messages \\
  -H "x-api-key: sk-…" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-opus-4-7",
    "max_tokens": 4096,
    "messages": [{"role":"user","content":"Hello"}]
  }'`}
                    </CodeBlock>
                </section>

                {/* ─── 12 · Gemini 生图 2K/4K — the W8 D8 headline.
                 *  Gemini high-res image MUST go through the native
                 *  /v1beta generateContent path with imageConfig.imageSize;
                 *  the OpenAI-compat chat path silently caps at ~1K.
                 *  gpt-image-2 lives in its own chapter (13) — 2026-06-16. */}
                <section id="api-image" className="mt-12 mb-10 scroll-mt-20">
                    <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4 pb-3 border-b-2 border-brand-accent">
                        <h2 className="m-0 text-2xl font-semibold text-navy">
                            <span className="text-brand-accent font-bold mr-3 tabular-nums">12</span>
                            Gemini 生图 · 2K / 4K 高清
                        </h2>
                    </div>
                    <div className="rounded-lg overflow-hidden border border-brand-border bg-surface mb-4">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        模型
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        分辨率
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        价格
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        用途
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">
                                        gemini-2.5-flash-image
                                    </td>
                                    <td className="px-4 py-3 text-ink align-top">~1024×1024(1K)</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">¥0.10 / 张</td>
                                    <td className="px-4 py-3 text-ink">入门,经济</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">
                                        gemini-3.1-flash-image-preview
                                    </td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">2048×2048(2K)</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">¥0.20 / 张</td>
                                    <td className="px-4 py-3 text-ink">高速 + 高清</td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">
                                        gemini-3-pro-image-preview
                                    </td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">
                                        4096×4096(4K)· 可选 2K
                                    </td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">¥0.50 / 张</td>
                                    <td className="px-4 py-3 text-ink">旗舰,最高画质</td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">
                                        gemini-3-pro-image-preview-2k
                                    </td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">2048×2048(2K)</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">¥0.30 / 张</td>
                                    <td className="px-4 py-3 text-ink">旗舰画质 · 省钱 2K(比 4K 省 40%)</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <p className="m-0 mb-2 text-sm font-medium text-navy">
                        Gemini 生图 · OpenAI 兼容(推荐 — 自动 2K / 4K,返回公网 URL)
                    </p>
                    <p className="m-0 mb-2 text-sm text-ink leading-relaxed">
                        任何 OpenAI SDK / 工具改一行 base_url 即可。返回标准 chat.completion,图片是
                        <strong className="text-navy">公网 URL</strong>(不是 base64),形如{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            https://images.silkroadai.io/gen/&lt;uuid&gt;.png
                        </code>
                        。
                    </p>
                    <CodeBlock language="bash">
                        {`# 文生图 — 用哪个模型就拿哪档分辨率(2.5=1K / 3.1=2K / 3-pro=4K)
curl ${OPENAI_BASE}/chat/completions \\
  -H "Authorization: Bearer sk-你的KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gemini-3.1-flash-image-preview",
    "messages": [{ "role": "user", "content": "一只戴帽子的橘猫,水彩风格" }]
  }'
# 响应 choices[0].message.content = "![image](https://images.silkroadai.io/gen/….png)"`}
                    </CodeBlock>
                    <p className="m-0 mt-3 mb-2 text-sm text-ink leading-relaxed">
                        <strong className="text-navy">传图改图</strong>:content 用 OpenAI 多模态数组,加一个{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            image_url
                        </code>
                        (data URL 最稳;外部 http(s) URL 平台代拉,单图 ≤ 20MB,内网地址拒绝)。
                    </p>
                    <CodeBlock language="json">
                        {`{ "role": "user", "content": [
  { "type": "text", "text": "给这只猫戴一顶圣诞帽" },
  { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,<BASE64>" } }
] }`}
                    </CodeBlock>
                    <p className="m-0 mt-3 mb-5 text-xs text-minor-ink">
                        图片默认存平台图床(不保证长期保留,重要图请及时转存)。想让图片直接进
                        <strong className="text-navy">自己的 bucket、用自己的域名</strong> →{' '}
                        <Link href="/settings/storage" className="text-navy font-medium hover:text-brand-accent">
                            存储设置
                        </Link>{' '}
                        配置自定义 OSS(R2 / 阿里 OSS / 腾讯 COS / AWS S3 / 自建;故障自动回退平台图床,不影响出图)。
                    </p>

                    <div className="mt-5 mb-3 rounded-lg border-l-4 border-brand-accent bg-paper-muted px-4 py-3 text-sm text-ink">
                        ✅{' '}
                        <strong className="text-navy">OpenAI 兼容接口现在直接返回该模型的最大分辨率(2K / 4K)。</strong>{' '}
                        平台代理会把{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            /v1/chat/completions
                        </code>{' '}
                        自动翻译到 Gemini 原生接口并注入{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            imageConfig.imageSize
                        </code>
                        —— 用哪个模型就拿哪档分辨率,无需任何额外参数(2026-06-05 起,旧式只出 1K 的问题已解决)。 只有需要
                        <strong className="text-navy">自定义出图比例</strong>(
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            aspectRatio
                        </code>
                        )时,才用下面的原生{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            /v1beta/models/&lt;model&gt;:generateContent
                        </code>{' '}
                        endpoint(默认比例 1:1)。
                    </div>

                    <div className="mt-3 mb-3 rounded-lg border-l-4 border-brand-accent bg-paper-muted px-4 py-3 text-sm text-ink">
                        💰 <strong className="text-navy">要旗舰画质又想省钱?用 2K 折扣型号</strong>{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            gemini-3-pro-image-preview-2k
                        </code>
                        —— 锁定 2K 分辨率、<strong className="text-navy">¥0.30 / 张</strong>(比 4K 原型号省 40%),画质与
                        pro 旗舰同源。用法不变,把请求里的{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            model
                        </code>{' '}
                        换成它即可(
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            /v1/chat/completions
                        </code>{' '}
                        与{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            /v1/images/generations
                        </code>{' '}
                        都支持,出图比例照常用{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            aspect_ratio
                        </code>
                        )。
                        <span className="block mt-1.5 text-xs text-minor-ink">
                            另:原型号{' '}
                            <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                gemini-3-pro-image-preview
                            </code>{' '}
                            也接受{' '}
                            <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                {`size`}
                            </code>{' '}
                            参数(
                            <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                {`"2K"`}
                            </code>
                            /
                            <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                {`"4K"`}
                            </code>
                            ,也认{' '}
                            <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                2048x2048
                            </code>
                            /
                            <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                4096x4096
                            </code>
                            )切分辨率,但<strong className="text-navy">价格不随尺寸变</strong>(仍 ¥0.50)——
                            想省钱请认准上面带{' '}
                            <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                -2k
                            </code>{' '}
                            的型号。
                        </span>
                    </div>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">Gemini 原生 API · curl(2K / 4K)</p>
                    <CodeBlock language="bash">
                        {`# 2K — gemini-3.1-flash-image-preview
curl -X POST "${ANTHROPIC_BASE}/v1beta/models/gemini-3.1-flash-image-preview:generateContent" \\
  -H "Authorization: Bearer sk-…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "contents": [{ "parts": [{ "text": "A calico cat on a window sill" }] }],
    "generationConfig": { "imageConfig": { "imageSize": "2K", "aspectRatio": "1:1" } }
  }'

# 4K — gemini-3-pro-image-preview(把 imageSize 改成 "4K")
curl -X POST "${ANTHROPIC_BASE}/v1beta/models/gemini-3-pro-image-preview:generateContent" \\
  -H "Authorization: Bearer sk-…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "contents": [{ "parts": [{ "text": "A calico cat on a window sill" }] }],
    "generationConfig": { "imageConfig": { "imageSize": "4K", "aspectRatio": "1:1" } }
  }'`}
                    </CodeBlock>
                    <p className="m-0 mt-3 mb-2 text-xs text-minor-ink">
                        响应为 Gemini 原生形:图片在{' '}
                        <code className="font-mono text-xs">candidates[0].content.parts[].inlineData.data</code>{' '}
                        (base64)。
                    </p>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">Python · Google Gen AI SDK</p>
                    <CodeBlock language="python">
                        {`from google import genai
from google.genai import types

client = genai.Client(
    api_key="sk-…",
    http_options=types.HttpOptions(base_url="${ANTHROPIC_BASE}"),
)

resp = client.models.generate_content(
    model="gemini-3.1-flash-image-preview",
    contents="A calico cat sitting on a window sill",
    config=types.GenerateContentConfig(
        image_config=types.ImageConfig(image_size="2K", aspect_ratio="1:1"),
    ),
)
for part in resp.candidates[0].content.parts:
    if part.inline_data:
        open("output.jpg", "wb").write(part.inline_data.data)`}
                    </CodeBlock>

                    <p className="m-0 mt-4 text-xs text-minor-ink">
                        关于 4K 库存:
                        <code className="font-mono text-xs">gemini-3-pro-image-preview</code> 4K 使用 Google
                        限额,每日有上限,超额会返 <code className="font-mono text-xs">429 quota exceeded</code> ——
                        不扣费、不自动降级到 2K,稍后再试或改用 2K 模型即可。
                    </p>
                </section>

                {/* ─── 13 · GPT image-2 生图 (2026-06-16: split out of the Gemini chapter; ch36/czeq, image2 group) ─── */}
                <section id="api-gpt-image" className="mt-12 mb-10 scroll-mt-20">
                    <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4 pb-3 border-b-2 border-brand-accent">
                        <h2 className="m-0 text-2xl font-semibold text-navy">
                            <span className="text-brand-accent font-bold mr-3 tabular-nums">13</span>
                            GPT image-2 生图
                        </h2>
                    </div>
                    <p className="m-0 mb-4 text-sm text-ink leading-relaxed">
                        OpenAI Images API 兼容 ——{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            POST /v1/images/generations
                        </code>{' '}
                        文生图、
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            POST /v1/images/edits
                        </code>{' '}
                        图生图。现有 OpenAI SDK 改一行 base_url 即可。返回{' '}
                        <strong className="text-navy">b64_json</strong>(Base64 PNG)。
                        <strong className="text-navy"> 请用 image2 分组创建的 API Key</strong> 调用全部档位。
                    </p>

                    <div className="rounded-lg overflow-hidden border border-brand-border bg-surface mb-4">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        模型
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        分辨率
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        价格
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        用途
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">gpt-image-2</td>
                                    <td className="px-4 py-3 text-ink align-top">自适应</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">¥0.05 / 张</td>
                                    <td className="px-4 py-3 text-ink">默认推荐,最快</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">gpt-image-2-1k</td>
                                    <td className="px-4 py-3 text-ink align-top">锁定 1K</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">¥0.05 / 张</td>
                                    <td className="px-4 py-3 text-ink">稳定 1024</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">gpt-image-2-2k</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">锁定 2K</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">¥0.05 / 张</td>
                                    <td className="px-4 py-3 text-ink">更清晰</td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">gpt-image-2-4k</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">锁定 4K</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">¥0.05 / 张</td>
                                    <td className="px-4 py-3 text-ink">最高清(较慢,见下)</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <p className="m-0 mb-4 text-xs text-minor-ink">
                        专用档(-1k / -2k / -4k)会强制按各自档位输出,即使 size 传了别的尺寸。4 档同价 ¥0.05 / 张。
                    </p>

                    <p className="m-0 mb-2 text-sm font-medium text-navy">文生图 · /v1/images/generations</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/images/generations \\
  -H "Authorization: Bearer sk-你的KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "一只戴圣诞帽的橘猫,工作室灯光,高细节",
    "size": "1536x1024"
  }'`}
                    </CodeBlock>
                    <CodeBlock language="python">
                        {`from openai import OpenAI
import base64

client = OpenAI(api_key="sk-你的KEY", base_url="${OPENAI_BASE}")

resp = client.images.generate(
    model="gpt-image-2",
    prompt="一只戴圣诞帽的橘猫,工作室灯光,高细节",
    size="1536x1024",
)
with open("out.png", "wb") as f:
    f.write(base64.b64decode(resp.data[0].b64_json))`}
                    </CodeBlock>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">图生图 · /v1/images/edits(multipart)</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/images/edits \\
  -H "Authorization: Bearer sk-你的KEY" \\
  -F model=gpt-image-2 \\
  -F prompt="把背景换成雪景" \\
  -F image=@cat.png`}
                    </CodeBlock>

                    <div className="mt-4 mb-3 rounded-lg border-l-4 border-brand-border bg-paper-muted px-4 py-3 text-sm text-ink">
                        🖼️ <strong className="text-navy">返回与计费</strong>:图片在{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            data[0].b64_json
                        </code>
                        (Base64 的 PNG,自行解码保存;始终返回 b64,传 response_format=url 也回 b64)。实际
                        <strong className="text-navy">按 ¥0.05 / 张</strong>扣费,响应里的 usage 仅平台估算、勿用于对账。
                        上游报错<strong className="text-navy">原样透传</strong>(状态码 + OpenAI 错误体)。
                    </div>

                    <div className="mt-3 mb-3 rounded-lg border-l-4 border-brand-accent bg-paper-muted px-4 py-3 text-sm text-ink">
                        ⏱️ <strong className="text-navy">4K(gpt-image-2-4k)又慢又大</strong>:单张约 7–8MB、生成最长约
                        120s。接入务必把<strong className="text-navy">超时设到 ≥ 180s</strong>{' '}
                        并对偶发断连重试一次;不强求 4K 时优先用 gpt-image-2(自适应)或 -1k / -2k,更快更稳。
                        <span className="block mt-1.5 text-xs text-minor-ink">
                            Python:
                            <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                OpenAI(..., timeout=180.0, max_retries=2)
                            </code>
                        </span>
                    </div>

                    <div className="mt-3 mb-3 rounded-lg border-l-4 border-brand-border bg-paper-muted px-4 py-3 text-sm text-ink">
                        🛡️ <strong className="text-navy">内容准则</strong>:禁止暴力 / 血腥 / 未成年 / NSFW、侵权 / 违法
                        / 恐怖活动相关(即便无关键词、被识别出意图也不出图)。ComfyUI 用户
                        <strong className="text-navy">不要带 SD 式负面提示词</strong>
                        (易被风控误伤);图生图时参考图含上述内容同样不出图。
                    </div>
                </section>

                {/* ─── 14 · 计费 · 账户 · 网络 ─── */}
                <section id="api-billing" className="mt-12 mb-10 scroll-mt-20">
                    <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4 pb-3 border-b-2 border-brand-accent">
                        <h2 className="m-0 text-2xl font-semibold text-navy">
                            <span className="text-brand-accent font-bold mr-3 tabular-nums">14</span>
                            计费 · 账户 · 网络
                        </h2>
                    </div>
                    <ul className="list-none p-0 m-0 grid grid-cols-1 gap-2 text-sm mb-4">
                        <li className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
                            <span className="text-muted-ink min-w-[120px] text-xs uppercase tracking-wide">
                                实时余额
                            </span>
                            <span className="text-ink">
                                <Link href="/balance" className="text-navy font-medium hover:text-brand-accent">
                                    /balance
                                </Link>{' '}
                                —— 余额 + 累计消费
                            </span>
                        </li>
                        <li className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
                            <span className="text-muted-ink min-w-[120px] text-xs uppercase tracking-wide">充值</span>
                            <span className="text-ink">
                                <Link href="/pay" className="text-navy font-medium hover:text-brand-accent">
                                    /pay
                                </Link>{' '}
                                —— 支付宝 / 微信 / Stripe
                            </span>
                        </li>
                        <li className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
                            <span className="text-muted-ink min-w-[120px] text-xs uppercase tracking-wide">
                                用量明细
                            </span>
                            <span className="text-ink">
                                <Link href="/usage" className="text-navy font-medium hover:text-brand-accent">
                                    /usage
                                </Link>{' '}
                                —— 按模型 / token / 日期
                            </span>
                        </li>
                    </ul>
                    <p className="m-0 text-xs text-minor-ink leading-relaxed">
                        网络:接入点 <code className="font-mono text-xs">ai.silkroadai.io</code> 多区域
                        CDN,国内通常可直连。流式调用对网络稳定性敏感,丢包可能导致 502 —— 频繁出错时可尝试关闭{' '}
                        <code className="font-mono text-xs">stream</code>,或换用更稳定的线路。排查时把响应里的{' '}
                        <code className="font-mono text-xs">request_id</code> 发给客服可快速定位。
                    </p>
                </section>

                <section id="seedance" className="mt-12 mb-10 scroll-mt-20">
                    <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4 pb-3 border-b-2 border-brand-accent">
                        <h2 className="m-0 text-2xl font-semibold text-navy">
                            <span className="text-brand-accent font-bold mr-3 tabular-nums">15</span>
                            Seedance 2.0 · 视频生成
                        </h2>
                    </div>
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        ByteDance Seedance 2.0 视频生成,3 个分辨率档,支持文生 / 图生 / 首尾帧 / 参考生。
                        <strong className="text-navy">异步接口</strong>
                        :提交后拿到{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            task_id
                        </code>
                        ,轮询直到{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            SUCCESS
                        </code>{' '}
                        取视频 URL。走{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            /v1/video/generations
                        </code>
                        ,<strong className="text-navy">不是</strong>{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            /v1/chat/completions
                        </code>
                        (后者会 404)。
                    </p>
                    <div className="rounded-lg overflow-hidden border border-brand-border bg-surface mb-3">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        模型
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        分辨率
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        价格(按秒)
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        5 秒 / 15 秒
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">seedance-2.0</td>
                                    <td className="px-4 py-3 text-ink align-top">≤ 720P</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">¥0.04 / 秒</td>
                                    <td className="px-4 py-3 text-ink align-top">¥0.20 / ¥0.60</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">
                                        seedance-2.0-fast
                                    </td>
                                    <td className="px-4 py-3 text-ink align-top">480P</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">¥0.04 / 秒</td>
                                    <td className="px-4 py-3 text-ink align-top">¥0.20 / ¥0.60</td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">
                                        seedance-2.0-1080p
                                    </td>
                                    <td className="px-4 py-3 text-ink align-top">1080P</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">¥0.12 / 秒</td>
                                    <td className="px-4 py-3 text-ink align-top">¥0.60 / ¥1.80</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <p className="m-0 mb-5 text-xs text-minor-ink">
                        按视频实际时长(秒)计费;
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            duration
                        </code>{' '}
                        控制秒数(默认 4 秒)。
                    </p>

                    <p className="m-0 mb-2 text-sm font-medium text-navy">1) 提交任务</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations \\
  -H "Authorization: Bearer sk-你的KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "model": "seedance-2.0", "prompt": "一只猫在沙滩上散步", "duration": 5 }'
# → { "task_id": "task_xxx", "object": "video", "status": "queued", "progress": 10 }`}
                    </CodeBlock>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">2) 轮询直到完成</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations/task_xxx -H "Authorization: Bearer sk-你的KEY"
# status: IN_PROGRESS … 约 1–2 分钟后 "status": "SUCCESS"
# 视频地址在 data.data.video_url(公网 .mp4)`}
                    </CodeBlock>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">Python(提交 + 轮询)</p>
                    <CodeBlock language="python">
                        {`import time, requests

H = {"Authorization": "Bearer sk-你的KEY", "Content-Type": "application/json"}
B = "${OPENAI_BASE}/video/generations"

task = requests.post(B, headers=H, json={
    "model": "seedance-2.0", "prompt": "一只猫在沙滩上散步", "duration": 5,
}).json()
tid = task["task_id"]

while True:
    r = requests.get(f"{B}/{tid}", headers=H).json()
    status = r.get("data", {}).get("status") or r.get("status")
    if status in ("SUCCESS", "FAILURE"):
        break
    time.sleep(10)

print(r["data"]["data"]["video_url"])`}
                    </CodeBlock>

                    <p className="m-0 mt-6 mb-2 text-sm font-semibold text-navy">进阶:图生 / 首尾帧 / 参考生</p>
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        同一接口,加图片字段即可。
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            image
                        </code>{' '}
                        与{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            last_frame_image
                        </code>{' '}
                        只接受<strong className="text-navy">字符串</strong>(https 链接或 base64 dataURL,传数组会 400);
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            reference_images
                        </code>{' '}
                        是数组,最多 4 张。
                    </p>

                    <p className="m-0 mb-2 text-sm font-medium text-navy">图生视频(一张图当首帧,让它动)</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations \\
  -H "Authorization: Bearer sk-你的KEY" -H "Content-Type: application/json" \\
  -d '{ "model": "seedance-2.0", "prompt": "镜头缓缓推进,头发被风吹动", "duration": 5, "image": "https://你的图床/first.png" }'`}
                    </CodeBlock>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">首尾帧(给开头和结尾,补中间过程)</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations \\
  -H "Authorization: Bearer sk-你的KEY" -H "Content-Type: application/json" \\
  -d '{ "model": "seedance-2.0", "prompt": "镜头从全景平滑过渡到特写", "duration": 5, "image": "https://你的图床/first.png", "last_frame_image": "https://你的图床/last.png" }'`}
                    </CodeBlock>
                    <p className="m-0 mt-2 text-xs text-minor-ink">
                        尾帧字段名是{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            last_frame_image
                        </code>
                        ,不是{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            image_tail
                        </code>
                        。
                    </p>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">参考生(锁人物 / 风格一致)</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations \\
  -H "Authorization: Bearer sk-你的KEY" -H "Content-Type: application/json" \\
  -d '{ "model": "seedance-2.0", "prompt": "这个女孩在花园里奔跑,阳光明媚", "duration": 5, "reference_images": ["https://你的图床/role-a.png", "https://你的图床/role-b.png"] }'`}
                    </CodeBlock>
                    <p className="m-0 mt-2 text-xs text-minor-ink">
                        <strong className="text-navy">图生</strong>:图片是视频第一帧;{' '}
                        <strong className="text-navy">参考生</strong>:图片不出现在画面里,只锁长相 / 画风。两者可同时用。
                    </p>

                    <p className="m-0 mt-4 text-xs text-minor-ink">
                        进阶可选字段(随模型透传,不填走默认):{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            aspect_ratio
                        </code>
                        、
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            resolution
                        </code>
                        、
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            generate_audio
                        </code>
                        、
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            camera_fixed
                        </code>
                        。纯文生较慢(约 3–6 分钟),偶发{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            504
                        </code>{' '}
                        重试即可;视频直链约 24 小时失效,请及时转存。
                    </p>
                    <p className="m-0 mt-3 text-xs text-minor-ink">
                        3 个模型同一接口,只改{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            model
                        </code>
                        。
                    </p>
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
