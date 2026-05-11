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
import { Card, CardContent } from '@/components/ui/Card';

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
        <Card as="aside" className="mt-2">
            <CardContent className="flex flex-col sm:flex-row sm:items-center gap-4 py-5">
                <div className="flex-1 min-w-0">
                    <p className="m-0 text-base font-semibold text-navy">邀请朋友充值,你也赚佣金</p>
                    <p className="m-0 mt-1 text-sm text-muted-ink leading-relaxed">
                        阶梯佣金 <strong className="text-navy">10% / 15% / 20%</strong>,归因期{' '}
                        <strong className="text-navy">24 个月</strong>,月结打款。最低门槛,代理人人可申请。
                    </p>
                </div>
                <Link
                    href="/reseller"
                    onClick={() => fireAnalytics('reseller_promo_card_clicked', { source: sourceStatus })}
                    className={[
                        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0',
                        'rounded-lg bg-navy text-paper no-underline px-4 py-2.5 text-sm font-medium',
                        'hover:bg-navy-strong transition-colors duration-150 ease-brand',
                    ].join(' ')}
                >
                    了解代理计划 <span aria-hidden="true">→</span>
                </Link>
            </CardContent>
        </Card>
    );
}
