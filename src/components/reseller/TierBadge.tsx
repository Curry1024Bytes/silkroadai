/**
 * TierBadge — 3-tier reseller visual (PR-U2).
 *
 * bronze / silver / gold with a coin-style emoji + colored chip
 * background. Renders in two sizes:
 *   - 'md' (default) for cards (16-18px text + larger padding)
 *   - 'sm' for inline use in tables / sidebar
 *
 * The tier strings match the Prisma enum exactly — pass them straight
 * through from server props without normalization.
 *
 * Sync server component: the rendering page resolves the locale once and
 * passes it down (`locale` prop, default `zh` so tests without a provider
 * keep rendering Chinese).
 */
import type { ReactElement } from 'react';
import { DEFAULT_LOCALE, pickMessages, type Locale } from '@/lib/i18n';
import { resellerMessages } from '@/lib/i18n/messages/reseller';

export type ResellerTier = 'bronze' | 'silver' | 'gold';

const TIER_VISUAL: Record<ResellerTier, { emoji: string; bg: string; text: string; ring: string }> = {
    bronze: {
        emoji: '🥉',
        bg: 'bg-amber-50',
        text: 'text-amber-900',
        ring: 'ring-amber-200',
    },
    silver: {
        emoji: '🥈',
        bg: 'bg-slate-100',
        text: 'text-slate-700',
        ring: 'ring-slate-300',
    },
    gold: {
        emoji: '🥇',
        bg: 'bg-yellow-50',
        text: 'text-yellow-900',
        ring: 'ring-yellow-300',
    },
};

interface Props {
    tier: ResellerTier;
    size?: 'sm' | 'md';
    /** Show the localized label (e.g. "青铜 Bronze"). When false, only the
     *  emoji renders — useful for compact placements like the sidebar. */
    showLabel?: boolean;
    /** Resolved by the parent server page (`await getLocale()`). */
    locale?: Locale;
}

export function TierBadge({ tier, size = 'md', showLabel = true, locale = DEFAULT_LOCALE }: Props): ReactElement {
    const v = TIER_VISUAL[tier];
    const label = pickMessages(resellerMessages, locale).tier[tier];
    const padX = size === 'sm' ? 'px-2' : 'px-3';
    const padY = size === 'sm' ? 'py-0.5' : 'py-1';
    const textSize = size === 'sm' ? 'text-xs' : 'text-sm';
    // The muted English enum code is an ops cross-reference next to a
    // non-English label; when the label already IS the English word, skip it.
    const showCode = label.toLowerCase() !== tier;
    return (
        <span
            className={[
                'inline-flex items-center gap-1 rounded-full ring-1',
                v.bg,
                v.text,
                v.ring,
                padX,
                padY,
                textSize,
                'font-medium',
            ].join(' ')}
            data-tier={tier}
        >
            <span aria-hidden="true">{v.emoji}</span>
            {showLabel && (
                <span>
                    {label}
                    {showCode && <span className="ml-1 text-[10px] opacity-60 uppercase">{tier}</span>}
                </span>
            )}
        </span>
    );
}
