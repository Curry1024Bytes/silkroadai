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

const BASE_NAV: NavItem[] = [
    // 客户控制台三合一: 概览 now IS the merged console — 余额 + 用量 + 每次调用
    // 明细 all live on /dashboard. Old /balance + /usage routes 307-redirect
    // here, so the two former nav rows collapsed into this one.
    { href: '/dashboard', label: '概览' },
    // 全功能调用日志:按日期范围 + Request ID / 令牌 / 模型 / 渠道 搜索,分页展示(已去重复失败)。
    { href: '/logs', label: '调用日志' },
    { href: '/keys', label: 'API Keys' },
    // 工具箱: 独立页 /tools(Seedance 视频 / AI 对话 / AI 生图 在线测试 + Codex / Claude Code
    // 接入),不跳落地页。放在 API Keys 之后。控制台的 AI 对话 / AI 生图 入口已下线,统一收敛
    // 到工具箱(/chat /image 页面仍在,只是不再挂导航)。
    { href: '/tools', label: '工具箱' },
    // W9 D3 PR-C: 客户自定义 OSS(生图输出存储)配置入口。
    { href: '/settings/storage', label: '存储设置' },
    { href: '/models', label: '模型清单' },
    // W7 D4 PR-G: public integration docs (Cursor / Cline / Continue /
    // Claude Code Desktop / Python + Node SDK).
    { href: '/docs', label: '文档' },
    // W7 PR-P: GPU rental landing — H100 / H200 / B300.
    { href: '/gpu', label: 'GPU 租赁' },
];

interface SidebarProps {
    /** PR-U2 + fix/reseller-entry-discovery: the reseller entry is ALWAYS
     *  visible (CTA discoverability — operator decided non-resellers should
     *  see the "邀请赚佣金" entry to find the program). Label shifts based
     *  on status:
     *    null/undefined → "邀请赚佣金" (new-user CTA)
     *    'active'       → "代理后台"
     *    'suspended' / 'banned' → "代理后台" (greyed)
     *  Same href "/reseller" in all cases; the page server-side routes
     *  active → /reseller/dashboard, others → status-appropriate view.
     *  Computed server-side in layout.tsx via fetchResellerStatus. */
    resellerStatus?: 'active' | 'suspended' | 'banned' | null;
}

function resellerNavLabel(status: SidebarProps['resellerStatus']): string {
    if (status === 'active') return '代理后台';
    if (status === 'suspended' || status === 'banned') return '代理后台';
    return '邀请赚佣金'; // null / undefined → never-joined CTA
}

export function Sidebar({ resellerStatus = null }: SidebarProps) {
    const pathname = usePathname();
    // Build the final nav list — always inject the reseller entry just
    // before /gpu (customer-facing tools group together, reseller entry
    // sits at the end of the customer rows whether they've joined or not).
    const nav: NavItem[] = [
        ...BASE_NAV.slice(0, -1),
        { href: '/reseller', label: resellerNavLabel(resellerStatus) },
        BASE_NAV[BASE_NAV.length - 1],
    ];
    // Suspended / banned resellers get a muted entry — their click still
    // routes to /reseller, which server-side renders the status page.
    const resellerMuted = resellerStatus === 'suspended' || resellerStatus === 'banned';

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
                {nav.map((item) => {
                    const active = pathname === item.href;
                    const muted = item.href === '/reseller' && resellerMuted;
                    return (
                        <li key={item.href}>
                            <Link
                                href={item.href}
                                aria-current={active ? 'page' : undefined}
                                data-status={item.href === '/reseller' ? (resellerStatus ?? 'none') : undefined}
                                className={[
                                    'block whitespace-nowrap text-sm no-underline',
                                    'px-4 md:px-5 py-2 md:py-2.5',
                                    'transition-colors duration-150 ease-brand',
                                    'border-l-[3px] border-transparent',
                                    active
                                        ? 'text-navy font-semibold bg-paper-muted md:border-l-brand-accent'
                                        : muted
                                          ? 'text-minor-ink/70 hover:text-minor-ink hover:bg-paper-muted/40'
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
