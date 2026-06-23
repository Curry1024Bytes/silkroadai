'use client';

/**
 * QR-page polling runner (W5 D6).
 *
 * Sits inside the /pay/qr server page and silently polls the order
 * status endpoint every 3s. Redirects on terminal states:
 *   - rechargeSuccess === true  → /balance      (happy path)
 *   - 15 minutes elapsed        → /pay/result   (timeout fallback)
 *   - rechargeStatus closed/failed terminal      → /pay/result
 *
 * The poll endpoint is `GET /api/orders/[id]?t=<accessToken>` —
 * gated by the per-order status access token (token-of-bearer)
 * issued by createOrder. Admin token also works (verifyAdminToken
 * fallback in route.ts) but the portal flow uses the t= param.
 *
 * Transient poll failures are SWALLOWED. A single failed poll (flaky
 * mobile network, the tab backgrounded while the customer is in the
 * WeChat app, our own container restart during a deploy) self-heals on
 * the next 3s tick, so we keep showing the last good phase instead of
 * flashing an alarming error. Only a sustained outage — FAILURE_GRACE_TICKS
 * back-to-back failures (~10s) — surfaces a calm "正在重新连接" hint in
 * muted ink. This is why customers no longer see the old red
 * "状态查询失败" on every network blip (it scared people into thinking
 * their payment had failed).
 */
import { useEffect, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 3_000;
const TIMEOUT_MS = 15 * 60 * 1_000; // 15 minutes
// How many back-to-back poll failures to tolerate before showing the calm
// "reconnecting" hint. At 3s/poll the 4th consecutive failure lands ~10s in —
// long enough to swallow a flaky-network blip or a deploy-time container
// restart, which would otherwise self-heal on the very next tick.
export const FAILURE_GRACE_TICKS = 4;

type DisplayPhase = 'waiting' | 'paid' | 'recharging' | 'success' | 'failed' | 'timeout' | 'reconnecting';

/**
 * Pure decision for a single poll failure. Returns the new consecutive-failure
 * count and the phase to display — or a `null` phase meaning "leave the current
 * phase untouched", so a short blip never disturbs the screen. Extracted so the
 * swallow-then-reconnect threshold is unit-testable without a DOM (the
 * component itself is effect / timer / fetch driven and not run by the repo's
 * renderToString-based component tests).
 */
export function reduceFailure(prevFailures: number): { failures: number; phase: 'reconnecting' | null } {
    const failures = prevFailures + 1;
    return { failures, phase: failures >= FAILURE_GRACE_TICKS ? 'reconnecting' : null };
}

interface PollResponse {
    id: string;
    status: string;
    expiresAt: string | null;
    paymentSuccess: boolean;
    rechargeSuccess: boolean;
    rechargeStatus: 'not_paid' | 'paid_pending' | 'recharging' | 'success' | 'failed' | 'closed';
    failedReason: string | null;
}

// W7 P3: status colors swapped from inline hex to design-system tokens.
// Same intent as before — neutral / processing → muted-ink/navy, terminal
// success → status-success, terminal failure → status-error. The
// sustained-outage hint uses muted-ink (calm grey, NOT a warning red): it is
// a "still trying" reassurance, not a failure the customer must act on.
const PHASE_TEXT: Record<DisplayPhase, { label: string; color: string }> = {
    waiting: { label: '等待付款…', color: 'var(--color-muted-ink)' },
    paid: { label: '付款已收到,正在到账…', color: 'var(--color-navy)' },
    recharging: { label: '正在到账…', color: 'var(--color-navy)' },
    success: { label: '充值成功,正在跳转余额页…', color: 'var(--color-status-success-text)' },
    failed: { label: '订单失败,正在跳转结果页…', color: 'var(--color-status-error-text)' },
    timeout: { label: '等待超时,正在跳转结果页…', color: 'var(--color-status-error-text)' },
    // Shown only after FAILURE_GRACE_TICKS consecutive failures — a single
    // transient blip never reaches here. Calm copy + muted ink on purpose.
    reconnecting: { label: '正在重新连接,请稍候…', color: 'var(--color-muted-ink)' },
};

export function QrPollRunner({ orderId, accessToken }: { orderId: string; accessToken: string | null }) {
    const [phase, setPhase] = useState<DisplayPhase>('waiting');
    // Avoid double-redirect (interval + timeout racing) and stale state on unmount.
    const redirectedRef = useRef(false);

    useEffect(() => {
        if (!orderId) return;

        let cancelled = false;
        // Count of consecutive failed polls. Reset to 0 by any good poll.
        // Lives in the effect scope so it resets naturally on remount / dep
        // change and never triggers a re-render the way a state value would.
        let failures = 0;

        const goTo = (url: string) => {
            if (redirectedRef.current || cancelled) return;
            redirectedRef.current = true;
            window.location.href = url;
        };

        // A poll failed (non-2xx or network error). Swallow short streaks —
        // keep the last good phase on screen — and only flip to the calm
        // "reconnecting" hint once the failures are clearly sustained.
        const noteTransientFailure = () => {
            if (cancelled || redirectedRef.current) return;
            const next = reduceFailure(failures);
            failures = next.failures;
            if (next.phase) setPhase(next.phase);
        };

        const url = accessToken
            ? `/api/orders/${encodeURIComponent(orderId)}?t=${encodeURIComponent(accessToken)}`
            : `/api/orders/${encodeURIComponent(orderId)}`;

        const tick = async () => {
            if (redirectedRef.current || cancelled) return;
            try {
                const r = await fetch(url, {
                    method: 'GET',
                    credentials: 'same-origin',
                    cache: 'no-store',
                });
                if (!r.ok) {
                    noteTransientFailure();
                    return;
                }
                const data = (await r.json()) as PollResponse;
                if (cancelled) return;

                // A good poll clears the failure streak (and any reconnecting
                // hint) before we map the real status below.
                failures = 0;

                if (data.rechargeSuccess) {
                    setPhase('success');
                    goTo('/balance');
                    return;
                }
                if (data.rechargeStatus === 'failed' || data.rechargeStatus === 'closed') {
                    setPhase('failed');
                    goTo(`/pay/result?order_id=${encodeURIComponent(orderId)}`);
                    return;
                }
                if (data.rechargeStatus === 'recharging') {
                    setPhase('recharging');
                    return;
                }
                if (data.paymentSuccess) {
                    setPhase('paid');
                    return;
                }
                setPhase('waiting');
            } catch {
                noteTransientFailure();
            }
        };

        // First poll immediately (don't wait 3s for initial state).
        tick();
        const intervalId = window.setInterval(tick, POLL_INTERVAL_MS);

        // 15-min hard cap — bounce to /pay/result so the customer sees a
        // proper status / retry CTA instead of a frozen QR page.
        const timeoutId = window.setTimeout(() => {
            if (redirectedRef.current || cancelled) return;
            setPhase('timeout');
            goTo(`/pay/result?order_id=${encodeURIComponent(orderId)}`);
        }, TIMEOUT_MS);

        return () => {
            cancelled = true;
            window.clearInterval(intervalId);
            window.clearTimeout(timeoutId);
        };
    }, [orderId, accessToken]);

    const { label, color } = PHASE_TEXT[phase];

    return (
        <div
            role="status"
            aria-live="polite"
            style={{
                marginTop: 16,
                padding: '10px 12px',
                background: '#f5f7fa',
                border: '1px solid #e5e8ee',
                borderRadius: 6,
                fontSize: 13,
                color,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
            }}
        >
            <span
                aria-hidden="true"
                style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: color,
                    opacity: phase === 'waiting' ? 0.4 : 0.8,
                }}
            />
            <span>{label}</span>
        </div>
    );
}
