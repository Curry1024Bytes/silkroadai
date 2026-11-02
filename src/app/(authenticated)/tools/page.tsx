import { getLocale } from '@/lib/i18n/server';
import { pickMessages } from '@/lib/i18n';
import { toolsMessages } from '@/lib/i18n/messages/tools';
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

export async function generateMetadata(): Promise<Metadata> { const m = pickMessages(toolsMessages, await getLocale()).index; return { title: m.metaTitle, description: m.metaDescription }; }

interface ToolItem {
    icon: LucideIcon;
    title: string;
    description: string;
    href: string;
    action: string;
}

export default async function ToolsIndexPage() {
    const m = pickMessages(toolsMessages, await getLocale()).index;
const ONLINE_TOOLS: ToolItem[] = [
    {
        icon: Clapperboard,
        title: m.seedance.title,
        description: m.seedance.description,
        href: '/tools/seedance',
        action: m.seedance.action,
    },
    {
        icon: MessageSquareText,
        title: m.chat.title,
        description: m.chat.description,
        href: '/tools/chat',
        action: m.chat.action,
    },
    {
        icon: ImageIcon,
        title: m.image.title,
        description: m.image.description,
        href: '/tools/image',
        action: m.image.action,
    },
];

const INTEGRATIONS: ToolItem[] = [
    {
        icon: TerminalSquare,
        title: m.codex.title,
        description: m.codex.description,
        href: '/workspace/docs#codex-cli',
        action: m.viewGuide,
    },
    {
        icon: Bot,
        title: m.claudeCode.title,
        description: m.claudeCode.description,
        href: '/workspace/docs#claude-code',
        action: m.viewGuide,
    },
];


    return (
        <section className="space-y-8">
            <div>
                <p className="m-0 mb-1 text-xs font-semibold text-portal-gold">TOOLKIT</p>
                <h1 className="m-0 text-[28px] font-semibold leading-tight text-portal-ink">{m.title}</h1>
                <p className="m-0 mt-2 max-w-3xl text-sm leading-relaxed text-portal-muted">
                    {m.intro}
                </p>
            </div>

            <section aria-labelledby="online-tools-heading">
                <div className="mb-3 flex items-center gap-2">
                    <Wrench size={18} className="text-portal-gold" strokeWidth={1.8} aria-hidden="true" />
                    <div>
                        <h2 id="online-tools-heading" className="m-0 text-base font-semibold text-portal-ink">
                            {m.onlineHeading}
                        </h2>
                        <p className="m-0 mt-0.5 text-xs text-portal-subtle">{m.onlineHint}</p>
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
                            {m.integrationsHeading}
                        </h2>
                        <p className="m-0 mt-0.5 text-xs text-portal-subtle">{m.integrationsHint}</p>
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
