/**
 * Route-group loading boundary for every authenticated page.
 *
 * Without this file the App Router blocks navigation until the target page's
 * server component finishes ALL its data fetches (/dashboard waits on new-api
 * cross-server calls) — clicks feel dead for seconds. With it, navigation
 * swaps instantly to this skeleton (header + sidebar persist via the layout)
 * and the real page streams in when ready. It also makes <Link> prefetch
 * meaningful for our force-dynamic routes.
 *
 * The skeleton is deliberately generic (title + stat-card grid + two content
 * blocks) so it reads as a plausible placeholder for /dashboard, /keys,
 * /logs, /chat alike — per-page loading files can specialise later.
 */

/** A pulsing placeholder block. Sized by the caller via className. */
function Bone({ className }: { className: string }) {
    return <div aria-hidden className={`animate-pulse rounded-md bg-paper-muted ${className}`} />;
}

export default function AuthenticatedLoading() {
    return (
        <section aria-busy="true" aria-label="页面加载中">
            {/* Title row (mirrors the h1 + actions strip on /dashboard) */}
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <Bone className="mb-2 h-8 w-48" />
                    <Bone className="h-4 w-72" />
                </div>
                <Bone className="h-9 w-56" />
            </div>

            {/* Stat-card grid */}
            <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
                {Array.from({ length: 5 }, (_, i) => (
                    <div key={i} className="rounded-xl border border-brand-border bg-surface p-4 shadow-card">
                        <Bone className="mb-3 h-4 w-20" />
                        <Bone className="mb-2 h-7 w-24" />
                        <Bone className="h-3 w-28" />
                    </div>
                ))}
            </div>

            {/* Two content blocks (chart / table stand-ins) */}
            <div className="mb-6 rounded-xl border border-brand-border bg-surface p-5 shadow-card">
                <Bone className="mb-4 h-5 w-32" />
                <Bone className="h-48 w-full" />
            </div>
            <div className="rounded-xl border border-brand-border bg-surface p-5 shadow-card">
                <Bone className="mb-4 h-5 w-32" />
                <div className="space-y-3">
                    {Array.from({ length: 6 }, (_, i) => (
                        <Bone key={i} className="h-9 w-full" />
                    ))}
                </div>
            </div>
        </section>
    );
}
