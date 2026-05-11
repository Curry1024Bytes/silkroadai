/**
 * PR-U2 — TierBadge SSR smoke.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { TierBadge } from '@/components/reseller/TierBadge';

describe('<TierBadge />', () => {
    it.each([
        ['bronze', '青铜', '🥉'],
        ['silver', '白银', '🥈'],
        ['gold', '黄金', '🥇'],
    ] as const)('tier=%s shows label %s + emoji %s', (tier, label, emoji) => {
        const html = renderToString(<TierBadge tier={tier} />);
        expect(html).toContain(label);
        expect(html).toContain(emoji);
        expect(html).toContain(`data-tier="${tier}"`);
        // muted english tier shown — Tailwind's `uppercase` class is
        // visual-only, the underlying string in markup stays lowercase.
        expect(html).toContain(`>${tier}<`);
    });

    it('size=sm renders with smaller padding (px-2 / py-0.5)', () => {
        const html = renderToString(<TierBadge tier="bronze" size="sm" />);
        expect(html).toContain('px-2');
        expect(html).toContain('py-0.5');
    });

    it('showLabel=false suppresses the localized label', () => {
        const html = renderToString(<TierBadge tier="gold" showLabel={false} />);
        // emoji still shown, label text removed
        expect(html).toContain('🥇');
        expect(html).not.toContain('黄金');
    });
});
