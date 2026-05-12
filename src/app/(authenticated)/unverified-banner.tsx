'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';

/**
 * Soft-block reminder shown when User.email_verified=false (W3 D5 decision —
 * unverified accounts can still browse + recharge, but a banner nudges them
 * to verify so the email is trustworthy when we later need it for password
 * reset / receipts / alerts).
 *
 * The "重发验证邮件" button POSTs /api/auth/resend-verification (W3 D5 endpoint).
 * The endpoint is session-less by design (it's also called from /login when
 * a user can't verify), so the form supplies the email via the body. PR-U2
 * shipped this banner without a body, which made the endpoint reject with
 * `invalid_input` every time — the fix here threads the logged-in user's
 * email through from layout.tsx into the body.
 *
 * The server-side throttle still applies (5-min window per user), so
 * spamming this button has no additional effect beyond the first valid call.
 */
type SendStatus = 'idle' | 'sending' | 'sent' | 'error';

interface Props {
    /** Current user's email — forwarded by the layout. Passed in the
     *  request body so the session-less endpoint can identify the target. */
    email: string;
}

/** Exported so tests can assert the request shape directly (the bug we're
 *  fixing was exactly this contract — empty body vs schema requires email).
 *  Returns a normalized result; the caller handles UI state. */
export async function callResendVerification(email: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const r = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email }),
    });
    if (r.ok) return { ok: true };
    const data = await r.json().catch(() => ({}));
    const err =
        typeof (data as { error?: unknown })?.error === 'string'
            ? (data as { error: string }).error
            : `请求失败 (${r.status})`;
    return { ok: false, error: err };
}

export function UnverifiedBanner({ email }: Props) {
    const [status, setStatus] = useState<SendStatus>('idle');
    const [errMsg, setErrMsg] = useState<string | null>(null);

    async function handleResend() {
        if (status === 'sending') return;
        setStatus('sending');
        setErrMsg(null);
        try {
            const r = await callResendVerification(email);
            if (r.ok) {
                setStatus('sent');
                return;
            }
            setErrMsg(r.error);
            setStatus('error');
        } catch (err) {
            setErrMsg(err instanceof Error ? err.message : '网络错误');
            setStatus('error');
        }
    }

    return (
        <div
            role="alert"
            className={[
                'rounded-lg mb-4 px-4 py-3 text-sm flex items-center justify-between gap-3 flex-wrap',
                'bg-status-warning-bg border border-status-warning-border text-status-warning-text',
            ].join(' ')}
        >
            <span>邮箱未验证,部分功能受限。</span>
            <span className="flex items-center gap-2">
                {status === 'sent' && <span className="text-status-success-text">验证邮件已发送,请查收 ✓</span>}
                {status === 'error' && errMsg ? <FormError>{errMsg}</FormError> : null}
                {status !== 'sent' && (
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={handleResend}
                        loading={status === 'sending'}
                    >
                        {status === 'sending' ? '发送中…' : '重发验证邮件'}
                    </Button>
                )}
            </span>
        </div>
    );
}
