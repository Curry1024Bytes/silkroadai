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
import { RegisterForm } from './register-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: '注册 — Silk Road AI' };

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

    return (
        <main className="min-h-screen flex items-center justify-center bg-paper px-4 py-10">
            <Card className="w-full max-w-md p-8">
                <header className="mb-6 flex items-center gap-3">
                    <BrandLogo variant="primary-flat" size={28} />
                    <p className="m-0 text-xs text-minor-ink">Connecting Global Intelligence.</p>
                </header>
                <h2 className="m-0 mb-1 text-base font-semibold text-navy">注册账户</h2>
                <p className="m-0 mb-5 text-sm text-muted-ink">
                    邮箱注册 · 5 秒到账 · 已经有账户?{' '}
                    <a href="/login" className="text-navy font-medium hover:text-brand-accent">
                        前往登录
                    </a>
                </p>
                <Suspense fallback={<p className="text-sm text-muted-ink">加载中…</p>}>
                    <RegisterForm />
                </Suspense>
            </Card>
        </main>
    );
}
