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
 * That endpoint is throttled server-side, so spamming this button has no
 * additional effect.
 */
type SendStatus = 'idle' | 'sending' | 'sent' | 'error';

export function UnverifiedBanner() {
    const [status, setStatus] = useState<SendStatus>('idle');
    const [errMsg, setErrMsg] = useState<string | null>(null);

    async function handleResend() {
        if (status === 'sending') return;
        setStatus('sending');
        setErrMsg(null);
        try {
            const r = await fetch('/api/auth/resend-verification', {
                method: 'POST',
                credentials: 'same-origin',
            });
            if (r.ok) {
                setStatus('sent');
                return;
            }
            const data = await r.json().catch(() => ({}));
            setErrMsg(typeof data?.error === 'string' ? data.error : `请求失败 (${r.status})`);
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
