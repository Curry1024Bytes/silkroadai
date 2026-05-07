/**
 * Global footer.
 *
 * Renders at the bottom of every page via the root layout. Uses the W7
 * design system (paper-muted surface, brand-border top separator,
 * tokens-only colors). Slim — fits on one row at desktop, wraps on mobile.
 *
 * Server component: pure markup, no interactivity. Picks up the current
 * year at render time.
 *
 * Asset note: brief (W7 P3) reads "footer paper.muted 底色 · 反白 logo".
 * paper-muted is a light warm-amber (#F3EDE1); the asset library's
 * "inverse" variant is white-on-dark and would render invisibly on it.
 * `primary-flat` is the asset cheat-sheet's recommended pick for light
 * backgrounds < 48px tall — keeping the brand gradient + ensuring the
 * wordmark is actually visible. If the operator wants a literal navy
 * footer with inverse logo, this is one prop swap (paper-muted →
 * navy-strong + primary-flat → inverse).
 */
import Link from 'next/link';
import { Logo } from '@/components/brand/Logo';

export function Footer() {
    const year = new Date().getFullYear();
    return (
        <footer
            className={[
                'bg-paper-muted border-t border-brand-border',
                'px-6 py-4 text-xs text-muted-ink',
                'flex flex-row flex-wrap items-center justify-between gap-4',
            ].join(' ')}
        >
            <div className="flex items-center gap-3">
                <Logo variant="primary-flat" size={24} />
                <span className="hidden sm:inline text-minor-ink">
                    Connecting Global Intelligence.
                </span>
            </div>

            <nav className="flex items-center gap-4 flex-wrap" aria-label="页脚导航">
                <Link
                    href="/models"
                    className="text-muted-ink hover:text-navy no-underline transition-colors duration-150 ease-brand"
                >
                    模型清单
                </Link>
                <Link
                    href="/docs"
                    className="text-muted-ink hover:text-navy no-underline transition-colors duration-150 ease-brand"
                >
                    文档
                </Link>
                <Link
                    href="/terms"
                    className="text-muted-ink hover:text-navy no-underline transition-colors duration-150 ease-brand"
                >
                    服务条款
                </Link>
                <Link
                    href="/privacy"
                    className="text-muted-ink hover:text-navy no-underline transition-colors duration-150 ease-brand"
                >
                    隐私政策
                </Link>
                <Link
                    href="/refund"
                    className="text-muted-ink hover:text-navy no-underline transition-colors duration-150 ease-brand"
                >
                    退款政策
                </Link>
            </nav>

            <div className="flex items-center gap-4 flex-wrap">
                <span>
                    客服:微信{' '}
                    <code className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-brand-border text-navy">
                        Global_Ads
                    </code>
                </span>
                <a
                    href="mailto:support@silkroadai.io"
                    className="text-navy no-underline border-b border-dotted border-navy hover:text-brand-accent hover:border-brand-accent transition-colors duration-150 ease-brand"
                >
                    support@silkroadai.io
                </a>
                <span className="text-minor-ink">© {year} Silk Road AI</span>
            </div>
        </footer>
    );
}
