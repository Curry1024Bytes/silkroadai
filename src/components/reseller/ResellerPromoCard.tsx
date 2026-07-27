'use client';

/**
 * ResellerPromoCard — dashboard discovery hook (fix/reseller-entry-discovery).
 *
 * Visibility: caller (dashboard) gates rendering on
 * `reseller.status !== 'active'` (null / suspended / banned all show
 * the card; active hides it). Component itself doesn't fetch — it's
 * a pure presentation slot.
 *
 * Click → /reseller (server-side routes based on status: null → join page,
 * suspended/banned → status page) + fires
 * `reseller_promo_card_clicked` analytics event so we can measure
 * conversion from dashboard impression → join.
 *
 * Style: paper-aligned Card matching W6 D5 dashboard "real cards"
 * (rounded-xl, brand-border, shadow-card). One headline + one body line
 * + one CTA. Deliberately compact to sit at the dashboard tail without
 * competing for attention with the 4 data cards.
 */
import Link from 'next/link';
import { ArrowUpRight, UsersRound } from 'lucide-react';

function fireAnalytics(eventType: string, properties: Record<string, unknown> = {}): void {
    void fetch('/api/portal/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: eventType, properties }),
        credentials: 'same-origin',
    }).catch(() => {
        /* best-effort */
    });
}

interface Props {
    /** Forwarded to the analytics event so we can segment conversion by
     *  source state (null = never-joined, suspended/banned = was-joined). */
    sourceStatus: 'none' | 'suspended' | 'banned';
}

export function ResellerPromoCard({ sourceStatus }: Props) {
    return (
        <aside className="flex flex-col gap-4 rounded-lg border border-portal-line bg-portal-panel p-5 shadow-portal sm:flex-row sm:items-center sm:p-6">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-portal-gold-soft text-portal-gold">
                <UsersRound size={19} strokeWidth={1.8} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
                <p className="m-0 font-display text-base font-semibold text-portal-ink">邀请朋友充值,你也赚佣金</p>
                <p className="m-0 mt-1 text-sm leading-relaxed text-portal-muted">
                    阶梯佣金 <strong className="text-navy">10% / 15% / 20%</strong>,归因期{' '}
                    <strong className="text-navy">24 个月</strong>,月结打款。最低门槛,代理人人可申请。
                </p>
            </div>
            <Link
                href="/reseller"
                onClick={() => fireAnalytics('reseller_promo_card_clicked', { source: sourceStatus })}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-portal-line bg-portal-panel px-4 text-sm font-semibold text-portal-ink no-underline transition-colors hover:bg-portal-soft"
            >
                了解代理计划 <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
        </aside>
    );
}
