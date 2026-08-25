'use client';

/**
 * Global footer.
 *
 * Renders at the bottom of every page via the root layout. Uses the W7
 * design system (paper-muted surface, brand-border top separator,
 * tokens-only colors). Slim — fits on one row at desktop, wraps on mobile.
 *
 * The resource links follow the current surface: public pages keep their
 * canonical URLs, while customer-console pages stay inside the authenticated
 * workspace shell.
 *
 * Asset note: brief (W7 P3) reads "footer paper.muted 底色 · 反白 logo".
 * paper-muted is a light neutral-green (#EEF3F1); the asset library's
 * "inverse" variant is white-on-dark and would render invisibly on it.
 * `primary-flat` is the asset cheat-sheet's recommended pick for light
 * backgrounds < 48px tall — keeping the brand gradient + ensuring the
 * wordmark is actually visible. If the operator wants a literal graphite
 * footer with inverse logo, this is one prop swap (paper-muted →
 * dark footer, this is one token/variant swap.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Logo } from '@/components/brand/Logo';
import {
    BRAND_NAME,
    BRAND_TAGLINE,
    NEW_API_MODIFIED_SOURCE_URL,
    SUPPORT_EMAIL,
    SUPPORT_WECHAT,
} from '@/lib/public-config';

const CUSTOMER_WORKSPACE_ROOTS = [
    '/balance',
    '/chat',
    '/dashboard',
    '/image',
    '/keys',
    '/logs',
    '/reseller',
    '/settings',
    '/tools',
    '/usage',
    '/workspace',
] as const;

export function isCustomerWorkspacePath(pathname: string): boolean {
    return CUSTOMER_WORKSPACE_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

export function Footer() {
    const pathname = usePathname();
    const useWorkspaceLinks = isCustomerWorkspacePath(pathname);
    const year = new Date().getFullYear();
    if (useWorkspaceLinks) return null;

    return (
        <footer className="border-t border-brand-border bg-paper px-5 text-xs text-muted-ink sm:px-7">
            <div className="mx-auto w-full max-w-[1200px]">
                <div className="flex flex-col gap-5 py-6 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-3">
                        <Logo variant="primary-flat" size={22} />
                        <span className="text-minor-ink">{BRAND_TAGLINE}</span>
                    </div>

                    <nav className="flex flex-wrap items-center gap-x-5 gap-y-3" aria-label="页脚导航">
                        <Link href="/models" className="no-underline transition-colors hover:text-navy">
                            模型清单
                        </Link>
                        <Link href="/docs" className="no-underline transition-colors hover:text-navy">
                            文档
                        </Link>
                        <Link href="/terms" className="no-underline transition-colors hover:text-navy">
                            服务条款
                        </Link>
                        <Link href="/privacy" className="no-underline transition-colors hover:text-navy">
                            隐私政策
                        </Link>
                        <Link href="/refund" className="no-underline transition-colors hover:text-navy">
                            退款政策
                        </Link>
                        <a
                            href={NEW_API_MODIFIED_SOURCE_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="no-underline transition-colors hover:text-navy"
                        >
                            修改版源码
                        </a>
                    </nav>
                </div>

                <div className="flex flex-col gap-3 border-t border-brand-border py-4 text-minor-ink sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <span>
                            微信 <code className="font-mono text-xs text-muted-ink">{SUPPORT_WECHAT}</code>
                        </span>
                        <a
                            href={`mailto:${SUPPORT_EMAIL}`}
                            className="text-muted-ink no-underline transition-colors hover:text-brand-accent"
                        >
                            {SUPPORT_EMAIL}
                        </a>
                    </div>
                    <span>
                        © {year} {BRAND_NAME}
                    </span>
                </div>
            </div>
        </footer>
    );
}
