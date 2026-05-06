/**
 * W6 D1 — first-recharge-bonus banner.
 *
 * Pure presentational component. Server-side decides whether to render
 * (based on `User.first_recharge_bonus_granted`). The actual bonus claim
 * + race protection lives in `executeRecharge` (CAS lock inside an
 * interactive Prisma transaction); this banner is UI hint only and has
 * no behavioral coupling — hiding/showing it incorrectly does not allow
 * a user to claim the bonus twice or skip it.
 *
 * W7 P2: warm gold-tinted banner using the design system's brand-accent
 * left rail (matches the landing-page promo banner aesthetic).
 */
export function FirstRechargeBonusBanner() {
    return (
        <div
            role="note"
            data-testid="first-recharge-bonus-banner"
            className={[
                'mb-4 px-4 py-3 rounded-lg text-sm leading-snug',
                'bg-paper-muted border-l-[3px] border-brand-accent',
                'flex items-center gap-3 text-ink',
            ].join(' ')}
        >
            <span className="text-brand-accent text-base" aria-hidden="true">
                🎁
            </span>
            <span>
                <strong className="text-navy">首充福利</strong>
                <span className="ml-2 text-muted-ink">
                    额外赠送 20% bonus,机会只此一次
                </span>
            </span>
        </div>
    );
}
