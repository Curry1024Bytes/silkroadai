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
 *
 * i18n: sync server child of /pay — the page passes its resolved `locale`
 * (cookie, or the legacy `?lang=` override). Omitted = Chinese.
 */
import { pickMessages, type Locale } from '@/lib/i18n';
import { payMessages } from '@/lib/i18n/messages/pay';

export function FirstRechargeBonusBanner({ locale = 'zh' }: { locale?: Locale } = {}) {
    const m = pickMessages(payMessages, locale).bonusBanner;
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
                <strong className="text-navy">{m.title}</strong>
                <span className="ml-2 text-muted-ink">{m.body}</span>
            </span>
        </div>
    );
}
