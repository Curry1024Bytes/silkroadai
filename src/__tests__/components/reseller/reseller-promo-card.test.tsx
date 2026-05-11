/**
 * fix/reseller-entry-discovery — ResellerPromoCard SSR smoke.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ResellerPromoCard } from '@/components/reseller/ResellerPromoCard';

describe('<ResellerPromoCard />', () => {
    it('renders headline + tier rates + CTA + /reseller link', () => {
        const html = renderToString(<ResellerPromoCard sourceStatus="none" />);
        expect(html).toContain('邀请朋友充值,你也赚佣金');
        expect(html).toContain('10% / 15% / 20%');
        expect(html).toContain('24 个月');
        expect(html).toContain('了解代理计划');
        expect(html).toContain('href="/reseller"');
    });

    it('sourceStatus="none" / "suspended" / "banned" all render the same shell', () => {
        // Card shell is identical across source states — only the analytics
        // event payload (onClick) differs. SSR-time content the user sees
        // doesn't change.
        const a = renderToString(<ResellerPromoCard sourceStatus="none" />);
        const b = renderToString(<ResellerPromoCard sourceStatus="suspended" />);
        const c = renderToString(<ResellerPromoCard sourceStatus="banned" />);
        expect(a).toBe(b);
        expect(b).toBe(c);
    });
});
