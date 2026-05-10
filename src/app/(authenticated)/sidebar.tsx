'use client';

/**
 * Authenticated nav. Desktop ≥ 768px: vertical 200px panel on the left.
 * Mobile <768px: horizontal scrollable strip below the header (the
 * authenticated layout flips to flex-col on mobile, so this nav lives in
 * the sidebar slot but visually renders horizontally).
 *
 * Active item gets a brand-accent left-border (desktop) or bottom-border
 * (mobile) plus a paper-muted background. Other items are quiet, with a
 * brand-accent text shift on hover.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface NavItem {
    href: string;
    label: string;
}

const NAV: NavItem[] = [
    { href: '/dashboard', label: '概览' },
    // PR-T2: image generation lives in the second-position slot per
    // operator brief — surfaces the headline customer-visible feature
    // right under the dashboard hub.
    { href: '/image', label: 'AI 生图' },
    { href: '/keys', label: 'API Keys' },
    { href: '/balance', label: '余额' },
    { href: '/usage', label: '用量' },
    { href: '/models', label: '模型清单' },
    // W7 D4 PR-G: public integration docs (Cursor / Cline / Continue /
    // Claude Code Desktop / Python + Node SDK).
    { href: '/docs', label: '文档' },
    // W7 PR-P: GPU rental landing — H100 / H200 / B300.
    { href: '/gpu', label: 'GPU 租赁' },
];

export function Sidebar() {
    const pathname = usePathname();

    return (
        <nav
            className={[
                // Mobile: horizontal scroll strip under the header.
                'border-b border-brand-border bg-surface overflow-x-auto',
                // Desktop: vertical panel.
                'md:w-[200px] md:min-w-[200px] md:border-b-0 md:border-r md:overflow-x-visible',
                'md:flex md:flex-col md:justify-between',
                'py-2 md:py-4',
            ].join(' ')}
            aria-label="客户后台导航"
        >
            <ul className={['list-none p-0 m-0 flex flex-row md:flex-col gap-0.5 px-2 md:px-0'].join(' ')}>
                {NAV.map((item) => {
                    const active = pathname === item.href;
                    return (
                        <li key={item.href}>
                            <Link
                                href={item.href}
                                aria-current={active ? 'page' : undefined}
                                className={[
                                    'block whitespace-nowrap text-sm no-underline',
                                    'px-4 md:px-5 py-2 md:py-2.5',
                                    'transition-colors duration-150 ease-brand',
                                    'border-l-[3px] border-transparent',
                                    active
                                        ? 'text-navy font-semibold bg-paper-muted md:border-l-brand-accent'
                                        : 'text-muted-ink hover:text-navy hover:bg-paper-muted/60',
                                    // Mobile uses a bottom-border affordance instead of left.
                                    active
                                        ? 'border-b-2 md:border-b-0 border-b-brand-accent md:border-b-transparent'
                                        : 'border-b-2 border-b-transparent',
                                ].join(' ')}
                            >
                                {item.label}
                            </Link>
                        </li>
                    );
                })}
            </ul>

            <div className="hidden md:block px-4 pb-2">
                <Link
                    href="/pay"
                    className={[
                        'block text-center px-4 py-2.5 text-sm font-medium no-underline',
                        'rounded-lg bg-navy text-paper hover:bg-navy-strong',
                        'transition-colors duration-150 ease-brand',
                    ].join(' ')}
                >
                    + 充值
                </Link>
            </div>
        </nav>
    );
}
