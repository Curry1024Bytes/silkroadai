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
import { BackButton } from '@/components/BackButton';
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
        blurb: 'Gemini Nano Banana / 3.1 Flash / 3 Pro;3 种接口(OpenAI 兼容 / DALL·E images / 原生)+ 比例控制 + 自定义图床。',
    },
    {
        id: 'api-gpt-image',
        label: 'GPT image-2 生图',
        blurb: 'gpt-image-2 · OpenAI Images API · 文生图 + 图生图 · Azure 官方稳定 · 高并发 · 按 token 计费(¥1.3=官方$1)。',
    },
    {
        id: 'api-billing',
        label: '计费 · 账户 · 网络',
        blurb: '余额 / 充值 / 用量明细入口 + 网络与流式调用建议。',
    },
    {
        id: 'seedance',
        label: 'Seedance 2.0 · 视频生成',
        blurb: 'Seedance 2.0 全能视频 — 文生 / 图生 / 多图@引用 / 首尾帧 / 参考视频 / 参考音频;720P·1080P,需「seedance逆向低价」档 key。',
    },
    {
        id: 'seedance-overseas',
        label: 'Seedance 海外满血 · 高质量视频',
        blurb: '即梦 Seedance 2.0 官方满血源 — 文生 / 图生 / 首尾帧 / 参考视频 / 参考音频;需「seedance海外满血」档 key。',
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
                    <BackButton className="inline-flex items-center gap-1 mb-3 text-xs text-muted-ink hover:text-brand-accent transition-colors duration-150 ease-brand no-underline w-fit cursor-pointer border-0 bg-transparent p-0">
                        <span aria-hidden="true">←</span>
                        <span>返回</span>
                    </BackButton>
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
                                    <td className="px-4 py-3 text-navy align-top font-medium">4096×4096(4K)</td>
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

                    <div className="mt-1 mb-5 rounded-lg border-l-4 border-brand-accent bg-paper-muted px-4 py-3 text-sm text-ink">
                        📐 <strong className="text-navy">「档」是像素预算,不是固定方边长。</strong> 上表尺寸为{' '}
                        <strong className="text-navy">1:1</strong> 比例下的值;同一档总像素量不变,实际宽高随比例重新分布
                        —— 指定 16:9 等宽幅时长边更大(2K 长边 ≈ 2816、4K ≈ 5504)。
                        <span className="block mt-1.5 text-xs text-minor-ink">
                            不指定比例时:
                            <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                gemini-2.5-flash-image
                            </code>{' '}
                            默认出方图,
                            <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                gemini-3.1-flash-image-preview
                            </code>{' '}
                            与 pro 系默认出 16:9 宽幅。要正方形或其他比例 → 见下方「出图比例」。
                        </span>
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
                        —— 用哪个模型就拿哪档分辨率,无需任何额外参数(2026-06-05 起,旧式只出 1K 的问题已解决)。
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
                    </div>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">出图比例</p>
                    <p className="m-0 mb-2 text-sm text-ink leading-relaxed">
                        OpenAI{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            chat/completions
                        </code>{' '}
                        接口本身没有比例参数,这条路上:<strong className="text-navy">文生图</strong> 走 Gemini
                        默认取景(2.5-flash 出方图;3.1-flash 与 pro 出 16:9 宽幅),
                        <strong className="text-navy">传图改图</strong> 自动跟随输入图比例。要{' '}
                        <strong className="text-navy">精确指定比例</strong> → 用下方 DALL·E 接口的{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            aspect_ratio
                        </code>{' '}
                        参数,或原生接口的{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            aspectRatio
                        </code>
                        (完整取值见下方「出图比例白名单」)。
                    </p>

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

                    <div className="mt-3 mb-3 rounded-lg border-l-4 border-brand-accent bg-paper-muted px-4 py-3 text-sm text-ink">
                        💡 <strong className="text-navy">计费按 model 名算:</strong>{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            gemini-3-pro-image-preview-2k
                        </code>{' '}
                        = 2K ¥0.30,
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            gemini-3-pro-image-preview
                        </code>{' '}
                        = 4K ¥0.50。给 4K 的原型号传{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            {`imageSize:"2K"`}
                        </code>{' '}
                        出的是 2K 图,但仍<strong className="text-navy">按 4K 价 ¥0.50 计费</strong> —— 要省钱拿
                        2K,直接用带{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            -2k
                        </code>{' '}
                        的 model。
                    </div>

                    {/* ─── DALL·E 兼容接口 /v1/images/* (W9 D4) ─── */}
                    <p className="m-0 mt-6 mb-2 text-sm font-medium text-navy">
                        Gemini 生图 · DALL·E 兼容接口(/v1/images/*)
                    </p>
                    <p className="m-0 mb-2 text-sm text-ink leading-relaxed">
                        要用 OpenAI 图像专用接口(
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            images.generate
                        </code>{' '}
                        /{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            images.edit
                        </code>
                        )或需要<strong className="text-navy">显式比例</strong>时用这条。返回标准 DALL·E 形{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            {`{ "created":…, "data":[{ "url" | "b64_json" }] }`}
                        </code>
                        。
                    </p>
                    <CodeBlock language="bash">
                        {`# 文生图 — /v1/images/generations(显式比例)
curl ${OPENAI_BASE}/images/generations \\
  -H "Authorization: Bearer sk-你的KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gemini-3-pro-image-preview",
    "prompt": "赛博朋克城市夜景,雨后霓虹",
    "aspect_ratio": "16:9",
    "response_format": "url"
  }'

# 改图 — /v1/images/edits(multipart;image 可重复传多张参考图,也支持 JSON + data URL)
curl ${OPENAI_BASE}/images/edits \\
  -H "Authorization: Bearer sk-你的KEY" \\
  -F model="gemini-3-pro-image-preview" \\
  -F prompt="把这两张人物合到同一个海边场景" \\
  -F aspect_ratio="3:2" \\
  -F image=@person1.png \\
  -F image=@person2.png`}
                    </CodeBlock>
                    <div className="rounded-lg overflow-hidden border border-brand-border bg-surface my-3">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        参数
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        取值
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        说明
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">model</td>
                                    <td className="px-4 py-3 text-ink align-top">见上表 Gemini 生图模型</td>
                                    <td className="px-4 py-3 text-ink">非 Gemini 模型(gpt-image-2 等)原样透传上游</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">prompt</td>
                                    <td className="px-4 py-3 text-ink align-top">文本</td>
                                    <td className="px-4 py-3 text-ink">必填</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">aspect_ratio</td>
                                    <td className="px-4 py-3 text-ink align-top">见白名单;auto / 空 = 不指定</td>
                                    <td className="px-4 py-3 text-ink">
                                        不在白名单 → 400;auto / 空时文生图走默认、图生图跟随输入图
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">image</td>
                                    <td className="px-4 py-3 text-ink align-top">文件(可多张)/ data URL / 外部 URL</td>
                                    <td className="px-4 py-3 text-ink">仅 /v1/images/edits;参考图</td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">response_format</td>
                                    <td className="px-4 py-3 text-ink align-top">url(默认,进图床)/ b64_json</td>
                                    <td className="px-4 py-3 text-ink">b64_json 直返 base64 内联</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <p className="m-0 mt-1 mb-2 text-xs text-minor-ink">
                        取舍:<code className="font-mono text-xs">n</code>(多图)忽略,单次出 1 张;分辨率由 model
                        档决定,形状由 <code className="font-mono text-xs">aspect_ratio</code> 决定。
                    </p>

                    {/* ─── aspect_ratio 白名单 ─── */}
                    <p className="m-0 mt-6 mb-2 text-sm font-medium text-navy">出图比例白名单</p>
                    <p className="m-0 mb-2 text-sm text-ink leading-relaxed">
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            aspect_ratio
                        </code>{' '}
                        /{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            aspectRatio
                        </code>{' '}
                        取值按模型分档(传白名单外的值 → 400):
                    </p>
                    <ul className="list-none p-0 m-0 grid grid-cols-1 gap-2 mb-2">
                        <li className="text-sm text-ink">
                            <strong className="text-navy">flash 系</strong>(2.5-flash / 3.1-flash),10 个:
                            <code className="block mt-1 font-mono text-xs bg-paper-muted px-2 py-1.5 rounded border border-brand-border text-navy">
                                21:9 · 16:9 · 4:3 · 3:2 · 5:4 · 1:1 · 4:5 · 3:4 · 2:3 · 9:16
                            </code>
                        </li>
                        <li className="text-sm text-ink">
                            <strong className="text-navy">pro 系</strong>(pro / pro-2k),13 个:上面 10 个 + 三个极端比例
                            <code className="block mt-1 font-mono text-xs bg-paper-muted px-2 py-1.5 rounded border border-brand-border text-navy">
                                1:4 · 1:8 · 8:1（超长条 / 全景）
                            </code>
                        </li>
                    </ul>

                    {/* ─── 自定义图床 OSS ─── */}
                    <p className="m-0 mt-6 mb-2 text-sm font-medium text-navy">自定义图床(OSS)</p>
                    <p className="m-0 mb-2 text-sm text-ink leading-relaxed">
                        默认生成图存平台图床(URL 形如{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            images.silkroadai.io/gen/&lt;uuid&gt;.png
                        </code>
                        ,不保证长期保留)。想让图片
                        <strong className="text-navy">直接进自己的 bucket、用自己的域名、数据归属自己</strong> → 在{' '}
                        <Link href="/settings/storage" className="text-navy font-medium hover:text-brand-accent">
                            存储设置
                        </Link>{' '}
                        配置自定义 OSS:选服务商 → 填 Bucket / AK / SK / 公网前缀 →
                        点「测试连接」(平台写入并删除一个临时文件验证读写)→ 保存即时生效,之后所有生图自动进你的 bucket。
                    </p>
                    <div className="rounded-lg overflow-hidden border border-brand-border bg-surface my-3">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        服务商
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        Endpoint 示例
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        Region
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 text-ink align-top">Cloudflare R2</td>
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top break-all">
                                        https://&lt;account_id&gt;.r2.cloudflarestorage.com
                                    </td>
                                    <td className="px-4 py-3 text-ink align-top">留空</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 text-ink align-top">阿里云 OSS</td>
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top break-all">
                                        https://oss-cn-hangzhou.aliyuncs.com
                                    </td>
                                    <td className="px-4 py-3 text-ink align-top">留空</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 text-ink align-top">腾讯云 COS</td>
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top break-all">
                                        https://cos.ap-guangzhou.myqcloud.com
                                    </td>
                                    <td className="px-4 py-3 text-ink align-top">留空</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 text-ink align-top">AWS S3</td>
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">留空</td>
                                    <td className="px-4 py-3 text-ink align-top">
                                        <strong className="text-navy">必填</strong>(如 us-east-1)
                                    </td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-3 text-ink align-top">自建 / 其他 S3 兼容</td>
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top break-all">
                                        https://minio.example.com
                                    </td>
                                    <td className="px-4 py-3 text-ink align-top">留空(自动 path-style)</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <p className="m-0 mt-1 mb-2 text-xs text-minor-ink">
                        安全:用<strong className="text-navy">子账号最小权限</strong>(只授该 bucket 的 PutObject +
                        DeleteObject),凭证在平台侧 AES-256-GCM 加密存储、保存后永不回显。OSS 出任何故障(凭证过期 /
                        bucket 删 / 网络)
                        <strong className="text-navy">不会导致生图失败</strong> —— 自动回退平台图床并在响应头加{' '}
                        <code className="font-mono text-xs">X-Silkroadai-Oss-Fallback: yes</code>。
                    </p>

                    {/* ─── FAQ ─── */}
                    <p className="m-0 mt-6 mb-2 text-sm font-medium text-navy">常见问题</p>
                    <div className="grid grid-cols-1 gap-3">
                        <div className="rounded-lg border border-brand-border bg-surface px-4 py-3 text-sm">
                            <p className="m-0 font-medium text-navy">Q:没指定比例,出来的为什么不是正方形?</p>
                            <p className="m-0 mt-1 text-ink leading-relaxed">
                                3.1-flash 和 pro 系默认出 16:9 宽幅,只有 2.5-flash 默认方图。要正方形请显式传{' '}
                                <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                    {`aspect_ratio: "1:1"`}
                                </code>
                                。
                            </p>
                        </div>
                        <div className="rounded-lg border border-brand-border bg-surface px-4 py-3 text-sm">
                            <p className="m-0 font-medium text-navy">Q:pro 的 2K 和 4K 怎么选?</p>
                            <p className="m-0 mt-1 text-ink leading-relaxed">
                                要快、要省 →{' '}
                                <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                    gemini-3-pro-image-preview-2k
                                </code>
                                (¥0.30);要最高清(印刷)→{' '}
                                <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                    gemini-3-pro-image-preview
                                </code>
                                (¥0.50,生成慢一倍)。
                            </p>
                        </div>
                        <div className="rounded-lg border border-brand-border bg-surface px-4 py-3 text-sm">
                            <p className="m-0 font-medium text-navy">Q:image_url 返回 400 image_url fetch failed?</p>
                            <p className="m-0 mt-1 text-ink leading-relaxed">
                                源站拒绝平台拉取(反盗链 / 限流)或图超 20MB。改用 data URL(把图转 base64 直接发)。
                            </p>
                        </div>
                        <div className="rounded-lg border border-brand-border bg-surface px-4 py-3 text-sm">
                            <p className="m-0 font-medium text-navy">Q:图片 URL 会一直有效吗?</p>
                            <p className="m-0 mt-1 text-ink leading-relaxed">
                                平台图床不保证永久保留,重要图请及时转存,或配置自定义 OSS 让图直接进自己的 bucket。
                            </p>
                        </div>
                    </div>
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
                        <strong className="text-navy">b64_json</strong>(Base64 PNG)。后端为
                        <strong className="text-navy"> Azure 官方 gpt-image,稳定 + 抗高并发</strong>(实测 100 并发 100%
                        成功)。
                        <strong className="text-navy"> 请用「image2官方稳定高并发」档的 API Key</strong> 调用。
                    </p>

                    <div className="mt-1 mb-3 rounded-lg border-l-4 border-brand-accent bg-paper-muted px-4 py-3 text-sm text-ink">
                        💰 <strong className="text-navy">计价:按 token 计费,¥1.3 = 官方 $1</strong> —— 按官方 gpt-image
                        的真实 token 用量结算(官方价:输入 $5 / 图像输入 $8 / 输出 $30,每百万
                        token;图生图的参考图算图像输入)。
                        <strong className="text-navy">
                            成本主要由{' '}
                            <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                                quality
                            </code>{' '}
                            决定
                        </strong>
                        (下表),尺寸(size)影响很小。
                    </div>
                    <div className="rounded-lg overflow-hidden border border-brand-border bg-surface mb-2">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        情形
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        大致输出 token
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        约 ¥ / 张
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 text-ink align-top">简单 prompt · quality 默认(auto)</td>
                                    <td className="px-4 py-3 text-ink align-top">~200–400</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">¥0.008–0.026</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 text-ink align-top">复杂 prompt · auto(自动提质)</td>
                                    <td className="px-4 py-3 text-ink align-top">~2000–4000</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">¥0.065–0.16</td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-3 text-ink align-top">quality=high(1024²)</td>
                                    <td className="px-4 py-3 text-ink align-top">~7000</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">~¥0.27</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <p className="m-0 mb-4 text-xs text-minor-ink">
                        单一模型{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            gpt-image-2
                        </code>
                        ,分辨率由{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            size
                        </code>{' '}
                        控制(最高 3840×2160);上表为估算,实际以响应 usage / 账单为准。
                    </p>

                    <p className="m-0 mb-2 text-sm font-medium text-navy">文生图 · /v1/images/generations(JSON)</p>
                    <div className="rounded-lg overflow-hidden border border-brand-border bg-surface mb-3">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        参数
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        必填
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        说明
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">model</td>
                                    <td className="px-4 py-3 text-ink align-top">✓</td>
                                    <td className="px-4 py-3 text-ink">gpt-image-2</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">prompt</td>
                                    <td className="px-4 py-3 text-ink align-top">✓</td>
                                    <td className="px-4 py-3 text-ink">图像文字描述</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">quality</td>
                                    <td className="px-4 py-3 text-ink align-top">—</td>
                                    <td className="px-4 py-3 text-ink">
                                        low / medium / high / auto(默认)——{' '}
                                        <strong className="text-navy">直接决定成本</strong>,见上表
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">size</td>
                                    <td className="px-4 py-3 text-ink align-top">—</td>
                                    <td className="px-4 py-3 text-ink">
                                        1024x1024 / 1536x1024 / 1024x1536 / auto;最高 3840x2160
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">output_format</td>
                                    <td className="px-4 py-3 text-ink align-top">—</td>
                                    <td className="px-4 py-3 text-ink">png(默认)/ jpeg(webp 暂不支持)</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">n</td>
                                    <td className="px-4 py-3 text-ink align-top">—</td>
                                    <td className="px-4 py-3 text-ink">张数,默认 1(建议 1,多张分多次更稳)</td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">response_format</td>
                                    <td className="px-4 py-3 text-ink align-top">—</td>
                                    <td className="px-4 py-3 text-ink">不用传 —— 平台自动忽略,恒返 b64_json</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/images/generations \\
  -H "Authorization: Bearer sk-你的KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "一只戴圣诞帽的橘猫,工作室灯光,高细节",
    "size": "1536x1024",
    "quality": "high"
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
                    <CodeBlock language="typescript">
                        {`import OpenAI from "openai";
import fs from "node:fs";

const client = new OpenAI({ apiKey: "sk-你的KEY", baseURL: "${OPENAI_BASE}" });

const resp = await client.images.generate({
  model: "gpt-image-2",
  prompt: "一只戴圣诞帽的橘猫,工作室灯光,高细节",
  size: "1536x1024",
});
fs.writeFileSync("out.png", Buffer.from(resp.data[0].b64_json, "base64"));`}
                    </CodeBlock>

                    <p className="m-0 mt-5 mb-2 text-sm font-medium text-navy">图生图 · /v1/images/edits(multipart)</p>
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        上传一张(或多张)参考图 + 修改要求,返回改后的图。
                    </p>
                    <div className="rounded-lg overflow-hidden border border-brand-border bg-surface mb-3">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        字段
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        必填
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        说明
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">model</td>
                                    <td className="px-4 py-3 text-ink align-top">✓</td>
                                    <td className="px-4 py-3 text-ink">gpt-image-2(或专用档)</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">prompt</td>
                                    <td className="px-4 py-3 text-ink align-top">✓</td>
                                    <td className="px-4 py-3 text-ink">修改要求</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">image</td>
                                    <td className="px-4 py-3 text-ink align-top">✓</td>
                                    <td className="px-4 py-3 text-ink">原图文件;可重复传多张参考图</td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">quality / size</td>
                                    <td className="px-4 py-3 text-ink align-top">—</td>
                                    <td className="px-4 py-3 text-ink">同文生图;response_format 不用传(恒回 b64)</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/images/edits \\
  -H "Authorization: Bearer sk-你的KEY" \\
  -F model=gpt-image-2 \\
  -F prompt="把背景换成雪景" \\
  -F image=@cat.png`}
                    </CodeBlock>
                    <CodeBlock language="python">
                        {`from openai import OpenAI
import base64

client = OpenAI(api_key="sk-你的KEY", base_url="${OPENAI_BASE}")

resp = client.images.edit(
    model="gpt-image-2",
    prompt="把背景换成雪景",
    image=open("cat.png", "rb"),
)
with open("edited.png", "wb") as f:
    f.write(base64.b64decode(resp.data[0].b64_json))`}
                    </CodeBlock>

                    <p className="m-0 mt-5 mb-2 text-sm font-medium text-navy">响应格式</p>
                    <CodeBlock language="json">
                        {`{
  "created": 1781523778,
  "data": [{ "b64_json": "iVBORw0KGgoAAAANSUhEUgAA..." }]
}`}
                    </CodeBlock>
                    <div className="mt-3 mb-3 rounded-lg border-l-4 border-brand-border bg-paper-muted px-4 py-3 text-sm text-ink">
                        🖼️ <strong className="text-navy">返回与计费</strong>:图片在{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            data[0].b64_json
                        </code>
                        (Base64 的 PNG,自行解码保存;始终返回 b64,传 response_format 也会被平台自动剥掉、仍回 b64)。
                        <strong className="text-navy">按 token 计费(¥1.3 = 官方 $1)</strong>,成本由 quality
                        主导(见上表), 响应 usage 即真实 token 用量。上游报错
                        <strong className="text-navy">原样透传</strong>(状态码 + OpenAI 错误体)。
                    </div>

                    <div className="mt-3 mb-3 rounded-lg border-l-4 border-brand-accent bg-paper-muted px-4 py-3 text-sm text-ink">
                        🔀 <strong className="text-navy">文生图 / 图生图 可合并为一个接口</strong> ——
                        不想分两条路径的话,发到{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            /v1/images/generations
                        </code>{' '}
                        或{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            /v1/images/edits
                        </code>{' '}
                        任意一个都行,平台按<strong className="text-navy">有没有带参考图</strong>自动分流:带图(multipart
                        的{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            image
                        </code>{' '}
                        字段,或 JSON 里{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            image
                        </code>{' '}
                        /{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            image_url
                        </code>{' '}
                        传 data URL)→ 走图生图;只有 prompt → 走文生图。原来的两个独立接口照常可用、行为不变。
                    </div>

                    <div className="mt-3 mb-3 rounded-lg border-l-4 border-brand-accent bg-paper-muted px-4 py-3 text-sm text-ink">
                        ⏱️ <strong className="text-navy">4K(size=3840x2160)又慢又大</strong>:单张约 7–8MB、生成最长约
                        120s。接入务必把<strong className="text-navy">超时设到 ≥ 180s</strong>{' '}
                        并对偶发断连重试一次;不强求 4K 时用默认 size 更快更省;4K 配 quality=high 的 token 成本最高。
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

                    <p className="m-0 mt-5 mb-2 text-sm font-medium text-navy">错误处理</p>
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        上游报错原样透传,HTTP 状态码即上游状态码,响应体为 OpenAI 错误格式;按非 2xx 状态码 +{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            error.message
                        </code>{' '}
                        处理。
                    </p>
                    <div className="rounded-lg overflow-hidden border border-brand-border bg-surface mb-4">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        状态码
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        含义
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        处理
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">401</td>
                                    <td className="px-4 py-3 text-ink align-top">Key 无效</td>
                                    <td className="px-4 py-3 text-ink">检查 Authorization 头</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">402</td>
                                    <td className="px-4 py-3 text-ink align-top">余额不足</td>
                                    <td className="px-4 py-3 text-ink">前往 /pay 充值</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">400</td>
                                    <td className="px-4 py-3 text-ink align-top">内容违规 / 参数错误</td>
                                    <td className="px-4 py-3 text-ink">看 error.message,调整 prompt / 参数</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">429</td>
                                    <td className="px-4 py-3 text-ink align-top">频率过高</td>
                                    <td className="px-4 py-3 text-ink">退避后重试</td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">5xx</td>
                                    <td className="px-4 py-3 text-ink align-top">上游临时故障</td>
                                    <td className="px-4 py-3 text-ink">稍后重试</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <div className="rounded-lg border-l-4 border-brand-accent bg-paper-muted px-4 py-3 text-sm text-ink">
                        📌 <strong className="text-navy">速查</strong>:文生图{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            POST /v1/images/generations
                        </code>{' '}
                        · 图生图{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            POST /v1/images/edits
                        </code>{' '}
                        · 模型 gpt-image-2(自适应,推荐)/ -1k / -2k / -4k · 返回 data[0].b64_json(PNG)· 按
                        token(¥1.3=$1)· 4K 超时 ≥180s + 重试 · Key 用 image2 分组。
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

                    {/* 用 API 查余额(2026-06 客户支援)。注意:/balance 是【网页】控制台页面;
                        脚本 / 监控要用 /v1/balance(本节),鉴权用调模型的同一个 sk- key。 */}
                    <h3 className="m-0 mt-6 mb-2 text-base font-semibold text-navy">用 API 查询余额</h3>
                    <div className="mb-4 rounded-lg border-l-4 border-brand-accent bg-paper-muted px-4 py-3 text-sm text-ink">
                        💡 想用脚本 / 监控查余额,请用下面的{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            /v1/balance
                        </code>{' '}
                        ——<strong className="text-navy">不是</strong>上面的{' '}
                        <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            /balance
                        </code>{' '}
                        网页。鉴权用你的 API Key(<code className="font-mono text-xs">sk-…</code>),和调用模型同一个。
                    </div>

                    <p className="m-0 mb-2 text-sm font-medium text-navy">① 查余额(推荐,直接返回人民币)</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/balance \\
  -H "Authorization: Bearer sk-…"`}
                    </CodeBlock>
                    <CodeBlock language="json">
                        {`{
  "object": "balance",
  "currency": "CNY",
  "balance_cny": 268.46,
  "used_cny": 951.54,
  "balance_usd": 38.35
}`}
                    </CodeBlock>
                    <p className="m-0 mt-3 mb-2 text-xs text-minor-ink leading-relaxed">
                        <code className="font-mono text-xs">balance_cny</code> = 可用余额(¥)·{' '}
                        <code className="font-mono text-xs">used_cny</code> =
                        累计消费(¥,已扣视频等失败任务的退款,与控制台「概览」一致)·{' '}
                        <code className="font-mono text-xs">balance_usd</code> = 余额折算美元。
                    </p>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">Python</p>
                    <CodeBlock language="python">
                        {`import requests

r = requests.get(
    "${OPENAI_BASE}/balance",
    headers={"Authorization": "Bearer sk-…"},
)
data = r.json()
print(f"余额 ¥{data['balance_cny']} · 已用 ¥{data['used_cny']}")`}
                    </CodeBlock>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">
                        ② OpenAI 兼容接口(给现成余额工具用,零改动)
                    </p>
                    <p className="m-0 mb-2 text-xs text-minor-ink leading-relaxed">
                        很多客户端 / 余额监控工具按 OpenAI 老接口查额度,我们也兼容。余额 ={' '}
                        <code className="font-mono text-xs">hard_limit_usd − total_usage / 100</code>(单位美元)。
                    </p>
                    <CodeBlock language="bash">
                        {`# 总额度(美元)
curl ${OPENAI_BASE}/dashboard/billing/subscription \\
  -H "Authorization: Bearer sk-…"
# → {"hard_limit_usd": 174.29, ...}

# 已用(美分)
curl ${OPENAI_BASE}/dashboard/billing/usage \\
  -H "Authorization: Bearer sk-…"
# → {"total_usage": 13593}   # = $135.93`}
                    </CodeBlock>
                    <p className="m-0 mt-3 mb-4 text-xs text-minor-ink leading-relaxed">
                        Key 无效 / 停用返 <code className="font-mono text-xs">401</code>。余额实时(约 60 秒缓存)。⚠️
                        这些是查询接口,<strong className="text-navy">不要</strong>用 GET{' '}
                        <code className="font-mono text-xs">/balance</code>(无 v1 前缀)——那是网页,会返回 HTML。
                    </p>

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
                        Seedance 2.0 <strong className="text-navy">全能视频生成</strong>(即梦 / Sora 体系)—— 文生 / 图生
                        / 多图组合 / 首帧·首尾帧 / 参考视频 / 参考音频,一个接口全包。
                        <strong className="text-navy">异步</strong>:提交拿{' '}
                        <code className="font-mono text-xs">task_id</code>,轮询到{' '}
                        <code className="font-mono text-xs">SUCCESS</code> 取视频。走{' '}
                        <code className="font-mono text-xs">/v1/video/generations</code>(不是{' '}
                        <code className="font-mono text-xs">/v1/chat/completions</code>,后者 404)。
                    </p>
                    <div className="rounded-lg border border-brand-border bg-paper-muted px-4 py-3 mb-4 text-sm text-ink leading-relaxed">
                        ⚠️ 需先在「API 密钥」页创建一把 <strong className="text-navy">「seedance逆向低价」档</strong> 的
                        key(创建密钥时在档次里选它)。该 key 专用于下列{' '}
                        <code className="font-mono text-xs">seedance-2.0-720</code> /{' '}
                        <code className="font-mono text-xs">seedance-2.0-1080</code> 模型;调别的模型请用默认档 key。
                    </div>

                    <p className="m-0 mb-2 text-sm font-medium text-navy">模型与价格(按视频秒数)</p>
                    <div className="rounded-lg overflow-hidden border border-brand-border bg-surface mb-2">
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
                                        10 秒 / 15 秒
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">
                                        seedance-2.0-720
                                    </td>
                                    <td className="px-4 py-3 text-ink align-top">720P</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">¥0.60 / 秒</td>
                                    <td className="px-4 py-3 text-ink align-top">¥6.00 / ¥9.00</td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-3 font-mono text-xs text-navy align-top">
                                        seedance-2.0-1080
                                    </td>
                                    <td className="px-4 py-3 text-ink align-top">1080P</td>
                                    <td className="px-4 py-3 text-navy align-top font-medium">¥0.72 / 秒</td>
                                    <td className="px-4 py-3 text-ink align-top">¥7.20 / ¥10.80</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <p className="m-0 mb-5 text-xs text-minor-ink">
                        按视频秒数计费;<code className="font-mono text-xs">seconds</code> 控制时长,当前支持{' '}
                        <code className="font-mono text-xs">10</code> / <code className="font-mono text-xs">15</code>
                        (字符串)。分辨率由模型名决定。
                    </p>

                    <p className="m-0 mb-2 text-sm font-medium text-navy">1) 提交任务(文生视频)</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations \\
  -H "Authorization: Bearer 你的key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "seedance-2.0-720",
    "prompt": "霓虹雨夜街头的电影感跟拍镜头,缓慢推进,35mm 颗粒",
    "aspect_ratio": "16:9",
    "seconds": "10"
  }'
# → { "task_id": "task_xxx", "object": "video", "status": "queued" }`}
                    </CodeBlock>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">2) 轮询直到完成</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations/task_xxx -H "Authorization: Bearer 你的key"
# status: in_progress … 几分钟后 "status": "completed"
# 视频直链在响应的 video_url 字段(公网 .mp4)`}
                    </CodeBlock>
                    <div className="rounded-lg border border-brand-border bg-paper-muted px-4 py-3 mt-3 text-sm text-ink leading-relaxed">
                        ⚠️ <strong className="text-navy">务必轮询到 status 变 completed / SUCCESS 再取视频</strong>。
                        生成中(<code className="font-mono text-xs">in_progress</code>)时{' '}
                        <code className="font-mono text-xs">video_url</code> 为空(或临时链),
                        <strong className="text-navy">取了也打不开</strong> —— 这是「扣钱没出片」最常见的原因。完成后{' '}
                        <code className="font-mono text-xs">video_url</code> 是我们的公网永久直链,可直接播放 / 下载。
                    </div>

                    <p className="m-0 mt-5 mb-2 text-sm font-medium text-navy">参数总表</p>
                    <div className="rounded-lg overflow-hidden border border-brand-border bg-surface mb-2">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        参数
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        必填
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        说明
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">model</td>
                                    <td className="px-4 py-2.5 text-ink">必填</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        seedance-2.0-720(720P)/ seedance-2.0-1080(1080P)
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">prompt</td>
                                    <td className="px-4 py-2.5 text-ink">必填</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        画面提示词;多素材时用 <code className="font-mono text-xs">@Image1</code> /{' '}
                                        <code className="font-mono text-xs">@Video1</code> /{' '}
                                        <code className="font-mono text-xs">@Audio1</code> 显式指代(见下)
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">aspect_ratio</td>
                                    <td className="px-4 py-2.5 text-ink">否</td>
                                    <td className="px-4 py-2.5 text-ink">16:9(默认)/ 9:16 / 1:1 / 4:3 / 3:4 / 21:9</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">seconds</td>
                                    <td className="px-4 py-2.5 text-ink">否</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        时长(字符串),<code className="font-mono text-xs">{'"10"'}</code> /{' '}
                                        <code className="font-mono text-xs">{'"15"'}</code>,默认 10
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">image_url</td>
                                    <td className="px-4 py-2.5 text-ink">否</td>
                                    <td className="px-4 py-2.5 text-ink">单张参考图(URL 或 base64 dataURL)</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">reference_image_urls</td>
                                    <td className="px-4 py-2.5 text-ink">否</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        多张参考图数组(≤9),<code className="font-mono text-xs">@ImageN</code> 对应第 N
                                        张
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">reference_videos</td>
                                    <td className="px-4 py-2.5 text-ink">否</td>
                                    <td className="px-4 py-2.5 text-ink">参考视频数组(≤3,总时长 ≤15s)</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">
                                        audio_url / reference_audios
                                    </td>
                                    <td className="px-4 py-2.5 text-ink">否</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        参考音频(≤3,mp3/wav/m4a 等),
                                        <strong className="text-navy">需同时带 ≥1 张参考图</strong>
                                    </td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">
                                        video_config.reference_mode
                                    </td>
                                    <td className="px-4 py-2.5 text-ink">否</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        auto(默认,多图参考)/ start_frame(正好 1 图=首帧)/ start_end(正好 2 图=首尾帧)
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <p className="m-0 mt-5 mb-2 text-sm font-medium text-navy">@ 引用语法(多素材必读)</p>
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        多素材组合时,模型靠 prompt 里的 @ 标记识别每个素材的角色:{' '}
                        <code className="font-mono text-xs">@Image1</code> = reference_image_urls 第 1 张、
                        <code className="font-mono text-xs">@Video1</code> = reference_videos 第 1 个、
                        <code className="font-mono text-xs">@Audio1</code> = reference_audios 第 1 个,依此类推。
                        <strong className="text-navy">不显式 @ 指代,模型会瞎猜哪张图是什么。</strong>
                    </p>

                    <p className="m-0 mt-5 mb-2 text-sm font-medium text-navy">玩法示例</p>

                    <p className="m-0 mb-2 text-sm font-medium text-navy">1) 图生视频(单图)</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations \\
  -H "Authorization: Bearer 你的key" -H "Content-Type: application/json" \\
  -d '{ "model": "seedance-2.0-720", "prompt": "@Image1 的人物开始走路,镜头跟随推进", "seconds": "10",
        "image_url": "https://你的图床/start.jpg" }'`}
                    </CodeBlock>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">2) 多图组合(角色 + 场景,@ 引用)</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations \\
  -H "Authorization: Bearer 你的key" -H "Content-Type: application/json" \\
  -d '{ "model": "seedance-2.0-1080",
        "prompt": "@Image1 的角色,在 @Image2 的场景里跳舞,宽银幕镜头",
        "aspect_ratio": "21:9", "seconds": "15",
        "reference_image_urls": ["https://你的图床/role.jpg", "https://你的图床/scene.jpg"] }'`}
                    </CodeBlock>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">3) 首帧(start_frame,正好 1 张图)</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations \\
  -H "Authorization: Bearer 你的key" -H "Content-Type: application/json" \\
  -d '{ "model": "seedance-2.0-720", "prompt": "从这个画面开始,镜头缓慢推进,人物转身", "seconds": "10",
        "image_url": "https://你的图床/start.jpg", "video_config": { "reference_mode": "start_frame" } }'`}
                    </CodeBlock>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">4) 首尾帧(start_end,正好 2 张图)</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations \\
  -H "Authorization: Bearer 你的key" -H "Content-Type: application/json" \\
  -d '{ "model": "seedance-2.0-720", "prompt": "从第一张画面平滑过渡到第二张,自然运镜", "seconds": "10",
        "reference_image_urls": ["https://你的图床/first.jpg", "https://你的图床/last.jpg"],
        "video_config": { "reference_mode": "start_end" } }'`}
                    </CodeBlock>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">
                        5) 全能参考(图 + 视频 + 音频,卡点 / 配乐)
                    </p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations \\
  -H "Authorization: Bearer 你的key" -H "Content-Type: application/json" \\
  -d '{ "model": "seedance-2.0-720",
        "prompt": "@Image1 角色随 @Audio1 的节奏起舞,运镜参考 @Video1", "seconds": "15",
        "reference_image_urls": ["https://你的图床/role.jpg"],
        "reference_videos": ["https://你的视频/camera.mp4"],
        "audio_url": "https://你的音频/track.mp3" }'`}
                    </CodeBlock>
                    <p className="m-0 mt-2 text-xs text-minor-ink">
                        用音频(<code className="font-mono text-xs">audio_url</code> /{' '}
                        <code className="font-mono text-xs">reference_audios</code>)时
                        <strong className="text-navy">必须同时带 ≥1 张参考图</strong>,否则上游报错。
                    </p>

                    <p className="m-0 mt-5 mb-2 text-sm font-medium text-navy">Python 完整示例(提交 + 轮询)</p>
                    <CodeBlock language="python">
                        {`import time, requests

BASE = "${OPENAI_BASE}/video/generations"
H = {"Authorization": "Bearer 你的key", "Content-Type": "application/json"}

task = requests.post(BASE, headers=H, json={
    "model": "seedance-2.0-720",
    "prompt": "一只橘猫在窗台上伸懒腰,慢镜头,暖色调",
    "aspect_ratio": "16:9", "seconds": "10",
}).json()
tid = task.get("task_id") or task.get("id")

def pick(d):  # 递归找视频直链
    out = None
    def w(n):
        nonlocal out
        if isinstance(n, dict):
            v = n.get("video_url")
            if isinstance(v, str) and v.startswith("http") and not out: out = v
            for x in n.values(): w(x)
        elif isinstance(n, list):
            for x in n: w(x)
    w(d); return out

for _ in range(120):  # 最多约 16 分钟
    r = requests.get(f"{BASE}/{tid}", headers=H).json()
    st = str(r.get("data", {}).get("status") or r.get("status") or "").lower()
    if st in ("completed", "success", "failed", "failure"):
        print(st, "→", pick(r)); break
    time.sleep(8)`}
                    </CodeBlock>

                    <p className="m-0 mt-5 mb-2 text-sm font-medium text-navy">常见问题</p>
                    <div className="rounded-lg overflow-hidden border border-brand-border bg-surface">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        现象
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        原因 / 解决
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 text-navy">无可用渠道 / 模型不存在</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        key 不是「seedance逆向低价」档,或模型名拼错(只有 seedance-2.0-720 / -1080)
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 text-navy">seconds 报错 / 不生效</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        必须是字符串,且只能 <code className="font-mono text-xs">{'"10"'}</code> /{' '}
                                        <code className="font-mono text-xs">{'"15"'}</code>
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 text-navy">多图但角色错乱</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        prompt 里用 @Image1 / @Image2 显式指代每张图
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 text-navy">音频报错</td>
                                    <td className="px-4 py-2.5 text-ink">用音频时必须同时带至少一张参考图</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 text-navy">视频链接过段时间失效</td>
                                    <td className="px-4 py-2.5 text-ink">临时直链,拿到尽快转存到自己存储</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 text-navy">任务很久仍生成中</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        高峰排队正常,1080P 更慢;耐心轮询,别频繁重建
                                    </td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-2.5 text-navy">偶发 5xx</td>
                                    <td className="px-4 py-2.5 text-ink">上游波动,稍后重试</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </section>

                <section id="seedance-overseas" className="mt-12 mb-10 scroll-mt-20">
                    <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4 pb-3 border-b-2 border-brand-accent">
                        <h2 className="m-0 text-2xl font-semibold text-navy">
                            <span className="text-brand-accent font-bold mr-3 tabular-nums">16</span>
                            Seedance 海外满血 · 高质量视频
                        </h2>
                    </div>
                    <p className="m-0 mb-3 text-sm text-ink leading-relaxed">
                        即梦 Seedance 2.0 <strong className="text-navy">官方满血源</strong>(质量优先,与上方普通 Seedance
                        是两套独立的源与价格)。支持
                        <strong className="text-navy">文生 / 图生 / 首尾帧 / 参考音频</strong>,异步接口(提交 →
                        轮询),按视频秒数计费。
                    </p>
                    <div className="rounded-lg border border-brand-border bg-paper-muted px-4 py-3 mb-4 text-sm text-ink leading-relaxed">
                        ⚠️ 需先在「API 密钥」页创建一把 <strong className="text-navy">「seedance海外满血」档</strong> 的
                        key(创建密钥时在档次里选它)。该 key 专用于下列{' '}
                        <code className="font-mono text-xs">dreamina-seedance-2-0-*</code> 模型;调别的模型请用默认档
                        key。
                    </div>

                    <div className="rounded-lg border border-brand-border bg-paper-muted px-4 py-3 mb-4 text-sm text-ink leading-relaxed">
                        🔊 <strong className="text-navy">视频默认带声音</strong>:Seedance 2.0 会为画面自动生成 AI 环境音
                        / 音效,<strong className="text-navy">默认开启且不额外收费</strong>。 不想要声音时传{' '}
                        <code className="font-mono text-xs">{'"generate_audio": false'}</code>
                        ;想让画面跟随你指定的音频(唱歌 / 卡点)见下方「参考音频」玩法。注意:上方
                        <strong className="text-navy">普通 Seedance</strong>
                        是另一套独立的源,是否有声以那套源为准 —— 要稳定有声请用本节的{' '}
                        <code className="font-mono text-xs">dreamina-seedance-2-0-*</code>。
                    </div>

                    <p className="m-0 mb-2 text-sm font-medium text-navy">模型与价格(按视频秒数)</p>
                    <div className="rounded-lg overflow-hidden border border-brand-border bg-surface mb-2">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        模型(文生 / 图生·首尾帧·音频用 -ref)
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        分辨率
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        文生 ¥/秒
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        带图(-ref)¥/秒
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">
                                        dreamina-seedance-2-0-480p[-ref]
                                    </td>
                                    <td className="px-4 py-2.5 text-ink">480P</td>
                                    <td className="px-4 py-2.5 text-navy">¥0.43</td>
                                    <td className="px-4 py-2.5 text-navy">¥0.27</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">
                                        dreamina-seedance-2-0-720p[-ref]
                                    </td>
                                    <td className="px-4 py-2.5 text-ink">720P</td>
                                    <td className="px-4 py-2.5 text-navy">¥0.93</td>
                                    <td className="px-4 py-2.5 text-navy">¥0.57</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">
                                        dreamina-seedance-2-0-1080p[-ref]
                                    </td>
                                    <td className="px-4 py-2.5 text-ink">1080P</td>
                                    <td className="px-4 py-2.5 text-navy">¥2.31</td>
                                    <td className="px-4 py-2.5 text-navy">¥1.41</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">
                                        dreamina-seedance-2-0-fast-480p[-ref]
                                    </td>
                                    <td className="px-4 py-2.5 text-ink">480P 快</td>
                                    <td className="px-4 py-2.5 text-navy">¥0.35</td>
                                    <td className="px-4 py-2.5 text-navy">¥0.20</td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">
                                        dreamina-seedance-2-0-fast-720p[-ref]
                                    </td>
                                    <td className="px-4 py-2.5 text-ink">720P 快</td>
                                    <td className="px-4 py-2.5 text-navy">¥0.75</td>
                                    <td className="px-4 py-2.5 text-navy">¥0.44</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <p className="m-0 mb-5 text-xs text-minor-ink">
                        纯文字用不带 <code className="font-mono text-xs">-ref</code> 的;带图 / 首尾帧 / 音频用带{' '}
                        <code className="font-mono text-xs">-ref</code> 的(更便宜)。
                        <code className="font-mono text-xs">duration</code> 控制秒数(默认 4)。
                    </p>

                    <p className="m-0 mb-2 text-sm font-medium text-navy">1) 文生视频</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations \\
  -H "Authorization: Bearer sk-你的海外满血KEY" -H "Content-Type: application/json" \\
  -d '{ "model": "dreamina-seedance-2-0-720p", "prompt": "一只橘猫在窗台伸懒腰,暖色调", "duration": 5 }'`}
                    </CodeBlock>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">2) 图生 / 参考生(-ref + image)</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations -H "Authorization: Bearer sk-你的海外满血KEY" \\
  -H "Content-Type: application/json" -d '{ "model": "dreamina-seedance-2-0-720p-ref",
  "prompt": "镜头缓缓推进,画面动起来", "duration": 5, "image": "https://你的图床/photo.jpg" }'
# image 支持 http 链接或 base64 data URL;多图用 images:[...](≤9);也兼容 image_url / reference_image_urls`}
                    </CodeBlock>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">
                        3) 首尾帧过渡(-ref + first_frame/last_frame)
                    </p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations -H "Authorization: Bearer sk-你的海外满血KEY" \\
  -H "Content-Type: application/json" -d '{ "model": "dreamina-seedance-2-0-720p-ref",
  "prompt": "从第一张平滑过渡到第二张", "duration": 5,
  "first_frame": "https://你的图床/first.jpg", "last_frame": "https://你的图床/last.jpg" }'`}
                    </CodeBlock>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">4) 参考音频(-ref + image + audio_url)</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations -H "Authorization: Bearer sk-你的海外满血KEY" \\
  -H "Content-Type: application/json" -d '{ "model": "dreamina-seedance-2-0-720p-ref",
  "prompt": "这个人随节奏唱歌", "duration": 5, "image": "https://你的图床/singer.jpg",
  "audio_url": "https://你的音频/song.mp3" }'
# 用音频时必须同时带至少一张图`}
                    </CodeBlock>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">5) 参考视频(-ref + reference_videos)</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations -H "Authorization: Bearer sk-你的海外满血KEY" \\
  -H "Content-Type: application/json" -d '{ "model": "dreamina-seedance-2-0-720p-ref",
  "prompt": "运镜参考 @Video1,把场景换成雪天", "duration": 5,
  "reference_videos": ["https://你的视频/camera.mp4"] }'
# reference_videos 数组(≤3);可与参考图同用,prompt 里 @Video1 / @Image1 指代`}
                    </CodeBlock>

                    <p className="m-0 mt-4 mb-2 text-sm font-medium text-navy">轮询取片</p>
                    <CodeBlock language="bash">
                        {`curl ${OPENAI_BASE}/video/generations/task_xxx -H "Authorization: Bearer sk-你的海外满血KEY"
# data.status=SUCCESS 后,视频在 data.data.video_url(或 result_url,等价)`}
                    </CodeBlock>
                    <p className="m-0 mt-3 text-xs text-minor-ink">
                        参考图别太小(约 256px 以下会被上游拒,用 ≥512px 稳);视频直链是临时的,拿到尽快转存。首尾帧也可用{' '}
                        <code className="font-mono text-xs">video_config.reference_mode</code> = start_frame/start_end
                        指定。参考视频用 <code className="font-mono text-xs">reference_videos</code>(数组 ≤3,单段建议
                        ≤15s),与图片同走转存,可与参考图 / 音频同用;
                        <strong className="text-navy">参考视频分辨率需 ≥480p</strong>
                        (像素 ≥409600,360p 等过小会被上游拒)。
                    </p>

                    <p className="m-0 mt-6 mb-2 text-sm font-medium text-navy">参数总表</p>
                    <div className="rounded-lg overflow-hidden border border-brand-border bg-surface mb-5">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        参数
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        适用
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        说明
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">model</td>
                                    <td className="px-4 py-2.5 text-ink">必填</td>
                                    <td className="px-4 py-2.5 text-ink">上表模型名(决定分辨率 / 计费档)</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">prompt</td>
                                    <td className="px-4 py-2.5 text-ink">必填</td>
                                    <td className="px-4 py-2.5 text-ink">画面描述</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">duration</td>
                                    <td className="px-4 py-2.5 text-ink">否</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        秒数,默认 4(价格 = 每秒价 × 秒数);同义字段 seconds
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">aspect_ratio</td>
                                    <td className="px-4 py-2.5 text-ink">否</td>
                                    <td className="px-4 py-2.5 text-ink">16:9(默认)/ 9:16 / 1:1 / 4:3 / 3:4 / 21:9</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">image / images</td>
                                    <td className="px-4 py-2.5 text-ink">-ref</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        参考图(单 / 多 ≤9);http 链接或 base64;同义字段 image_url / reference_image_urls
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">
                                        first_frame / last_frame
                                    </td>
                                    <td className="px-4 py-2.5 text-ink">-ref</td>
                                    <td className="px-4 py-2.5 text-ink">首帧 / 尾帧图(首尾帧过渡)</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">reference_videos</td>
                                    <td className="px-4 py-2.5 text-ink">-ref</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        参考视频数组(≤3,单段建议 ≤15s);http 链接或 base64
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">audio_url</td>
                                    <td className="px-4 py-2.5 text-ink">-ref</td>
                                    <td className="px-4 py-2.5 text-ink">参考音频(直链或 base64),需配 ≥1 张图</td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-2.5 font-mono text-xs text-navy">generate_audio</td>
                                    <td className="px-4 py-2.5 text-ink">全部</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        是否生成 AI 声音,<strong className="text-navy">默认 true(出声)</strong>;传{' '}
                                        <code className="font-mono text-xs">false</code> 得静音视频。不额外收费
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <p className="m-0 mb-2 text-sm font-medium text-navy">Python 完整示例(提交 + 轮询)</p>
                    <CodeBlock language="python">
                        {`import time, requests

BASE = "${OPENAI_BASE}"
KEY  = "你的 seedance海外满血 key"
H = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

# 图生(参考图);文生去掉 image、换不带 -ref 的模型即可
task = requests.post(f"{BASE}/video/generations", headers=H, json={
    "model": "dreamina-seedance-2-0-720p-ref",
    "prompt": "镜头缓缓推进,画面动起来",
    "duration": 5,
    "image": "https://你的图床/photo.jpg",
}).json()
tid = task.get("task_id") or task.get("id")

def pick(d):  # 递归找视频直链
    out = None
    def w(n):
        nonlocal out
        if isinstance(n, dict):
            v = n.get("video_url")
            if isinstance(v, str) and v.startswith("http") and not out: out = v
            for x in n.values(): w(x)
        elif isinstance(n, list):
            for x in n: w(x)
    w(d); return out

for _ in range(120):  # 最多约 10 分钟
    r = requests.get(f"{BASE}/video/generations/{tid}", headers=H).json()
    st = str(r.get("data", {}).get("status") or r.get("status") or "").upper()
    if st in ("SUCCESS", "FAILURE", "FAILED"):
        print(st, "→", pick(r) or r.get("data", {}).get("result_url")); break
    time.sleep(8)`}
                    </CodeBlock>

                    <p className="m-0 mt-5 mb-2 text-sm font-medium text-navy">常见问题</p>
                    <div className="rounded-lg overflow-hidden border border-brand-border bg-surface">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-paper-muted text-muted-ink">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        现象
                                    </th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                                        原因 / 解决
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 text-navy">无可用渠道 / 模型不存在</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        key 不是「seedance海外满血」档,或模型名拼错
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 text-navy">视频没有声音</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        本节模型默认带声音;若用的是普通{' '}
                                        <code className="font-mono text-xs">seedance-2.0</code>(另一套源)或传了{' '}
                                        <code className="font-mono text-xs">generate_audio:false</code> 会静音 —— 改用{' '}
                                        <code className="font-mono text-xs">dreamina-seedance-2-0-*</code> 且别关音频
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 text-navy">401 鉴权失败</td>
                                    <td className="px-4 py-2.5 text-ink">检查 Authorization: Bearer 头与 key</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 text-navy">参考图报 Asset provider error</td>
                                    <td className="px-4 py-2.5 text-ink">图太小(&lt;~256px),换 ≥512px</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 text-navy">-ref 模型报 requires an image</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        -ref 必须带 image / first_frame / last_frame
                                    </td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 text-navy">音频报 requires reference_image</td>
                                    <td className="px-4 py-2.5 text-ink">用音频时必须同时带至少一张图</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 text-navy">视频链接过段时间失效</td>
                                    <td className="px-4 py-2.5 text-ink">临时直链,拿到尽快转存到自己存储</td>
                                </tr>
                                <tr className="border-b border-brand-border">
                                    <td className="px-4 py-2.5 text-navy">任务很久仍生成中</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        高峰排队正常,1080P 更慢;耐心轮询,别频繁重建
                                    </td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-2.5 text-navy">偶发 5xx</td>
                                    <td className="px-4 py-2.5 text-ink">上游波动,稍后重试</td>
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
