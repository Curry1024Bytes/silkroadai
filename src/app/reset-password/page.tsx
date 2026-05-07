import { Suspense } from 'react';
import { Logo } from '@/components/brand/Logo';
import { ResetPasswordForm } from './reset-password-form';

export const metadata = { title: '重置密码 — Silk Road AI' };

export default function ResetPasswordPage({
    searchParams,
}: {
    searchParams: Promise<{ token?: string }>;
}) {
    return (
        <main
            style={{
                minHeight: '100vh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#f5f7fa',
                padding: 24,
            }}
        >
            <div
                style={{
                    maxWidth: 420,
                    width: '100%',
                    background: '#fff',
                    padding: 32,
                    borderRadius: 8,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
                }}
            >
                <header style={{ marginBottom: 24 }}>
                    <Logo variant="primary" size={28} />
                    <p style={{ margin: '6px 0 0', fontSize: 12, color: '#5a6478' }}>
                        Connecting Global Intelligence.
                    </p>
                </header>
                <h2 style={{ fontSize: 16, color: '#0a1535', margin: '0 0 16px' }}>重置密码</h2>
                <Suspense fallback={<p>加载中…</p>}>
                    <ResetPasswordFormWrapper searchParamsPromise={searchParams} />
                </Suspense>
            </div>
        </main>
    );
}

async function ResetPasswordFormWrapper({
    searchParamsPromise,
}: {
    searchParamsPromise: Promise<{ token?: string }>;
}) {
    const { token } = await searchParamsPromise;
    if (!token) {
        return <p style={{ color: 'var(--color-status-error-text)' }}>缺少 token 参数,请从邮件链接打开。</p>;
    }
    return <ResetPasswordForm token={token} />;
}
