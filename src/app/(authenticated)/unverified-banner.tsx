'use client';

import { useState } from 'react';

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
            style={{
                background: '#fff8e1',
                border: '1px solid #f0d785',
                color: '#7a5d00',
                padding: '10px 14px',
                borderRadius: 4,
                marginBottom: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                fontSize: 13,
            }}
        >
            <span>邮箱未验证,部分功能受限。</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {status === 'sent' && (
                    <span style={{ color: '#1a8a4a' }}>验证邮件已发送,请查收 ✓</span>
                )}
                {status === 'error' && errMsg && (
                    <span style={{ color: '#c44' }}>{errMsg}</span>
                )}
                {status !== 'sent' && (
                    <button
                        type="button"
                        onClick={handleResend}
                        disabled={status === 'sending'}
                        style={{
                            background: '#7a5d00',
                            color: '#fff',
                            border: 'none',
                            padding: '6px 12px',
                            borderRadius: 4,
                            fontSize: 12,
                            cursor: status === 'sending' ? 'not-allowed' : 'pointer',
                            opacity: status === 'sending' ? 0.6 : 1,
                        }}
                    >
                        {status === 'sending' ? '发送中…' : '重发验证邮件'}
                    </button>
                )}
            </span>
        </div>
    );
}
