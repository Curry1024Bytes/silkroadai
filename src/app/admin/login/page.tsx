/**
 * Admin login page (server component). NOT inside the `(console)` route group,
 * so the console's auth-gate layout doesn't wrap it — no redirect loop.
 *
 * - already a staff+ admin  → redirect to /admin.
 * - logged in but role < staff → render the form + a "no admin permission"
 *   notice (a customer who logged in here gets bounced from /admin back to
 *   this page; we explain why instead of looping silently).
 * - not logged in            → render the form.
 */
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/admin/auth';
import { Logo } from '@/components/brand/Logo';
import { Card } from '@/components/ui/Card';
import { AdminLoginForm } from './login-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: '管理员登录 — LLmRoute' };

async function getSession() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/admin/login', { method: 'GET', headers: { cookie } });
    // Both calls dedupe to a single DB read via getCurrentUser's React.cache().
    const user = await getCurrentUser(req);
    const admin = await getAdminUser(req);
    return { user, admin };
}

export default async function AdminLoginPage() {
    const { user, admin } = await getSession();
    if (admin) redirect('/admin');

    const loggedInButNotAdmin = !!user && !admin;

    return (
        <main className="flex min-h-screen items-center justify-center bg-paper px-4 py-10">
            <Card className="w-full max-w-md p-8">
                <header className="mb-6 flex items-center gap-3">
                    <Logo variant="primary-flat" size={28} />
                    <p className="m-0 text-xs text-minor-ink">管理后台</p>
                </header>
                <h2 className="m-0 mb-4 text-base font-semibold text-navy">管理员登录</h2>
                {loggedInButNotAdmin ? (
                    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                        你已登录为 <span className="font-medium">{user.email}</span>,但该账号没有管理后台权限。
                        <a href="/dashboard" className="ml-1 underline">
                            返回用户后台 →
                        </a>
                    </div>
                ) : null}
                <Suspense fallback={<p className="text-sm text-muted-ink">加载中…</p>}>
                    <AdminLoginForm />
                </Suspense>
            </Card>
        </main>
    );
}
