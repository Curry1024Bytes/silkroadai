/**
 * Pay QR poll-runner — transient-failure tolerance (2026-06 hotfix).
 *
 * Customers were complaining about a red "状态查询失败,稍后重试…" on the
 * scan-to-pay page. Root cause: the runner polls order status every 3s and
 * flipped to that scary copy on a SINGLE failed poll — but flaky mobile
 * network, the tab being backgrounded while the customer is in the WeChat
 * app, and our own deploy-time container restarts all cause blips that
 * self-heal on the very next tick. People saw the red text and thought
 * their payment had failed.
 *
 * Fix: swallow short failure streaks (keep the last good phase on screen)
 * and only show a calm muted "正在重新连接,请稍候…" after FAILURE_GRACE_TICKS
 * consecutive failures. The threshold decision lives in the pure
 * `reduceFailure` helper, unit-tested here without a DOM — the component
 * itself is effect / timer / fetch driven and the repo has no jsdom + RTL
 * harness (see the renderToString convention in pay-form.test.tsx).
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { QrPollRunner, reduceFailure, FAILURE_GRACE_TICKS } from '@/app/pay/qr/qr-runner';

describe('reduceFailure — swallow short blips, reconnect only when sustained', () => {
    it('keeps a small, deploy-restart-tolerant grace window', () => {
        // 4 polls × 3s ≈ a ~10s outage before the customer sees anything.
        expect(FAILURE_GRACE_TICKS).toBe(4);
    });

    it('swallows every failure below the threshold (phase = null → leave as-is)', () => {
        let failures = 0;
        for (let i = 1; i < FAILURE_GRACE_TICKS; i++) {
            const r = reduceFailure(failures);
            failures = r.failures;
            expect(r.failures).toBe(i);
            // null means "do not touch the phase" — the page keeps showing
            // 等待付款… instead of flashing an error on a single blip.
            expect(r.phase).toBeNull();
        }
    });

    it('flips to reconnecting exactly on the threshold-th failure', () => {
        const atThreshold = reduceFailure(FAILURE_GRACE_TICKS - 1);
        expect(atThreshold.failures).toBe(FAILURE_GRACE_TICKS);
        expect(atThreshold.phase).toBe('reconnecting');
    });

    it('stays on reconnecting for any further sustained failure', () => {
        const beyond = reduceFailure(FAILURE_GRACE_TICKS + 7);
        expect(beyond.failures).toBe(FAILURE_GRACE_TICKS + 8);
        expect(beyond.phase).toBe('reconnecting');
    });

    it('never reports the old alarming failure phase', () => {
        // The only non-null phase reduceFailure can ever emit is the calm one.
        for (let f = 0; f < 20; f++) {
            const phase = reduceFailure(f).phase;
            expect(phase === null || phase === 'reconnecting').toBe(true);
        }
    });
});

describe('<QrPollRunner /> initial render', () => {
    it('shows the calm waiting copy and never the old scary "状态查询失败"', () => {
        const html = renderToString(<QrPollRunner orderId="ord-123" accessToken={null} />);
        expect(html).toContain('等待付款');
        // The exact copy that drove customer complaints must be gone for good.
        expect(html).not.toContain('状态查询失败');
    });
});
