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
 */
import type { ReactElement } from 'react';

export type ResellerTier = 'bronze' | 'silver' | 'gold';

const TIER_VISUAL: Record<ResellerTier, { label: string; emoji: string; bg: string; text: string; ring: string }> = {
    bronze: {
        label: '青铜',
        emoji: '🥉',
        bg: 'bg-amber-50',
        text: 'text-amber-900',
        ring: 'ring-amber-200',
    },
    silver: {
        label: '白银',
        emoji: '🥈',
        bg: 'bg-slate-100',
        text: 'text-slate-700',
        ring: 'ring-slate-300',
    },
    gold: {
        label: '黄金',
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
}

export function TierBadge({ tier, size = 'md', showLabel = true }: Props): ReactElement {
    const v = TIER_VISUAL[tier];
    const padX = size === 'sm' ? 'px-2' : 'px-3';
    const padY = size === 'sm' ? 'py-0.5' : 'py-1';
    const textSize = size === 'sm' ? 'text-xs' : 'text-sm';
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
                    {v.label}
                    {/* English tier kept here for ops cross-reference; muted */}
                    <span className="ml-1 text-[10px] opacity-60 uppercase">{tier}</span>
                </span>
            )}
        </span>
    );
}
