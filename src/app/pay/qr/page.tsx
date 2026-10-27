/**
 * /pay/qr — QR-scan landing page (W5 D6).
 *
 * Reached by /pay form submission when createOrder returns a `qrCode`
 * (easypay → zpayz). Renders the QR image + amount + scan instructions
 * for the customer's phone.
 *
 * Server component — reads the order from prisma directly (rather than
 * trusting query-param values) so we can:
 *   1. Verify the qrCode field is actually populated (defensive against
 *      direct URL access without going through /pay flow)
 *   2. Render the canonical amount from DB (not query-spoofable)
 *   3. Sit the polling client component on top
 */
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getLocale } from '@/lib/i18n/server';
import { pickMessages } from '@/lib/i18n';
import { payMessages } from '@/lib/i18n/messages/pay';
import { QrPollRunner } from './qr-runner';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
    const m = pickMessages(payMessages, await getLocale());
    return { title: m.qr.pageTitle };
}

const containerStyle: React.CSSProperties = {
    minHeight: '100vh',
    background: '#f5f7fa',
    padding: '24px 16px',
    display: 'flex',
    justifyContent: 'center',
};
const cardStyle: React.CSSProperties = {
    maxWidth: 420,
    width: '100%',
    background: '#fff',
    border: '1px solid #e5e8ee',
    borderRadius: 8,
    padding: '28px 24px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
    color: '#1a2540',
    textAlign: 'center',
};

export default async function PayQrPage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = (await searchParams) ?? {};
    const orderId = typeof params.orderId === 'string' ? params.orderId : null;
    const accessToken = typeof params.t === 'string' ? params.t : null;

    if (!orderId) {
        redirect('/pay');
    }

    const m = pickMessages(payMessages, await getLocale()).qr;

    const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
            id: true,
            amount: true,
            paymentType: true,
            qrCode: true,
            status: true,
        },
    });

    if (!order) {
        return (
            <main style={containerStyle}>
                <div style={cardStyle}>
                    <h1 style={{ margin: 0, fontSize: 18, color: 'var(--color-status-error-text)' }}>
                        {m.notFoundTitle}
                    </h1>
                    <p style={{ margin: '12px 0 16px', fontSize: 13, color: '#5a6478' }}>{m.notFoundBody}</p>
                    <Link href="/pay" style={{ color: '#0a1535' }}>
                        {m.backToPay}
                    </Link>
                </div>
            </main>
        );
    }

    if (!order.qrCode) {
        // Either createOrder failed at the gateway (no QR returned) or the
        // user landed here via a direct link to a stripe / alipay_direct
        // order that doesn't use QR flow.
        return (
            <main style={containerStyle}>
                <div style={cardStyle}>
                    <h1 style={{ margin: 0, fontSize: 18, color: 'var(--color-status-error-text)' }}>
                        {m.mismatchTitle}
                    </h1>
                    <p style={{ margin: '12px 0 16px', fontSize: 13, color: '#5a6478' }}>{m.mismatchBody}</p>
                    <Link href="/pay" style={{ color: '#0a1535' }}>
                        {m.backToPay}
                    </Link>
                </div>
            </main>
        );
    }

    // If status already terminal, skip the QR render and bounce.
    if (order.status === 'COMPLETED') redirect('/balance');

    const typeLabel = m.providers[order.paymentType] ?? order.paymentType;
    const amountDisplay = `¥${Number(order.amount).toFixed(2)}`;

    return (
        <main style={containerStyle}>
            <div style={cardStyle}>
                <h1 style={{ margin: '0 0 4px', fontSize: 18, color: '#0a1535' }}>{m.heading(typeLabel)}</h1>
                <p style={{ margin: '0 0 20px', fontSize: 13, color: '#5a6478' }}>{m.instruction(typeLabel)}</p>

                <div
                    style={{
                        display: 'inline-block',
                        padding: 12,
                        border: '1px solid #e5e8ee',
                        borderRadius: 8,
                        background: '#fff',
                    }}
                >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={order.qrCode}
                        alt={m.qrAlt}
                        width={240}
                        height={240}
                        style={{ display: 'block', width: 240, height: 240, objectFit: 'contain' }}
                    />
                </div>

                <p
                    style={{
                        margin: '16px 0 4px',
                        fontSize: 24,
                        fontWeight: 600,
                        color: '#0a1535',
                        fontVariantNumeric: 'tabular-nums',
                    }}
                >
                    {amountDisplay}
                </p>
                <p
                    style={{
                        margin: 0,
                        fontSize: 12,
                        color: '#8a92a4',
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    }}
                >
                    {m.orderNo} {order.id.slice(0, 12)}…
                </p>

                {/* Client-side runner polls /api/orders/[id]?t=… every 3s
                 *  and redirects on COMPLETED or 15-min timeout. Renders
                 *  the live status text below. */}
                <QrPollRunner orderId={order.id} accessToken={accessToken} />

                <div
                    style={{
                        marginTop: 20,
                        paddingTop: 16,
                        borderTop: '1px solid #e5e8ee',
                        fontSize: 12,
                        color: '#5a6478',
                    }}
                >
                    {m.footer(typeLabel)}
                </div>
            </div>
        </main>
    );
}
