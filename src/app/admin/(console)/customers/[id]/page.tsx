'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useState, useEffect, useCallback, Suspense } from 'react';
import PayPageLayout from '@/components/PayPageLayout';
import { resolveLocale, type Locale } from '@/lib/locale';

// ── Types (mirror /api/admin/customers/[id]) ──
interface CustomerDetail {
    id: string;
    email: string;
    nickname: string | null;
    status: 'active' | 'disabled' | 'banned';
    created_at: string;
    last_login_at: string | null;
    balance_cny: number;
    used_cny: number;
    balance_cached_at: string | null;
}
interface KeyRow {
    id: string;
    key_alias: string;
    tier: string;
    status: 'active' | 'disabled' | 'expired';
    created_at: string;
}
interface ModelRow {
    model_slug: string;
    tier: string;
    calls: number;
    cost_cny: number;
}
interface RechargeRow {
    id: string;
    amount: number;
    source: 'payment' | 'manual' | 'refund' | 'promo' | 'adjustment';
    note: string | null;
    created_at: string;
}
interface LedgerEntryRow {
    id: string;
    kind: 'recharge' | 'charge' | 'adjustment' | 'migration';
    amount_cny: number;
    balance_after: number;
    ref: string | null;
    note: string | null;
    created_at: string;
}
interface DetailData {
    customer: CustomerDetail;
    keys: KeyRow[];
    usage_by_model: ModelRow[];
    recharges: RechargeRow[];
    ledger: { balance_cny: number; entries: LedgerEntryRow[] };
    usage_window_days: number;
}

function getTexts(locale: Locale) {
    return locale === 'en'
        ? {
              back: '← Customers',
              title: 'Customer',
              loading: 'Loading...',
              invalidToken: 'Session expired, please sign in again',
              notFound: 'Customer not found (or outside your tenant).',
              loadFailed: 'Failed to load customer',
              profile: 'Profile',
              email: 'Email',
              status: 'Status',
              joined: 'Joined',
              lastLogin: 'Last login',
              balance: 'Balance',
              used: 'Total used',
              never: 'never',
              active: 'active',
              disabled: 'disabled',
              banned: 'banned',
              keys: 'API keys',
              keysNote: 'Read-only — secret keys are never shown here.',
              colAlias: 'Alias',
              colTier: 'Tier',
              colKeyStatus: 'Status',
              colCreated: 'Created',
              noKeys: 'No keys.',
              usage: (d: number) => `Usage by model (last ${d}d)`,
              colModel: 'Model',
              colCalls: 'Calls',
              colCost: 'Cost ¥',
              noUsage: 'No usage in this window.',
              recharges: 'Recharge history',
              colAmount: 'Amount ¥',
              colSource: 'Source',
              colNote: 'Note',
              colTime: 'Time',
              noRecharges: 'No recharges.',
              srcPayment: 'payment',
              srcManual: 'manual',
              srcRefund: 'refund',
              srcPromo: 'promo',
              srcAdjustment: 'adjustment',
              ledgerTitle: 'Ledger balance (¥)',
              ledgerNote: "Portal's own ¥ ledger (P4c). Most customers have no entries yet.",
              ledgerBalance: 'Ledger balance',
              colKind: 'Type',
              colBalAfter: 'Balance after',
              noLedger: 'No ledger entries.',
              kindRecharge: 'recharge',
              kindCharge: 'charge',
              kindAdjustment: 'adjustment',
              kindMigration: 'migration',
              adjustAmountPh: 'Amount (+ credit / − debit)',
              adjustNotePh: 'Reason (required)',
              adjustSubmit: 'Apply',
              adjustingLabel: 'Applying...',
              adjustBadAmount: 'Enter a non-zero amount.',
              adjustBadNote: 'A reason is required.',
              adjustFailed: 'Adjustment failed',
          }
        : {
              back: '← 客户列表',
              title: '客户详情',
              loading: '加载中...',
              invalidToken: '登录已过期',
              notFound: '客户不存在(或不在你的租户内)。',
              loadFailed: '加载客户详情失败',
              profile: '基本信息',
              email: '邮箱',
              status: '状态',
              joined: '注册时间',
              lastLogin: '最近登录',
              balance: '余额',
              used: '累计消费',
              never: '从未',
              active: '正常',
              disabled: '已停用',
              banned: '已封禁',
              keys: 'API Key',
              keysNote: '只读 —— 此处不显示 key 明文。',
              colAlias: '别名',
              colTier: '档次',
              colKeyStatus: '状态',
              colCreated: '创建时间',
              noKeys: '暂无 key。',
              usage: (d: number) => `按模型用量(近 ${d} 天)`,
              colModel: '模型',
              colCalls: '调用',
              colCost: '消费 ¥',
              noUsage: '该时间窗内暂无用量。',
              recharges: '充值流水',
              colAmount: '金额 ¥',
              colSource: '来源',
              colNote: '备注',
              colTime: '时间',
              noRecharges: '暂无充值。',
              srcPayment: '支付到账',
              srcManual: '手动充值',
              srcRefund: '退款',
              srcPromo: '推广奖励',
              srcAdjustment: '余额调整',
              ledgerTitle: '¥账本余额',
              ledgerNote: 'portal 自有 ¥账本(P4c)。多数客户暂无记录。',
              ledgerBalance: '账本余额',
              colKind: '类型',
              colBalAfter: '记账后余额',
              noLedger: '暂无账本记录。',
              kindRecharge: '充值',
              kindCharge: '扣费',
              kindAdjustment: '调整',
              kindMigration: '迁移',
              adjustAmountPh: '金额(+ 充入 / − 扣减)',
              adjustNotePh: '调整原因(必填)',
              adjustSubmit: '提交调整',
              adjustingLabel: '提交中...',
              adjustBadAmount: '请输入非 0 金额。',
              adjustBadNote: '必须填写调整原因。',
              adjustFailed: '调整失败',
          };
}

const fmtCny = (n: number): string => `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
// gotcha #20: server TZ is UTC — pin Asia/Shanghai explicitly everywhere we render a time.
const fmtDate = (iso: string): string =>
    new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

function DetailContent() {
    const params = useParams<{ id: string }>();
    const id = params?.id;
    const searchParams = useSearchParams();
    const theme = searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const uiMode = searchParams.get('ui_mode') || 'standalone';
    const locale = resolveLocale(searchParams.get('lang'));
    const isDark = theme === 'dark';
    const isEmbedded = uiMode === 'embedded';
    const t = getTexts(locale);

    const backQs = new URLSearchParams();
    backQs.set('theme', theme);
    backQs.set('ui_mode', uiMode);
    if (locale !== 'zh') backQs.set('lang', locale);
    const backHref = `/admin/customers?${backQs.toString()}`;

    const [data, setData] = useState<DetailData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [notFound, setNotFound] = useState(false);

    const fetchData = useCallback(async (cid: string) => {
        setLoading(true);
        setError('');
        setNotFound(false);
        try {
            const res = await fetch(`/api/admin/customers/${cid}`);
            if (!res.ok) {
                if (res.status === 401) {
                    setError(t.invalidToken);
                    return;
                }
                if (res.status === 404) {
                    setNotFound(true);
                    return;
                }
                throw new Error();
            }
            setData((await res.json()) as DetailData);
        } catch {
            setError(t.loadFailed);
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (id) fetchData(id);
    }, [fetchData, id]);

    // ── P4c-1 余额调整(走 /balance-adjust → applyLedgerEntry,成功后重拉详情)──
    const [adjustAmount, setAdjustAmount] = useState('');
    const [adjustNote, setAdjustNote] = useState('');
    const [adjusting, setAdjusting] = useState(false);
    const [adjustError, setAdjustError] = useState('');

    const handleAdjust = async () => {
        const amount = Number(adjustAmount);
        if (!Number.isFinite(amount) || amount === 0) {
            setAdjustError(t.adjustBadAmount);
            return;
        }
        if (!adjustNote.trim()) {
            setAdjustError(t.adjustBadNote);
            return;
        }
        setAdjusting(true);
        setAdjustError('');
        try {
            const res = await fetch(`/api/admin/customers/${id}/balance-adjust`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount_cny: amount, note: adjustNote.trim() }),
            });
            if (!res.ok) {
                if (res.status === 401) {
                    setAdjustError(t.invalidToken);
                    return;
                }
                const d = await res.json().catch(() => ({}));
                setAdjustError(d.error || t.adjustFailed);
                return;
            }
            setAdjustAmount('');
            setAdjustNote('');
            if (id) fetchData(id);
        } catch {
            setAdjustError(t.adjustFailed);
        } finally {
            setAdjusting(false);
        }
    };

    const card = isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm';
    const tableWrap = ['overflow-x-auto rounded-xl border', card].join(' ');
    const thCls = `px-4 py-3 font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`;
    const rowBorder = isDark ? 'border-slate-700/50' : 'border-slate-100';
    const sectionTitle = `mb-2 text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`;
    const labelCls = `text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`;
    const valueCls = `text-sm ${isDark ? 'text-slate-100' : 'text-slate-900'}`;
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';

    const statusLabel = (s: CustomerDetail['status']) =>
        s === 'active' ? t.active : s === 'disabled' ? t.disabled : t.banned;
    const sourceLabel = (s: RechargeRow['source']) =>
        s === 'payment'
            ? t.srcPayment
            : s === 'manual'
              ? t.srcManual
              : s === 'refund'
                ? t.srcRefund
                : s === 'promo'
                  ? t.srcPromo
                  : t.srcAdjustment;
    const kindLabel = (k: LedgerEntryRow['kind']) =>
        k === 'recharge'
            ? t.kindRecharge
            : k === 'charge'
              ? t.kindCharge
              : k === 'adjustment'
                ? t.kindAdjustment
                : t.kindMigration;

    return (
        <PayPageLayout
            isDark={isDark}
            isEmbedded={isEmbedded}
            maxWidth="full"
            title={data ? data.customer.email : t.title}
            subtitle=""
            locale={locale}
            actions={
                <Link
                    href={backHref}
                    className={[
                        'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                        isDark
                            ? 'border-slate-600 text-slate-300 hover:bg-slate-800'
                            : 'border-slate-300 text-slate-700 hover:bg-slate-100',
                    ].join(' ')}
                >
                    {t.back}
                </Link>
            }
        >
            {error && (
                <div
                    className={`mb-4 rounded-lg border p-3 text-sm ${isDark ? 'border-red-800 bg-red-950/50 text-red-400' : 'border-red-200 bg-red-50 text-red-600'}`}
                >
                    {error}
                </div>
            )}

            {loading ? (
                <div className={`py-12 text-center ${muted}`}>{t.loading}</div>
            ) : notFound ? (
                <div className={`rounded-xl border p-12 text-center ${card} ${muted}`}>{t.notFound}</div>
            ) : !data ? null : (
                <div className="space-y-6">
                    {/* Profile */}
                    <div>
                        <div className={sectionTitle}>{t.profile}</div>
                        <div className={`grid grid-cols-2 gap-4 rounded-xl border p-4 sm:grid-cols-3 ${card}`}>
                            <div>
                                <div className={labelCls}>{t.email}</div>
                                <div className={valueCls}>{data.customer.email}</div>
                            </div>
                            <div>
                                <div className={labelCls}>{t.status}</div>
                                <div className={valueCls}>{statusLabel(data.customer.status)}</div>
                            </div>
                            <div>
                                <div className={labelCls}>{t.joined}</div>
                                <div className={valueCls}>{fmtDate(data.customer.created_at)}</div>
                            </div>
                            <div>
                                <div className={labelCls}>{t.lastLogin}</div>
                                <div className={valueCls}>
                                    {data.customer.last_login_at ? fmtDate(data.customer.last_login_at) : t.never}
                                </div>
                            </div>
                            <div>
                                <div className={labelCls}>{t.balance}</div>
                                <div className={valueCls}>{fmtCny(data.customer.balance_cny)}</div>
                            </div>
                            <div>
                                <div className={labelCls}>{t.used}</div>
                                <div className={valueCls}>{fmtCny(data.customer.used_cny)}</div>
                            </div>
                        </div>
                    </div>

                    {/* P4c-1 Ledger balance + adjust */}
                    <div>
                        <div className={sectionTitle}>{t.ledgerTitle}</div>
                        <div className={`mb-2 text-xs ${muted}`}>{t.ledgerNote}</div>
                        <div className={`rounded-xl border p-4 ${card}`}>
                            <div className="flex flex-wrap items-end justify-between gap-4">
                                <div>
                                    <div className={labelCls}>{t.ledgerBalance}</div>
                                    <div
                                        className={`text-2xl font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}
                                    >
                                        {fmtCny(data.ledger.balance_cny)}
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <input
                                        type="number"
                                        value={adjustAmount}
                                        onChange={(e) => setAdjustAmount(e.target.value)}
                                        placeholder={t.adjustAmountPh}
                                        className={`w-48 rounded-lg border px-3 py-1.5 text-sm ${isDark ? 'border-slate-600 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white text-slate-900'}`}
                                    />
                                    <input
                                        type="text"
                                        value={adjustNote}
                                        onChange={(e) => setAdjustNote(e.target.value)}
                                        placeholder={t.adjustNotePh}
                                        className={`w-56 rounded-lg border px-3 py-1.5 text-sm ${isDark ? 'border-slate-600 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white text-slate-900'}`}
                                    />
                                    <button
                                        type="button"
                                        onClick={handleAdjust}
                                        disabled={adjusting}
                                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
                                    >
                                        {adjusting ? t.adjustingLabel : t.adjustSubmit}
                                    </button>
                                </div>
                            </div>
                            {adjustError && (
                                <div className={`mt-3 text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                                    {adjustError}
                                </div>
                            )}
                            {data.ledger.entries.length === 0 ? (
                                <div className={`mt-4 text-sm ${muted}`}>{t.noLedger}</div>
                            ) : (
                                <div className={`mt-4 ${tableWrap}`}>
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className={`border-b ${rowBorder}`}>
                                                <th className={`${thCls} text-left`}>{t.colKind}</th>
                                                <th className={`${thCls} text-right`}>{t.colAmount}</th>
                                                <th className={`${thCls} text-right`}>{t.colBalAfter}</th>
                                                <th className={`${thCls} text-left`}>{t.colNote}</th>
                                                <th className={`${thCls} text-left`}>{t.colTime}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {data.ledger.entries.map((e) => (
                                                <tr key={e.id} className={`border-b ${rowBorder}`}>
                                                    <td className={`px-4 py-3 ${muted}`}>{kindLabel(e.kind)}</td>
                                                    <td
                                                        className={`px-4 py-3 text-right ${e.amount_cny < 0 ? (isDark ? 'text-red-400' : 'text-red-600') : isDark ? 'text-emerald-400' : 'text-emerald-600'}`}
                                                    >
                                                        {e.amount_cny >= 0 ? '+' : '−'}
                                                        {fmtCny(Math.abs(e.amount_cny))}
                                                    </td>
                                                    <td
                                                        className={`px-4 py-3 text-right ${isDark ? 'text-slate-200' : 'text-slate-800'}`}
                                                    >
                                                        {fmtCny(e.balance_after)}
                                                    </td>
                                                    <td className={`px-4 py-3 ${muted}`}>{e.note ?? '—'}</td>
                                                    <td className={`px-4 py-3 ${muted}`}>{fmtDate(e.created_at)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Keys */}
                    <div>
                        <div className={sectionTitle}>{t.keys}</div>
                        <div className={`mb-2 text-xs ${muted}`}>{t.keysNote}</div>
                        {data.keys.length === 0 ? (
                            <div className={`text-sm ${muted}`}>{t.noKeys}</div>
                        ) : (
                            <div className={tableWrap}>
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className={`border-b ${rowBorder}`}>
                                            <th className={`${thCls} text-left`}>{t.colAlias}</th>
                                            <th className={`${thCls} text-left`}>{t.colTier}</th>
                                            <th className={`${thCls} text-left`}>{t.colKeyStatus}</th>
                                            <th className={`${thCls} text-left`}>{t.colCreated}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.keys.map((k) => (
                                            <tr key={k.id} className={`border-b ${rowBorder}`}>
                                                <td
                                                    className={`px-4 py-3 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}
                                                >
                                                    {k.key_alias}
                                                </td>
                                                <td className={`px-4 py-3 ${muted}`}>{k.tier}</td>
                                                <td className={`px-4 py-3 ${muted}`}>{k.status}</td>
                                                <td className={`px-4 py-3 ${muted}`}>{fmtDate(k.created_at)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    {/* Usage by model */}
                    <div>
                        <div className={sectionTitle}>{t.usage(data.usage_window_days)}</div>
                        {data.usage_by_model.length === 0 ? (
                            <div className={`text-sm ${muted}`}>{t.noUsage}</div>
                        ) : (
                            <div className={tableWrap}>
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className={`border-b ${rowBorder}`}>
                                            <th className={`${thCls} text-left`}>{t.colModel}</th>
                                            <th className={`${thCls} text-left`}>{t.colTier}</th>
                                            <th className={`${thCls} text-right`}>{t.colCalls}</th>
                                            <th className={`${thCls} text-right`}>{t.colCost}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.usage_by_model.map((m) => (
                                            <tr key={`${m.model_slug}-${m.tier}`} className={`border-b ${rowBorder}`}>
                                                <td
                                                    className={`px-4 py-3 font-mono text-xs ${isDark ? 'text-slate-200' : 'text-slate-800'}`}
                                                >
                                                    {m.model_slug}
                                                </td>
                                                <td className={`px-4 py-3 ${muted}`}>{m.tier}</td>
                                                <td
                                                    className={`px-4 py-3 text-right ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
                                                >
                                                    {m.calls}
                                                </td>
                                                <td
                                                    className={`px-4 py-3 text-right ${isDark ? 'text-slate-200' : 'text-slate-800'}`}
                                                >
                                                    {fmtCny(m.cost_cny)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    {/* Recharge history */}
                    <div>
                        <div className={sectionTitle}>{t.recharges}</div>
                        {data.recharges.length === 0 ? (
                            <div className={`text-sm ${muted}`}>{t.noRecharges}</div>
                        ) : (
                            <div className={tableWrap}>
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className={`border-b ${rowBorder}`}>
                                            <th className={`${thCls} text-right`}>{t.colAmount}</th>
                                            <th className={`${thCls} text-left`}>{t.colSource}</th>
                                            <th className={`${thCls} text-left`}>{t.colNote}</th>
                                            <th className={`${thCls} text-left`}>{t.colTime}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.recharges.map((r) => (
                                            <tr key={r.id} className={`border-b ${rowBorder}`}>
                                                <td
                                                    className={`px-4 py-3 text-right ${isDark ? 'text-slate-200' : 'text-slate-800'}`}
                                                >
                                                    {fmtCny(r.amount)}
                                                </td>
                                                <td className={`px-4 py-3 ${muted}`}>{sourceLabel(r.source)}</td>
                                                <td className={`px-4 py-3 ${muted}`}>{r.note ?? '—'}</td>
                                                <td className={`px-4 py-3 ${muted}`}>{fmtDate(r.created_at)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </PayPageLayout>
    );
}

function DetailFallback() {
    const searchParams = useSearchParams();
    const locale = resolveLocale(searchParams.get('lang'));
    return (
        <div className="flex min-h-screen items-center justify-center">
            <div className="text-slate-500">{locale === 'en' ? 'Loading...' : '加载中...'}</div>
        </div>
    );
}

export default function CustomerDetailPage() {
    return (
        <Suspense fallback={<DetailFallback />}>
            <DetailContent />
        </Suspense>
    );
}
