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
 */
import { useEffect, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 3_000;
const TIMEOUT_MS = 15 * 60 * 1_000; // 15 minutes

type DisplayPhase = 'waiting' | 'paid' | 'recharging' | 'success' | 'failed' | 'timeout' | 'error';

interface PollResponse {
    id: string;
    status: string;
    expiresAt: string | null;
    paymentSuccess: boolean;
    rechargeSuccess: boolean;
    rechargeStatus:
        | 'not_paid'
        | 'paid_pending'
        | 'recharging'
        | 'success'
        | 'failed'
        | 'closed';
    failedReason: string | null;
}

const PHASE_TEXT: Record<DisplayPhase, { label: string; color: string }> = {
    waiting: { label: '等待付款…', color: '#5a6478' },
    paid: { label: '付款已收到,正在到账…', color: '#0a1535' },
    recharging: { label: '正在到账…', color: '#0a1535' },
    success: { label: '充值成功,正在跳转余额页…', color: '#1f7a3a' },
    failed: { label: '订单失败,正在跳转结果页…', color: '#c44' },
    timeout: { label: '等待超时,正在跳转结果页…', color: '#c44' },
    error: { label: '状态查询失败,稍后重试…', color: '#a86200' },
};

export function QrPollRunner({
    orderId,
    accessToken,
}: {
    orderId: string;
    accessToken: string | null;
}) {
    const [phase, setPhase] = useState<DisplayPhase>('waiting');
    // Avoid double-redirect (interval + timeout racing) and stale state on unmount.
    const redirectedRef = useRef(false);

    useEffect(() => {
        if (!orderId) return;

        let cancelled = false;

        const goTo = (url: string) => {
            if (redirectedRef.current || cancelled) return;
            redirectedRef.current = true;
            window.location.href = url;
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
                    if (!cancelled) setPhase('error');
                    return;
                }
                const data = (await r.json()) as PollResponse;
                if (cancelled) return;

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
                if (!cancelled) setPhase('error');
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
