'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { resolveLocale, type Locale } from '@/lib/locale';

interface Withdrawal {
    id: string;
    tenant_id: string;
    amount_cny: string;
    status: 'pending' | 'paid' | 'rejected';
    note: string | null;
    admin_note: string | null;
    created_at: string;
    processed_at: string | null;
    tenant: { brand_name: string; slug: string };
}

const STATUSES = ['pending', 'paid', 'rejected', 'all'] as const;
type StatusFilter = (typeof STATUSES)[number];

function getTexts(locale: Locale) {
    return locale === 'en'
        ? {
              sessionExpired: 'Your session has expired (superadmin only).',
              title: 'Partner Withdrawals',
              subtitle: 'Approve payouts for white-label partners. Marking paid clears the held amount; rejecting returns it to the balance.',
              loading: 'Loading...',
              none: 'No withdrawal requests',
              colTenant: 'Partner',
              colAmount: 'Amount',
              colNote: 'Payout info',
              colStatus: 'Status',
              colTime: 'Requested',
              colActions: 'Actions',
              markPaid: 'Mark paid',
              reject: 'Reject',
              status: { pending: 'Pending', paid: 'Paid', rejected: 'Rejected', all: 'All' },
              notePrompt: 'Admin note (optional):',
              paidMsg: 'Marked as paid.',
              rejectedMsg: 'Rejected; the amount returned to the partner balance.',
              failed: 'Operation failed',
          }
        : {
              sessionExpired: '登录已过期（仅超级管理员）。',
              title: '代理提现',
              subtitle: '审核白标代理的提现申请。标记已打款即清掉冻结金额；驳回则退回代理可用余额。',
              loading: '加载中…',
              none: '暂无提现申请',
              colTenant: '代理',
              colAmount: '金额',
              colNote: '收款信息',
              colStatus: '状态',
              colTime: '申请时间',
              colActions: '操作',
              markPaid: '标记已打款',
              reject: '驳回',
              status: { pending: '待处理', paid: '已打款', rejected: '已驳回', all: '全部' },
              notePrompt: '处理备注（可选）：',
              paidMsg: '已标记为打款完成。',
              rejectedMsg: '已驳回，金额已退回代理余额。',
              failed: '操作失败',
          };
}

const STATUS_CLS: Record<Withdrawal['status'], string> = {
    pending: 'text-amber-600',
    paid: 'text-emerald-600',
    rejected: 'text-slate-400',
};

function WithdrawalsContent() {
    const searchParams = useSearchParams();
    const locale = resolveLocale(searchParams.get('lang'));
    const isDark = searchParams.get('theme') === 'dark';
    const t = getTexts(locale);
    const [status, setStatus] = useState<StatusFilter>('pending');
    const [rows, setRows] = useState<Withdrawal[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState<string | null>(null);

    const fetchRows = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch(`/api/admin/partner-withdrawals?status=${status}`, { credentials: 'same-origin' });
            if (res.status === 401 || res.status === 403) {
                setError(t.sessionExpired);
                return;
            }
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(data.message || data.error || t.failed);
                return;
            }
            setRows(data.withdrawals ?? []);
        } catch {
            setError(t.failed);
        } finally {
            setLoading(false);
        }
    }, [status, t.sessionExpired, t.failed]);

    useEffect(() => {
        void fetchRows();
    }, [fetchRows]);

    const process = async (row: Withdrawal, action: 'paid' | 'reject') => {
        const adminNote = window.prompt(t.notePrompt) ?? undefined;
        setBusy(row.id);
        setError('');
        setNotice('');
        try {
            const res = await fetch(`/api/admin/partner-withdrawals/${row.id}`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, admin_note: adminNote?.trim() || undefined }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(data.message || data.error || t.failed);
                return;
            }
            setNotice(action === 'paid' ? t.paidMsg : t.rejectedMsg);
            await fetchRows();
        } catch {
            setError(t.failed);
        } finally {
            setBusy(null);
        }
    };

    const inputCls = 'rounded-lg border px-3 py-1.5 text-xs';
    const card = isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white';
    const text = isDark ? 'text-slate-100' : 'text-slate-900';
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';

    return (
        <div className="mx-auto w-full max-w-5xl space-y-4 p-6">
            <div>
                <h1 className={`text-2xl font-bold ${text}`}>{t.title}</h1>
                <p className={`mt-1 text-sm ${muted}`}>{t.subtitle}</p>
            </div>

            <div className="flex flex-wrap gap-2">
                {STATUSES.map((value) => (
                    <button
                        key={value}
                        type="button"
                        onClick={() => setStatus(value)}
                        className={[
                            inputCls,
                            value === status
                                ? 'border-transparent bg-slate-700 text-white'
                                : isDark
                                  ? 'border-slate-600 text-slate-300 hover:bg-slate-700'
                                  : 'border-slate-200 text-slate-600 hover:bg-slate-100',
                        ].join(' ')}
                    >
                        {t.status[value]}
                    </button>
                ))}
            </div>

            {error && (
                <div className={`rounded-lg border p-3 text-sm ${isDark ? 'border-red-800 bg-red-950/50 text-red-400' : 'border-red-200 bg-red-50 text-red-600'}`}>
                    {error}
                </div>
            )}
            {notice && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>
            )}

            <div className={`overflow-x-auto rounded-xl border ${card}`}>
                {loading ? (
                    <div className={`py-8 text-center text-sm ${muted}`}>{t.loading}</div>
                ) : rows.length === 0 ? (
                    <div className={`py-8 text-center text-sm ${muted}`}>{t.none}</div>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className={`border-b ${isDark ? 'border-slate-700 text-slate-400' : 'border-slate-200 text-slate-500'}`}>
                                <th className="px-3 py-2 text-left font-medium">{t.colTenant}</th>
                                <th className="px-3 py-2 text-right font-medium">{t.colAmount}</th>
                                <th className="px-3 py-2 text-left font-medium">{t.colNote}</th>
                                <th className="px-3 py-2 text-right font-medium">{t.colStatus}</th>
                                <th className="px-3 py-2 text-right font-medium">{t.colTime}</th>
                                <th className="px-3 py-2 text-right font-medium">{t.colActions}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => (
                                <tr key={row.id} className={`border-b last:border-0 ${isDark ? 'border-slate-700/50' : 'border-slate-100'}`}>
                                    <td className={`px-3 py-2 ${text}`}>
                                        {row.tenant.brand_name}
                                        <span className={`ml-1 font-mono text-xs ${muted}`}>{row.tenant.slug}</span>
                                    </td>
                                    <td className={`px-3 py-2 text-right font-mono ${text}`}>¥{Number(row.amount_cny).toFixed(2)}</td>
                                    <td className={`max-w-[220px] truncate px-3 py-2 text-xs ${muted}`} title={row.note ?? ''}>
                                        {row.note ?? '—'}
                                    </td>
                                    <td className={`px-3 py-2 text-right text-xs ${STATUS_CLS[row.status]}`}>{t.status[row.status]}</td>
                                    <td className={`px-3 py-2 text-right text-xs ${muted}`}>
                                        {new Date(row.created_at).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', { timeZone: 'Asia/Shanghai' })}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                        {row.status === 'pending' && (
                                            <>
                                                <button
                                                    type="button"
                                                    disabled={busy === row.id}
                                                    onClick={() => process(row, 'paid')}
                                                    className="text-xs text-emerald-600 hover:underline disabled:opacity-50"
                                                >
                                                    {t.markPaid}
                                                </button>
                                                <button
                                                    type="button"
                                                    disabled={busy === row.id}
                                                    onClick={() => process(row, 'reject')}
                                                    className="ml-2 text-xs text-red-500 hover:underline disabled:opacity-50"
                                                >
                                                    {t.reject}
                                                </button>
                                            </>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}

export default function PartnerWithdrawalsPage() {
    return (
        <Suspense fallback={null}>
            <WithdrawalsContent />
        </Suspense>
    );
}
