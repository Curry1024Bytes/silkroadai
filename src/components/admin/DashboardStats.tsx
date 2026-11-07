'use client';

import type { Locale } from '@/lib/locale';

interface Summary {
    today: { amount: number; orderCount: number; paidCount: number };
    total: { amount: number; orderCount: number; paidCount: number };
    subscriptionToday?: { amount: number; orderCount: number; paidCount: number };
    subscriptionTotal?: { amount: number; orderCount: number; paidCount: number };
    successRate: number;
    avgAmount: number;
    /** 工单 SLA(PR3);接口失败为 null / 缺省不渲染。 */
    tickets?: {
        open: number;
        waitingCustomer: number;
        breachedFirstReply: number;
        breachedResolve: number;
        firstReplyHours: number;
        resolveHours: number;
        oldestOpenHours: number;
    } | null;
}

interface DashboardStatsProps {
    summary: Summary;
    dark?: boolean;
    locale?: Locale;
}

export default function DashboardStats({ summary, dark, locale = 'zh' }: DashboardStatsProps) {
    const currency = locale === 'en' ? '$' : '¥';
    const cards = [
        {
            label: locale === 'en' ? 'Today Recharge' : '今日充值',
            value: `${currency}${summary.today.amount.toLocaleString()}`,
            accent: true,
        },
        {
            label: locale === 'en' ? 'Today Orders' : '今日订单',
            value: `${summary.today.paidCount}/${summary.today.orderCount}`,
        },
        {
            label: locale === 'en' ? 'Total Recharge' : '累计充值',
            value: `${currency}${summary.total.amount.toLocaleString()}`,
            accent: true,
        },
        { label: locale === 'en' ? 'Paid Orders' : '累计订单', value: String(summary.total.paidCount) },
        { label: locale === 'en' ? 'Success Rate' : '成功率', value: `${summary.successRate}%` },
        { label: locale === 'en' ? 'Average Amount' : '平均充值', value: `${currency}${summary.avgAmount.toFixed(2)}` },
    ];

    // Conditionally add subscription cards if subscription data exists
    const hasSub =
        summary.subscriptionToday &&
        summary.subscriptionTotal &&
        (summary.subscriptionToday.amount > 0 ||
            summary.subscriptionTotal.amount > 0 ||
            summary.subscriptionToday.orderCount > 0 ||
            summary.subscriptionTotal.orderCount > 0);

    if (hasSub) {
        cards.push(
            {
                label: locale === 'en' ? 'Subscription Revenue Today' : '今日订阅收入',
                value: `${currency}${summary.subscriptionToday!.amount.toLocaleString()}`,
                accent: true,
            },
            {
                label: locale === 'en' ? 'Total Subscription Revenue' : '订阅总收入',
                value: `${currency}${summary.subscriptionTotal!.amount.toLocaleString()}`,
                accent: true,
            },
        );
    }

    if (summary.tickets) {
        const t = summary.tickets;
        cards.push(
            {
                label: locale === 'en' ? 'Open tickets' : '待处理工单',
                value: `${t.open}${t.waitingCustomer ? ` (+${t.waitingCustomer} ${locale === 'en' ? 'waiting' : '等客户'})` : ''}`,
                accent: t.open > 0,
            },
            {
                label: locale === 'en' ? `No first reply > ${t.firstReplyHours}h` : `超 ${t.firstReplyHours}h 未首复`,
                value: String(t.breachedFirstReply),
                accent: t.breachedFirstReply > 0,
            },
            {
                label: locale === 'en' ? `Unresolved > ${t.resolveHours}h` : `超 ${t.resolveHours}h 未解决`,
                value: String(t.breachedResolve),
                accent: t.breachedResolve > 0,
            },
        );
    }

    return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {cards.map((card) => (
                <div
                    key={card.label}
                    className={[
                        'rounded-xl border p-4',
                        dark ? 'border-slate-700 bg-slate-800/60' : 'border-slate-200 bg-white shadow-sm',
                    ].join(' ')}
                >
                    <p className={['text-xs font-medium', dark ? 'text-slate-400' : 'text-slate-500'].join(' ')}>
                        {card.label}
                    </p>
                    <p
                        className={[
                            'mt-1 text-xl font-semibold tracking-tight',
                            card.accent
                                ? dark
                                    ? 'text-indigo-400'
                                    : 'text-indigo-600'
                                : dark
                                  ? 'text-slate-100'
                                  : 'text-slate-900',
                        ].join(' ')}
                    >
                        {card.value}
                    </p>
                </div>
            ))}
        </div>
    );
}
