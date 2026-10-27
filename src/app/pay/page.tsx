/**
 * Portal /pay page — replaces the W1 Sub2API iframe-embedded UI (now at
 * page.legacy.tsx, kept for reference). Server-side gate: must have a valid
 * silkroad_session cookie, otherwise we redirect to /login.
 *
 * The form itself is a client component for interactivity (tier picker +
 * provider radio + submit button posts JSON to /api/orders, which redirects
 * to the gateway via window.location).
 *
 * W7 P2 visual: paper backdrop + Card, mirroring /login. Tier buttons +
 * provider radio cards in `pay-form.tsx` use design tokens.
 */
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getEnabledPaymentTypes } from '@/lib/payment/resolve-enabled-types';
import { Logo } from '@/components/brand/Logo';
import { Card } from '@/components/ui/Card';
import { getLocale } from '@/lib/i18n/server';
import { LocaleProvider } from '@/lib/i18n/client';
import { parseLocale, pickMessages } from '@/lib/i18n';
import { payMessages } from '@/lib/i18n/messages/pay';
import { PayForm } from './pay-form';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
    const m = pickMessages(payMessages, await getLocale());
    return { title: m.pay.pageTitle };
}

/** Bridge: getCurrentUser expects a NextRequest, but a server component only
 *  has the request via `headers()`. Reconstruct a thin NextRequest carrying
 *  just the cookie header so the helper can read silkroad_session. */
async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const fakeUrl = 'http://internal/pay';
    const req = new NextRequest(fakeUrl, { method: 'GET', headers: { cookie } });
    return getCurrentUser(req);
}

export default async function PayPage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = (await searchParams) ?? {};
    const user = await getSessionUser();
    if (!user) {
        // Forward any error/lang query so /login can surface a banner if needed.
        const qs = new URLSearchParams();
        qs.set('next', '/pay');
        for (const [k, v] of Object.entries(params)) {
            if (typeof v === 'string') qs.set(k, v);
        }
        redirect(`/login?${qs.toString()}`);
    }

    // Legacy W1 pay links carried `?lang=en`; honour it over the cookie for
    // this page only so old bookmarks / gateway return paths keep working.
    const locale = parseLocale(typeof params.lang === 'string' ? params.lang : null) ?? (await getLocale());
    const m = pickMessages(payMessages, locale).pay;

    // Enabled payment providers come from the registry filtered by the DB
    // ENABLED_PAYMENT_TYPES config. May be empty if env not configured (the
    // form handles that case with a clear message).
    let enabledTypes: string[] = [];
    try {
        enabledTypes = await getEnabledPaymentTypes();
    } catch (err) {
        console.warn('[pay] getEnabledPaymentTypes failed (rendering empty list):', err);
    }

    return (
        <main className="min-h-screen bg-paper px-4 py-8 flex justify-center">
            <Card className="w-full max-w-lg p-8">
                <header className="mb-6 flex items-center gap-3">
                    <Logo variant="primary-flat" size={28} />
                    <p className="m-0 text-xs text-minor-ink">Connecting Global Intelligence.</p>
                </header>
                <h2 className="m-0 mb-4 text-base font-semibold text-navy">{m.heading}</h2>
                <p className="m-0 mb-5 text-sm text-muted-ink">
                    {m.loggedInAs}
                    <strong className="text-navy">{user.email}</strong>
                </p>
                {/* Re-provide the locale so the client island follows the
                 *  `?lang=` override too (root layout only knows the cookie). */}
                <LocaleProvider locale={locale}>
                    <PayForm enabledPaymentTypes={enabledTypes} />
                </LocaleProvider>
                {/* 充值失败求助入口:第三方支付网关偶发超时(易支付网关侧问题),
                 *  给客户一个人工兜底渠道。文案与微信号按 operator 提供的原样展示,
                 *  微信号 select-all 方便一键复制。 */}
                <p className="m-0 mt-6 pt-4 border-t border-brand-border text-center text-xs text-muted-ink">
                    {m.helpBefore}
                    <span className="font-medium text-navy select-all">{m.helpWechat}</span>
                </p>
            </Card>
        </main>
    );
}
