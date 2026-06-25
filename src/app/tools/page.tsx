import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
    title: '工具箱 · Silk Road AI',
    description:
        'Silk Road AI 工具箱 —— Seedance 视频 / AI 对话 / AI 生图 在线测试工具,以及 OpenAI Codex / Claude Code 接入。',
};

type Tool = { icon: string; tag: string; title: string; desc: string; href: string; cta: string };

const TOOLS: Tool[] = [
    {
        icon: '🎬',
        tag: '在线工具',
        title: 'Seedance 视频测试工具',
        desc: '填入你的 API Key,在线生成 Seedance 视频 —— 全部模型、全部玩法(文生 / 图生 / 首尾帧 / 参考音频),无需写代码。',
        href: '/tools/seedance',
        cta: '立即使用',
    },
    {
        icon: '💬',
        tag: '在线工具',
        title: 'AI 对话测试工具',
        desc: '填入你的 API Key,在线测试 AI 对话(逐字流式)—— 覆盖你这把 key 能用的全部对话模型(GPT / Claude / Gemini / DeepSeek 等)。',
        href: '/tools/chat',
        cta: '立即使用',
    },
    {
        icon: '🎨',
        tag: '在线工具',
        title: 'AI 生图测试工具',
        desc: '填入你的 API Key,在线测试文生图 / 图生图 —— 覆盖你这把 key 能用的全部生图模型(Gemini / GPT Image 等)。',
        href: '/tools/image',
        cta: '立即使用',
    },
    {
        icon: '⌨️',
        tag: '下载安装',
        title: 'OpenAI Codex 接入',
        desc: 'Codex CLI / IDE 插件 / 桌面版接入 Silk Road AI,一份配置直连 ChatGPT,人民币计费。',
        href: '/docs#codex-cli',
        cta: '下载 & 接入',
    },
    {
        icon: '🤖',
        tag: '下载安装',
        title: 'Claude Code 接入',
        desc: 'Claude Code 桌面 / CLI 接入 Silk Road AI,配好 Base URL + Key 即用 Claude,人民币计费。',
        href: '/docs#claude-code',
        cta: '下载 & 接入',
    },
];

export default function ToolsIndexPage() {
    return (
        <main className="min-h-screen bg-paper text-ink">
            <div className="mx-auto max-w-4xl px-5 py-8">
                <Link href="/" className="text-sm text-brand-accent hover:underline">
                    ← 返回首页
                </Link>
                <h1 className="m-0 mt-4 mb-1 text-2xl font-semibold text-navy">工具箱</h1>
                <p className="m-0 mb-6 text-sm text-muted-ink leading-relaxed">
                    在线测试工具与接入指引,后续会持续加入更多工具。
                </p>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {TOOLS.map((t) => (
                        <Link
                            key={t.href}
                            href={t.href}
                            className="group flex flex-col rounded-xl border border-brand-border bg-surface p-5 transition-colors hover:border-brand-accent"
                        >
                            <div className="mb-2 flex items-center gap-2">
                                <span className="text-2xl leading-none">{t.icon}</span>
                                <span className="rounded-full border border-brand-border px-2 py-0.5 text-xs text-minor-ink">
                                    {t.tag}
                                </span>
                            </div>
                            <h2 className="m-0 mb-1 text-base font-semibold text-navy">{t.title}</h2>
                            <p className="m-0 mb-4 flex-1 text-sm text-muted-ink leading-relaxed">{t.desc}</p>
                            <span className="text-sm font-medium text-brand-accent group-hover:underline">
                                {t.cta} →
                            </span>
                        </Link>
                    ))}
                </div>
            </div>
        </main>
    );
}
