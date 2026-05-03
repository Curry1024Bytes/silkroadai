'use client';

import { useState } from 'react';

export function LoginForm({ next }: { next: string }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            const r = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ email, password }),
            });
            if (r.ok) {
                window.location.href = next;
                return;
            }
            const data = await r.json().catch(() => ({}));
            // /api/auth/login returns 401 'invalid_credentials' for both
            // wrong-password and unknown-email (timing defense). Don't try
            // to be more specific than the server is willing to be.
            setError(
                typeof data?.error === 'string'
                    ? data.error === 'invalid_credentials'
                        ? '邮箱或密码错误'
                        : data.error === 'invalid_input'
                          ? '请检查邮箱格式或密码长度'
                          : `登录失败:${data.error}`
                    : `登录失败 (${r.status})`,
            );
            setSubmitting(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : '网络错误,请稍后重试');
            setSubmitting(false);
        }
    }

    const inputStyle: React.CSSProperties = {
        width: '100%',
        padding: '8px 10px',
        border: '1px solid #e5e8ee',
        borderRadius: 4,
        fontSize: 14,
        boxSizing: 'border-box',
    };
    const labelStyle: React.CSSProperties = {
        display: 'block',
        fontSize: 13,
        color: '#5a6478',
        marginBottom: 4,
    };

    return (
        <div>
            <form onSubmit={handleSubmit}>
                <div style={{ marginBottom: 14 }}>
                    <label style={labelStyle}>邮箱</label>
                    <input
                        type="email"
                        autoComplete="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        style={inputStyle}
                    />
                </div>
                <div style={{ marginBottom: 16 }}>
                    <label style={labelStyle}>密码</label>
                    <input
                        type="password"
                        autoComplete="current-password"
                        required
                        minLength={1}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        style={inputStyle}
                    />
                </div>
                {error && (
                    <p style={{ color: '#c44', fontSize: 13, margin: '0 0 12px' }}>{error}</p>
                )}
                <button
                    type="submit"
                    disabled={submitting || !email || !password}
                    style={{
                        width: '100%',
                        padding: '10px 0',
                        background: submitting ? '#a8aebc' : '#0a1535',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 4,
                        cursor: submitting ? 'not-allowed' : 'pointer',
                        fontSize: 15,
                    }}
                >
                    {submitting ? '登录中…' : '登录'}
                </button>
            </form>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0' }}>
                <hr style={{ flex: 1, border: 'none', borderTop: '1px solid #e5e8ee' }} />
                <span style={{ fontSize: 12, color: '#8a92a4' }}>或使用第三方登录</span>
                <hr style={{ flex: 1, border: 'none', borderTop: '1px solid #e5e8ee' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <a
                    href="/api/auth/oauth/google/start"
                    style={{
                        display: 'block',
                        textAlign: 'center',
                        padding: '10px 0',
                        background: '#fff',
                        color: '#1a2540',
                        border: '1px solid #e5e8ee',
                        borderRadius: 4,
                        textDecoration: 'none',
                        fontSize: 14,
                    }}
                >
                    使用 Google 登录
                </a>
                <a
                    href="/api/auth/oauth/github/start"
                    style={{
                        display: 'block',
                        textAlign: 'center',
                        padding: '10px 0',
                        background: '#fff',
                        color: '#1a2540',
                        border: '1px solid #e5e8ee',
                        borderRadius: 4,
                        textDecoration: 'none',
                        fontSize: 14,
                    }}
                >
                    使用 GitHub 登录
                </a>
            </div>
        </div>
    );
}
