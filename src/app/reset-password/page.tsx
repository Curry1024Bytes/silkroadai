import { Suspense } from 'react';
import { Logo } from '@/components/brand/Logo';
import { getLocale } from '@/lib/i18n/server';
import { pickMessages } from '@/lib/i18n';
import { authMessages } from '@/lib/i18n/messages/auth';
import { ResetPasswordForm } from './reset-password-form';

export async function generateMetadata() {
    const m = pickMessages(authMessages, await getLocale());
    return { title: m.reset.pageTitle };
}

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
    const m = pickMessages(authMessages, await getLocale());
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
                    <p style={{ margin: '6px 0 0', fontSize: 12, color: '#5a6478' }}>Connecting Global Intelligence.</p>
                </header>
                <h2 style={{ fontSize: 16, color: '#0a1535', margin: '0 0 16px' }}>{m.reset.heading}</h2>
                <Suspense fallback={<p>{m.loading}</p>}>
                    <ResetPasswordFormWrapper searchParamsPromise={searchParams} missingToken={m.reset.missingToken} />
                </Suspense>
            </div>
        </main>
    );
}

async function ResetPasswordFormWrapper({
    searchParamsPromise,
    missingToken,
}: {
    searchParamsPromise: Promise<{ token?: string }>;
    missingToken: string;
}) {
    const { token } = await searchParamsPromise;
    if (!token) {
        return <p style={{ color: 'var(--color-status-error-text)' }}>{missingToken}</p>;
    }
    return <ResetPasswordForm token={token} />;
}
