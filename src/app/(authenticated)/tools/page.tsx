import type { Metadata } from 'next';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
    ArrowUpRight,
    Bot,
    Clapperboard,
    Code2,
    Image as ImageIcon,
    MessageSquareText,
    TerminalSquare,
    Wrench,
} from 'lucide-react';

export const metadata: Metadata = {
    title: '工具箱 · LLmRoute',
    description:
        'LLmRoute 工具箱 —— Seedance 视频 / AI 对话 / AI 生图在线测试工具，以及 OpenAI Codex / Claude Code 接入。',
};

interface ToolItem {
    icon: LucideIcon;
    title: string;
    description: string;
    href: string;
    action: string;
}

const ONLINE_TOOLS: ToolItem[] = [
    {
        icon: Clapperboard,
        title: 'Seedance 视频测试',
        description: '在线生成 Seedance 视频，支持文生视频、图生视频、首尾帧与参考音频等完整工作流。',
        href: '/tools/seedance',
        action: '打开视频工具',
    },
    {
        icon: MessageSquareText,
        title: 'AI 对话测试',
        description: '使用 API Key 测试逐字流式对话，覆盖 GPT、Claude、Gemini 与 DeepSeek 等模型。',
        href: '/tools/chat',
        action: '打开对话工具',
    },
    {
        icon: ImageIcon,
        title: 'AI 生图测试',
        description: '测试文生图与图生图能力，快速验证 Gemini、GPT Image 等视觉模型的实际效果。',
        href: '/tools/image',
        action: '打开生图工具',
    },
];

const INTEGRATIONS: ToolItem[] = [
    {
        icon: TerminalSquare,
        title: 'OpenAI Codex 接入',
        description: '配置 Codex CLI、IDE 插件与桌面版，通过 LLmRoute 使用 ChatGPT 系模型。',
        href: '/workspace/docs#codex-cli',
        action: '查看接入指南',
    },
    {
        icon: Bot,
        title: 'Claude Code 接入',
        description: '配置 Base URL 与 API Key，在 Claude Code 桌面版或 CLI 中使用 Claude 模型。',
        href: '/workspace/docs#claude-code',
        action: '查看接入指南',
    },
];

export default function ToolsIndexPage() {
    return (
        <section className="space-y-8">
            <div>
                <p className="m-0 mb-1 text-xs font-semibold text-portal-gold">TOOLKIT</p>
                <h1 className="m-0 text-[28px] font-semibold leading-tight text-portal-ink">工具箱</h1>
                <p className="m-0 mt-2 max-w-3xl text-sm leading-relaxed text-portal-muted">
                    在线验证模型能力，或将常用开发工具接入 LLmRoute。
                </p>
            </div>

            <section aria-labelledby="online-tools-heading">
                <div className="mb-3 flex items-center gap-2">
                    <Wrench size={18} className="text-portal-gold" strokeWidth={1.8} aria-hidden="true" />
                    <div>
                        <h2 id="online-tools-heading" className="m-0 text-base font-semibold text-portal-ink">
                            在线工具
                        </h2>
                        <p className="m-0 mt-0.5 text-xs text-portal-subtle">无需本地配置，直接验证 API 能力</p>
                    </div>
                </div>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                    {ONLINE_TOOLS.map((tool) => {
                        const Icon = tool.icon;
                        return (
                            <Link
                                key={tool.href}
                                href={tool.href}
                                className="group flex min-h-[220px] min-w-0 flex-col rounded-lg border border-portal-line bg-portal-panel p-5 no-underline shadow-portal transition-colors hover:border-portal-gold/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/20"
                            >
                                <div className="flex items-start justify-between gap-4">
                                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-portal-gold-soft text-portal-gold">
                                        <Icon size={20} strokeWidth={1.7} aria-hidden="true" />
                                    </span>
                                    <ArrowUpRight
                                        size={17}
                                        className="text-portal-subtle transition-colors group-hover:text-portal-ink"
                                        strokeWidth={1.7}
                                        aria-hidden="true"
                                    />
                                </div>
                                <h3 className="m-0 mt-5 text-base font-semibold text-portal-ink">{tool.title}</h3>
                                <p className="m-0 mt-2 flex-1 text-sm leading-relaxed text-portal-muted">
                                    {tool.description}
                                </p>
                                <span className="mt-5 inline-flex items-center gap-1 text-xs font-semibold text-portal-ink">
                                    {tool.action}
                                    <ArrowUpRight size={13} aria-hidden="true" />
                                </span>
                            </Link>
                        );
                    })}
                </div>
            </section>

            <section aria-labelledby="integrations-heading">
                <div className="mb-3 flex items-center gap-2">
                    <Code2 size={18} className="text-portal-gold" strokeWidth={1.8} aria-hidden="true" />
                    <div>
                        <h2 id="integrations-heading" className="m-0 text-base font-semibold text-portal-ink">
                            开发工具接入
                        </h2>
                        <p className="m-0 mt-0.5 text-xs text-portal-subtle">CLI、IDE 与桌面客户端配置指南</p>
                    </div>
                </div>

                <div className="overflow-hidden rounded-lg border border-portal-line bg-portal-panel shadow-portal">
                    {INTEGRATIONS.map((tool, index) => {
                        const Icon = tool.icon;
                        return (
                            <Link
                                key={tool.href}
                                href={tool.href}
                                className={[
                                    'group flex min-w-0 items-start gap-4 px-4 py-4 no-underline transition-colors hover:bg-portal-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-navy/20 sm:items-center sm:px-5',
                                    index > 0 ? 'border-t border-portal-line' : '',
                                ].join(' ')}
                            >
                                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-portal-soft text-portal-muted">
                                    <Icon size={19} strokeWidth={1.7} aria-hidden="true" />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <h3 className="m-0 text-sm font-semibold text-portal-ink">{tool.title}</h3>
                                    <p className="m-0 mt-1 text-xs leading-relaxed text-portal-muted sm:text-sm">
                                        {tool.description}
                                    </p>
                                </div>
                                <span className="hidden shrink-0 items-center gap-1 text-xs font-semibold text-portal-muted transition-colors group-hover:text-portal-ink sm:inline-flex">
                                    {tool.action}
                                    <ArrowUpRight size={13} aria-hidden="true" />
                                </span>
                            </Link>
                        );
                    })}
                </div>
            </section>
        </section>
    );
}
