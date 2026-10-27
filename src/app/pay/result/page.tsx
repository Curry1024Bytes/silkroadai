/**
 * /pay/result — easy-pay (and any other gateway) return-URL landing page.
 *
 * This route is referenced by `buildOrderResultUrl` (W4-1 D2) which hands
 * easypay a returnUrl shaped `?order_id=X&t=Y`. After the user pays, easypay
 * redirects them here. The async webhook (`/api/easy-pay/notify`) is what
 * actually credits the balance; this page is just the "we got you back"
 * confirmation. By the time the user lands here the webhook may or may not
 * have fired yet — we render based on Order.status as it stands now and
 * gently warn that balance refresh can lag up to 60s (the W4-2 D6 cache TTL).
 *
 * W5 D2 rewrite: replaces the 347-line W1 client component (Tailwind +
 * polling /api/order-status) with a minimal server component matching the
 * rest of the W4 portal style. The polling UX was for embedded sub2apipay
 * iframes; W4-1 D2 portal users land here in their own tab and a static
 * snapshot is enough.
 */
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getLocale } from '@/lib/i18n/server';
import { pickMessages } from '@/lib/i18n';
import { payMessages } from '@/lib/i18n/messages/pay';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
    const m = pickMessages(payMessages, await getLocale());
    return { title: m.result.pageTitle };
}

const containerStyle: React.CSSProperties = {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f5f7fa',
    padding: 24,
};
const cardStyle: React.CSSProperties = {
    maxWidth: 460,
    width: '100%',
    background: '#fff',
    padding: 32,
    borderRadius: 8,
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    color: '#1a2540',
};
const buttonStyle: React.CSSProperties = {
    display: 'inline-block',
    marginTop: 16,
    background: '#0a1535',
    color: '#fff',
    padding: '8px 16px',
    borderRadius: 4,
    fontSize: 13,
    textDecoration: 'none',
};

export default async function PayResultPage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = (await searchParams) ?? {};
    // Accept either `order_id` (W4-1 D2 buildOrderResultUrl shape) or
    // `out_trade_no` (legacy gateway field). The W4 portal sends order_id;
    // direct-from-gateway redirects sometimes carry out_trade_no.
    const orderIdRaw = params.order_id ?? params.out_trade_no;
    const orderId = typeof orderIdRaw === 'string' ? orderIdRaw : null;
    const m = pickMessages(payMessages, await getLocale()).result;

    if (!orderId) {
        return (
            <main style={containerStyle}>
                <div style={cardStyle}>
                    <h1 style={{ margin: 0, fontSize: 18, color: '#0a1535' }}>{m.invalidTitle}</h1>
                    <p style={{ margin: '12px 0 0', fontSize: 13, color: '#5a6478' }}>{m.invalidBody}</p>
                    <Link href="/" style={buttonStyle}>
                        {m.backHome}
                    </Link>
                </div>
            </main>
        );
    }

    const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, amount: true },
    });

    if (!order) {
        return (
            <main style={containerStyle}>
                <div style={cardStyle}>
                    <h1 style={{ margin: 0, fontSize: 18, color: 'var(--color-status-error-text)' }}>
                        {m.notFoundTitle}
                    </h1>
                    <p style={{ margin: '12px 0 0', fontSize: 13, color: '#5a6478' }}>{m.notFoundBody}</p>
                    <Link href="/" style={buttonStyle}>
                        {m.backHome}
                    </Link>
                </div>
            </main>
        );
    }

    const success = order.status === 'COMPLETED';
    const processing = order.status === 'PAID' || order.status === 'RECHARGING';
    const amount = `¥${Number(order.amount).toFixed(2)}`;

    return (
        <main style={containerStyle}>
            <div style={cardStyle}>
                <h1
                    style={{
                        margin: 0,
                        fontSize: 18,
                        color: success
                            ? 'var(--color-status-success-text)'
                            : processing
                              ? 'var(--color-navy)'
                              : 'var(--color-status-error-text)',
                    }}
                >
                    {success ? m.successTitle : processing ? m.processingTitle : m.abnormalTitle}
                </h1>
                <p style={{ margin: '12px 0 0', fontSize: 13, color: '#5a6478' }}>
                    {success ? m.successBody(amount) : processing ? m.processingBody(amount) : m.abnormalBody}
                </p>
                <Link href={success || processing ? '/balance' : '/'} style={buttonStyle}>
                    {success || processing ? m.backToBalance : m.backHome}
                </Link>
            </div>
        </main>
    );
}
