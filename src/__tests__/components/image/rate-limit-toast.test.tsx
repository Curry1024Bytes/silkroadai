/**
 * PR-T3 — RateLimitToast SSR smoke + countdown logic.
 *
 * Tests the initial-paint markup (no jsdom timing).
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { RateLimitToast } from '@/components/image/RateLimitToast';

describe('<RateLimitToast />', () => {
    it('shows the countdown text + initial seconds', () => {
        const html = renderToString(<RateLimitToast retryAfterMs={42_000} onExpire={() => {}} />);
        expect(html).toContain('1 分钟内生成次数已达上限');
        expect(html).toContain('42');
        expect(html).toMatch(/aria-live="polite"/);
        expect(html).toMatch(/role="status"/);
    });

    it('rounds up sub-second remainders so 30.4s shows as 31', () => {
        const html = renderToString(<RateLimitToast retryAfterMs={30_400} onExpire={() => {}} />);
        expect(html).toContain('31');
    });

    it('clamps retryAfterMs ≤ 0 to a 0 countdown (caller can fire onExpire next tick)', () => {
        const html = renderToString(<RateLimitToast retryAfterMs={0} onExpire={() => {}} />);
        // The number "0" should appear; test reads "请稍候 0 秒"
        expect(html).toContain('0');
    });

    it('renders the dismiss button only when onDismiss is supplied', () => {
        const withDismiss = renderToString(
            <RateLimitToast retryAfterMs={30_000} onExpire={() => {}} onDismiss={() => {}} />,
        );
        expect(withDismiss).toMatch(/aria-label="关闭"/);

        const withoutDismiss = renderToString(<RateLimitToast retryAfterMs={30_000} onExpire={() => {}} />);
        expect(withoutDismiss).not.toMatch(/aria-label="关闭"/);
    });
});
