/**
 * Portal /pay page — replaces the W1 Sub2API iframe-embedded UI (now at
 * page.legacy.tsx, kept for reference). Server-side gate: must have a valid
 * silkroad_session cookie, otherwise we redirect to /login.
 *
 * The form itself is a client component for interactivity (tier picker +
 * provider radio + submit button posts JSON to /api/orders, which redirects
 * to the gateway via window.location).
 */
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getEnabledPaymentTypes } from '@/lib/payment/resolve-enabled-types';
import { PayForm } from './pay-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: '充值 — Silk Road AI' };

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
    const user = await getSessionUser();
    if (!user) {
        // Forward any error/lang query so /login can surface a banner if needed.
        const params = (await searchParams) ?? {};
        const qs = new URLSearchParams();
        qs.set('next', '/pay');
        for (const [k, v] of Object.entries(params)) {
            if (typeof v === 'string') qs.set(k, v);
        }
        redirect(`/login?${qs.toString()}`);
    }

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
        <main
            style={{
                minHeight: '100vh',
                background: '#f5f7fa',
                padding: 24,
                display: 'flex',
                justifyContent: 'center',
            }}
        >
            <div
                style={{
                    maxWidth: 480,
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
                <h2 style={{ fontSize: 16, color: '#0a1535', margin: '0 0 16px' }}>账户充值</h2>
                <p style={{ fontSize: 13, color: '#5a6478', margin: '0 0 20px' }}>
                    登录账户:<strong>{user.email}</strong>
                </p>
                <PayForm enabledPaymentTypes={enabledTypes} />
            </div>
        </main>
    );
}
