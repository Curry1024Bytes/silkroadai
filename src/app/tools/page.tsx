import Link from 'next/link';
import { BackButton } from '@/components/BackButton';
import { getLocale } from '@/lib/i18n/server';
import { pickMessages } from '@/lib/i18n';
import { toolsMessages } from '@/lib/i18n/messages/tools';

export async function generateMetadata() {
    const m = pickMessages(toolsMessages, await getLocale());
    return { title: m.index.metaTitle, description: m.index.metaDescription };
}

type ToolsIndexMessages = (typeof toolsMessages)['zh']['index'];
type Tool = { icon: string; tag: string; title: string; desc: string; href: string; cta: string };

function buildTools(m: ToolsIndexMessages): Tool[] {
    return [
        { icon: '🎬', tag: m.tagOnline, ...m.seedance, href: '/tools/seedance', cta: m.useNow },
        { icon: '💬', tag: m.tagOnline, ...m.chat, href: '/tools/chat', cta: m.useNow },
        { icon: '🎨', tag: m.tagOnline, ...m.image, href: '/tools/image', cta: m.useNow },
        { icon: '⌨️', tag: m.tagDownload, ...m.codex, href: '/docs#codex-cli', cta: m.downloadConnect },
        { icon: '🤖', tag: m.tagDownload, ...m.claudeCode, href: '/docs#claude-code', cta: m.downloadConnect },
    ];
}

export default async function ToolsIndexPage() {
    const m = pickMessages(toolsMessages, await getLocale());
    const tools = buildTools(m.index);
    return (
        <main className="min-h-screen bg-paper text-ink">
            <div className="mx-auto max-w-4xl px-5 py-8">
                <BackButton className="text-sm text-brand-accent hover:underline cursor-pointer border-0 bg-transparent p-0">
                    {m.shared.back}
                </BackButton>
                <h1 className="m-0 mt-4 mb-1 text-2xl font-semibold text-navy">{m.index.title}</h1>
                <p className="m-0 mb-6 text-sm text-muted-ink leading-relaxed">{m.index.intro}</p>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {tools.map((t) => (
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
