/**
 * /portal/register — public email signup (W7 D4).
 *
 * Server component. If the visitor is already logged in we send them on
 * to /dashboard (mirror of /login's gate). The form itself is a client
 * component for interactivity; it posts to /api/auth/register, which
 * handles user creation, new-api provisioning, verification email, and
 * the optional invite_code path.
 *
 * Visual: warm-paper backdrop + Card layout matching /login (W7 P2A).
 */
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { Card } from '@/components/ui/Card';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { getLocale } from '@/lib/i18n/server';
import { pickMessages } from '@/lib/i18n';
import { authMessages } from '@/lib/i18n/messages/auth';
import { RegisterForm } from './register-form';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
    const m = pickMessages(authMessages, await getLocale());
    return { title: m.register.pageTitle };
}

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/portal/register', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

export default async function RegisterPage() {
    const user = await getSessionUser();
    if (user) {
        // Already signed in — skip the form, drop them on the dashboard.
        redirect('/dashboard');
    }

    const all = pickMessages(authMessages, await getLocale());
    const m = all.register;

    return (
        <main className="min-h-screen flex items-center justify-center bg-paper px-4 py-10">
            <Card className="w-full max-w-md p-8">
                <header className="mb-6 flex items-center gap-3">
                    <BrandLogo variant="primary-flat" size={28} />
                    <p className="m-0 text-xs text-minor-ink">Connecting Global Intelligence.</p>
                    <LocaleSwitcher className="ml-auto" />
                </header>
                <h2 className="m-0 mb-1 text-base font-semibold text-navy">{m.heading}</h2>
                <p className="m-0 mb-5 text-sm text-muted-ink">
                    {m.subtitle}{' '}
                    <a href="/login" className="text-navy font-medium hover:text-brand-accent">
                        {m.goLogin}
                    </a>
                </p>
                <Suspense fallback={<p className="text-sm text-muted-ink">{all.loading}</p>}>
                    <RegisterForm />
                </Suspense>
            </Card>
        </main>
    );
}
