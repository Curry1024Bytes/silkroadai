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

export const dynamic = 'force-dynamic';
export const metadata = { title: '支付结果 — Silk Road AI' };

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

    if (!orderId) {
        return (
            <main style={containerStyle}>
                <div style={cardStyle}>
                    <h1 style={{ margin: 0, fontSize: 18, color: '#0a1535' }}>访问无效</h1>
                    <p style={{ margin: '12px 0 0', fontSize: 13, color: '#5a6478' }}>
                        缺少订单参数。
                    </p>
                    <Link href="/" style={buttonStyle}>返回首页</Link>
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
                    <h1 style={{ margin: 0, fontSize: 18, color: 'var(--color-status-error-text)' }}>订单异常</h1>
                    <p style={{ margin: '12px 0 0', fontSize: 13, color: '#5a6478' }}>
                        未找到该订单。如已付款请联系客服:微信 Globe_Ads。
                    </p>
                    <Link href="/" style={buttonStyle}>返回首页</Link>
                </div>
            </main>
        );
    }

    const success = order.status === 'COMPLETED';
    const processing = order.status === 'PAID' || order.status === 'RECHARGING';

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
                    {success ? '付款成功' : processing ? '付款已收到,处理中' : '订单异常'}
                </h1>
                <p style={{ margin: '12px 0 0', fontSize: 13, color: '#5a6478' }}>
                    {success
                        ? `¥${Number(order.amount).toFixed(2)} 已到账,余额刷新可能延迟最多 60 秒。`
                        : processing
                          ? `¥${Number(order.amount).toFixed(2)} 已确认,正在到账,通常几秒内完成。`
                          : '订单状态异常,如已付款请联系客服:微信 Globe_Ads。'}
                </p>
                <Link
                    href={success || processing ? '/balance' : '/'}
                    style={buttonStyle}
                >
                    {success || processing ? '返回 /balance' : '返回首页'}
                </Link>
            </div>
        </main>
    );
}
