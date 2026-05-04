/**
 * Minimal portal login UI. Server component verifies that the visitor isn't
 * already logged in (in which case we send them on to /dashboard or wherever
 * the next= param requested), then mounts the client form. Mirrors the
 * visual style of /reset-password and /verify-email — inline-style, brand
 * color #0a1535, no Tailwind classes.
 *
 * W4-2 D7 amend: default landing flipped from /pay → /dashboard now that the
 * authenticated route group exists. /pay still works (legitimate `next=`
 * targets are honored as long as they pass safeNext) — only the *default*
 * fallback changed.
 */
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: '登录 — Silk Road AI' };

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/login', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

/** Whitelist of safe internal `next` redirect targets — refuse anything that
 *  smells like an open redirect. Same rule we'd want to apply to OAuth's
 *  state cookie carrying a return path in a future patch (W6 scope). */
function safeNext(raw: string | undefined): string {
    if (!raw) return '/dashboard';
    if (!raw.startsWith('/')) return '/dashboard';
    if (raw.startsWith('//')) return '/dashboard'; // protocol-relative URL
    return raw;
}

export default async function LoginPage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = (await searchParams) ?? {};
    const next = typeof params.next === 'string' ? safeNext(params.next) : '/dashboard';
    const oauthError = typeof params.oauth_error === 'string' ? params.oauth_error : null;

    const user = await getSessionUser();
    if (user) {
        redirect(next);
    }

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
                    <h1 style={{ margin: 0, fontSize: 18, color: '#0a1535' }}>Silk Road AI</h1>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5a6478' }}>
                        Connecting Global Intelligence.
                    </p>
                </header>
                <h2 style={{ fontSize: 16, color: '#0a1535', margin: '0 0 16px' }}>登录</h2>
                {oauthError && (
                    <p
                        style={{
                            color: '#c44',
                            fontSize: 13,
                            background: '#fdecea',
                            padding: '8px 12px',
                            borderRadius: 4,
                            margin: '0 0 16px',
                        }}
                    >
                        OAuth 登录失败:{oauthError}
                    </p>
                )}
                <Suspense fallback={<p>加载中…</p>}>
                    <LoginForm next={next} />
                </Suspense>
            </div>
        </main>
    );
}
