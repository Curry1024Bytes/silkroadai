/**
 * /balance — current quota + recent recharge history.
 *
 * Server component:
 *   1. Get session user (layout already gated; we just need user.id).
 *   2. getQuotaWithCache(user.id) — 60s row cache backed by new-api getUser.
 *   3. prisma.rechargeLog.findMany — last 10 entries (W4-1 D1 design: row
 *      existence == success, no `status` field).
 *
 * UI shows CNY-converted figures (raw quota is implementation detail not
 * meaningful to customers). USD equivalent rendered as small subtitle.
 *
 * "fallback" source path renders a soft banner so the customer knows the
 * data may be stale (new-api unreachable but stale cache available).
 */
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { getQuotaWithCache, type QuotaSnapshot } from '@/lib/newapi/quota-cache';
import { quotaToCny, quotaToUsd } from '@/lib/newapi/client';

export const dynamic = 'force-dynamic';
export const metadata = { title: '余额 — Silk Road AI' };

const HISTORY_LIMIT = 10;

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/balance', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

const SOURCE_LABEL: Record<string, string> = {
    payment: '在线支付',
    manual: '管理员充值',
    refund: '退款',
    promo: '推广奖励',
    adjustment: '余额调整',
};

const cardStyle: React.CSSProperties = {
    background: '#fff',
    border: '1px solid #e5e8ee',
    borderRadius: 6,
    padding: 20,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
};

export default async function BalancePage() {
    const user = await getSessionUser();
    if (!user) return null;

    let snapshot: QuotaSnapshot | null = null;
    let snapshotErr: string | null = null;
    try {
        snapshot = await getQuotaWithCache(user.id);
    } catch (err) {
        snapshotErr = err instanceof Error ? err.message : String(err);
    }

    const history = await prisma.rechargeLog.findMany({
        where: { user_id: user.id },
        orderBy: { created_at: 'desc' },
        take: HISTORY_LIMIT,
        select: {
            id: true,
            order_id: true,
            amount: true,
            source: true,
            created_at: true,
        },
    });

    return (
        <section>
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    marginBottom: 20,
                }}
            >
                <div>
                    <h1 style={{ margin: '0 0 8px', fontSize: 22, color: '#0a1535' }}>余额</h1>
                    <p style={{ margin: 0, fontSize: 13, color: '#5a6478' }}>
                        实时余额与充值流水。
                    </p>
                </div>
                <Link
                    href="/pay"
                    style={{
                        background: '#0a1535',
                        color: '#fff',
                        padding: '8px 16px',
                        borderRadius: 4,
                        fontSize: 13,
                        textDecoration: 'none',
                    }}
                >
                    + 充值
                </Link>
            </div>

            {snapshot?.source === 'fallback' && (
                <div
                    role="status"
                    style={{
                        background: '#fff8e1',
                        border: '1px solid #f0d785',
                        color: '#7a5d00',
                        padding: '8px 12px',
                        borderRadius: 4,
                        marginBottom: 16,
                        fontSize: 12,
                    }}
                >
                    数据暂时不可更新,显示的是稍早数据。
                </div>
            )}

            {snapshotErr ? (
                <div
                    role="alert"
                    style={{
                        background: '#fdecea',
                        border: '1px solid #f0c6c2',
                        color: '#c44',
                        padding: '12px 14px',
                        borderRadius: 6,
                        marginBottom: 24,
                        fontSize: 13,
                    }}
                >
                    当前无法获取余额,请稍后重试。
                </div>
            ) : (
                <div
                    style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                        gap: 16,
                        marginBottom: 24,
                    }}
                >
                    <article style={cardStyle}>
                        <p style={{ margin: '0 0 6px', fontSize: 12, color: '#5a6478' }}>
                            可用余额
                        </p>
                        <p
                            style={{
                                margin: 0,
                                fontSize: 28,
                                color: '#0a1535',
                                fontWeight: 600,
                                fontVariantNumeric: 'tabular-nums',
                            }}
                        >
                            ¥{quotaToCny(snapshot!.remain_quota).toFixed(2)}
                        </p>
                        <p style={{ margin: '6px 0 0', fontSize: 11, color: '#8a92a4' }}>
                            ≈ ${quotaToUsd(snapshot!.remain_quota).toFixed(4)} USD ·{' '}
                            {snapshot!.remain_quota.toLocaleString('en-US')} quota
                        </p>
                    </article>
                    <article style={cardStyle}>
                        <p style={{ margin: '0 0 6px', fontSize: 12, color: '#5a6478' }}>
                            累计消费
                        </p>
                        <p
                            style={{
                                margin: 0,
                                fontSize: 28,
                                color: '#0a1535',
                                fontWeight: 600,
                                fontVariantNumeric: 'tabular-nums',
                            }}
                        >
                            ¥{quotaToCny(snapshot!.used_quota).toFixed(2)}
                        </p>
                        <p style={{ margin: '6px 0 0', fontSize: 11, color: '#8a92a4' }}>
                            ≈ ${quotaToUsd(snapshot!.used_quota).toFixed(4)} USD
                        </p>
                    </article>
                </div>
            )}

            <h2 style={{ margin: '0 0 12px', fontSize: 16, color: '#0a1535' }}>充值流水</h2>
            {history.length === 0 ? (
                <div
                    style={{
                        background: '#fff',
                        border: '1px dashed #e5e8ee',
                        borderRadius: 6,
                        padding: 32,
                        textAlign: 'center',
                        color: '#8a92a4',
                        fontSize: 13,
                    }}
                >
                    暂无充值记录,点击右上「+ 充值」开始。
                </div>
            ) : (
                <table
                    style={{
                        width: '100%',
                        background: '#fff',
                        border: '1px solid #e5e8ee',
                        borderRadius: 6,
                        borderCollapse: 'collapse',
                        overflow: 'hidden',
                    }}
                >
                    <thead>
                        <tr>
                            <th style={tableHeaderStyle}>金额(CNY)</th>
                            <th style={tableHeaderStyle}>类型</th>
                            <th style={tableHeaderStyle}>订单号</th>
                            <th style={tableHeaderStyle}>时间</th>
                        </tr>
                    </thead>
                    <tbody>
                        {history.map((row) => (
                            <tr key={row.id}>
                                <td
                                    style={{
                                        ...tableCellStyle,
                                        fontVariantNumeric: 'tabular-nums',
                                        fontWeight: 500,
                                    }}
                                >
                                    ¥{Number(row.amount).toFixed(2)}
                                </td>
                                <td style={tableCellStyle}>
                                    {SOURCE_LABEL[row.source] ?? row.source}
                                </td>
                                <td
                                    style={{
                                        ...tableCellStyle,
                                        fontFamily:
                                            'ui-monospace, SFMono-Regular, Menlo, monospace',
                                        fontSize: 12,
                                        color: '#5a6478',
                                    }}
                                >
                                    {row.order_id ? row.order_id.slice(0, 8) : '—'}
                                </td>
                                <td style={{ ...tableCellStyle, color: '#5a6478' }}>
                                    {row.created_at.toLocaleString('zh-CN')}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    );
}

const tableHeaderStyle: React.CSSProperties = {
    textAlign: 'left',
    padding: '8px 12px',
    fontSize: 12,
    color: '#5a6478',
    background: '#f5f7fa',
    borderBottom: '1px solid #e5e8ee',
};
const tableCellStyle: React.CSSProperties = {
    padding: '10px 12px',
    fontSize: 13,
    borderBottom: '1px solid #e5e8ee',
    color: '#1a2540',
};
