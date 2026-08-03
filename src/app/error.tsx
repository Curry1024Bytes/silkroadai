'use client';

/**
 * Custom server-error boundary — replaces Next's default error overlay
 * for any uncaught exception in any route segment.
 *
 * Why 'use client': Next.js mandates that `error.tsx` is a client
 * component because the framework hands it an `error` prop + a `reset`
 * callback the user can fire to retry. The directive is required by
 * the App Router contract, NOT something we add for interactivity —
 * this component intentionally contains zero hooks, zero handlers,
 * zero fetches. Server renders the markup; the only "client" code is
 * the React reconciler attaching to the static tree.
 *
 * The brief calls for "no client JS" — this is the strictest form
 * possible given Next's requirement: pure static markup behind a
 * mandated 'use client' directive.
 *
 * Tone: neutral. We tell the user what happened ("服务暂不可用"), what
 * we already did ("我们已收到错误"), and what to do next ("稍后重试")
 * — no jokes, no apologies. Brief: "中性不人格化".
 *
 * Note on Sentry: the W5 D4 Sentry SDK auto-captures exceptions through
 * Next's instrumentation hooks. We don't need to manually
 * `Sentry.captureException(error)` here — that would double-report.
 */
import { Logo } from '@/components/brand/Logo';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SUPPORT_WECHAT } from '@/lib/public-config';

export default function ErrorBoundary({ error }: { error: Error & { digest?: string }; reset: () => void }) {
    // `digest` is Next's server-side error fingerprint, useful for ops
    // to grep logs. Show it small + monospace so a customer who pings
    // support can paste it. Won't leak secrets — Next strips messages
    // from prod boundaries, only the digest reaches us here.
    const digest = error?.digest;
    return (
        <main className="min-h-[70vh] flex items-center justify-center bg-paper px-4 py-12">
            <Card className="w-full max-w-md p-8 text-center">
                <div className="flex justify-center mb-5">
                    <Logo variant="primary-flat" size={32} />
                </div>
                <p
                    className="m-0 mb-3 text-brand-accent font-semibold tabular-nums"
                    aria-hidden="true"
                    style={{ fontSize: 36, letterSpacing: 0 }}
                >
                    500
                </p>
                <h1 className="m-0 mb-2 text-xl font-semibold text-navy">服务暂不可用</h1>
                <p className="m-0 mb-6 text-sm text-muted-ink leading-relaxed">我们已收到错误,请稍后重试。</p>
                <div className="flex flex-col sm:flex-row gap-2 justify-center">
                    <Button href="/" variant="primary" size="md">
                        返回首页
                    </Button>
                    <Button href="/dashboard" variant="secondary" size="md">
                        进入控制台
                    </Button>
                </div>
                {digest ? (
                    <p className="m-0 mt-5 text-xs text-minor-ink">
                        错误编号:{' '}
                        <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                            {digest}
                        </code>
                    </p>
                ) : null}
                <p className="m-0 mt-4 text-xs text-minor-ink">
                    需要帮助?微信{' '}
                    <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                        {SUPPORT_WECHAT}
                    </code>{' '}
                    · 邮箱{' '}
                    <a href="mailto:support@llmroute.club" className="text-navy no-underline hover:text-brand-accent">
                        support@llmroute.club
                    </a>
                </p>
            </Card>
        </main>
    );
}
