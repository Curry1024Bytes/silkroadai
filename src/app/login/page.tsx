/**
 * Minimal portal login UI. Server component verifies that the visitor isn't
 * already logged in (in which case we send them on to /dashboard or wherever
 * the next= param requested), then mounts the client form.
 *
 * W4-2 D7 amend: default landing flipped from /pay → /dashboard now that the
 * authenticated route group exists. /pay still works (legitimate `next=`
 * targets are honored as long as they pass safeNext) — only the *default*
 * fallback changed.
 *
 * W7 P2 visual rebrand: warm-paper backdrop + brand-accent left rail on the
 * card matches the landing page so the auth handoff is continuous. Form
 * primitives (Input / Label / Button / FormError) are imported from
 * `@/components/ui/`.
 */
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { Card } from '@/components/ui/Card';
import { FormError } from '@/components/ui/FormError';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { getLocale } from '@/lib/i18n/server';
import { pickMessages } from '@/lib/i18n';
import { authMessages } from '@/lib/i18n/messages/auth';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
    const m = pickMessages(authMessages, await getLocale());
    return { title: m.login.pageTitle };
}

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

    const locale = await getLocale();
    const m = pickMessages(authMessages, locale);

    // Friendly copy for known OAuth callback error codes; unknown codes are
    // shown truncated so a long/garbage query value can't blow up the banner.
    const oauthMessage = oauthError
        ? (m.login.oauthErrors[oauthError] ??
          m.login.oauthGenericError(oauthError.length > 60 ? oauthError.slice(0, 60) + '…' : oauthError))
        : null;

    return (
        <main className="min-h-screen flex items-center justify-center bg-paper px-4 py-10">
            <Card className="w-full max-w-md p-8">
                <header className="mb-6 flex items-center gap-3">
                    <BrandLogo variant="primary-flat" size={28} />
                    <p className="m-0 text-xs text-minor-ink">Connecting Global Intelligence.</p>
                    <LocaleSwitcher className="ml-auto" />
                </header>
                <h2 className="m-0 mb-4 text-base font-semibold text-navy">{m.login.heading}</h2>
                {oauthMessage ? (
                    <div className="mb-4">
                        <FormError severity="banner">{oauthMessage}</FormError>
                    </div>
                ) : null}
                <Suspense fallback={<p className="text-sm text-muted-ink">{m.loading}</p>}>
                    <LoginForm next={next} />
                </Suspense>
            </Card>
        </main>
    );
}
