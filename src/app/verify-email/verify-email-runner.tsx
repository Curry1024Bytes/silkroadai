'use client';

import { useEffect, useRef, useState } from 'react';

type Status =
    | { phase: 'pending' }
    | { phase: 'success' }
    | { phase: 'failure'; reason: 'invalid_or_expired_token' | 'network' | 'unknown' };

export function VerifyEmailRunner({ token }: { token: string }) {
    const [status, setStatus] = useState<Status>({ phase: 'pending' });
    // React 19 / dev StrictMode mounts effects twice. Guard the network call so
    // we don't burn the token on the first invisible run.
    const fired = useRef(false);

    useEffect(() => {
        if (fired.current) return;
        fired.current = true;

        (async () => {
            try {
                const r = await fetch('/api/auth/verify-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token }),
                });
                if (r.ok) {
                    setStatus({ phase: 'success' });
                } else {
                    const data = await r.json().catch(() => ({}));
                    const reason = data?.error === 'invalid_or_expired_token' ? 'invalid_or_expired_token' : 'unknown';
                    setStatus({ phase: 'failure', reason });
                }
            } catch {
                setStatus({ phase: 'failure', reason: 'network' });
            }
        })();
    }, [token]);

    if (status.phase === 'pending') {
        return <p style={{ color: '#53645f' }}>正在验证邮箱…</p>;
    }

    if (status.phase === 'success') {
        return (
            <div>
                <p style={{ color: 'var(--color-status-success-text)' }}>邮箱已验证 ✓</p>
                <p>
                    <a href="/login" style={{ color: '#0e1715' }}>
                        前往登录
                    </a>
                </p>
            </div>
        );
    }

    const msg =
        status.reason === 'invalid_or_expired_token'
            ? '链接已失效或已使用,请重新申请验证邮件。'
            : status.reason === 'network'
              ? '网络错误,请稍后重试。'
              : '验证失败,请稍后重试。';

    return (
        <div>
            <p style={{ color: 'var(--color-status-error-text)' }}>{msg}</p>
            <p style={{ fontSize: 13, color: '#53645f' }}>登录后可在客户后台重新发送验证邮件。</p>
        </div>
    );
}
