'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState, useEffect, Suspense } from 'react';
import PayPageLayout from '@/components/PayPageLayout';
import { resolveLocale, type Locale } from '@/lib/locale';

// ── Types (mirror /api/admin/customers) ──
interface Usage30d {
    calls: number;
    costCny: number;
}
interface CustomerRow {
    id: string;
    email: string;
    admin_alias: string | null;
    status: 'active' | 'disabled' | 'banned';
    created_at: string;
    balance_cny: number;
    balance_cached_at: string | null;
    balance_pending: boolean;
    key_count: number;
    usage_30d: Usage30d;
}
interface CustomersData {
    customers: CustomerRow[];
    total: number;
    page: number;
    page_size: number;
    total_pages: number;
    usage_window_days: number;
}
type CustomerSort = 'recent' | 'balance';

function getTexts(locale: Locale) {
    return locale === 'en'
        ? {
              title: 'Customers',
              sort: 'Sort by',
              sortRecent: 'Recently registered',
              sortBalance: 'Highest balance',
              invalidToken: 'Session expired, please sign in again',
              loadFailed: 'Failed to load customers',
              loading: 'Loading...',
              empty: 'No customers yet.',
              searchPlaceholder: 'Search by email or alias…',
              search: 'Search',
              clear: 'Clear',
              colCustomer: 'Customer',
              colJoined: 'Joined',
              colStatus: 'Status',
              colBalance: 'Balance',
              balancePending: 'Awaiting sync',
              balanceUpdated: (time: string) => `Balance updated ${time} (UTC+8)`,
              colKeys: 'Keys',
              colCalls: 'Calls (30d)',
              colCost: 'Cost (30d)',
              active: 'active',
              disabled: 'disabled',
              banned: 'banned',
              prev: 'Prev',
              next: 'Next',
              pageOf: (p: number, t: number) => `Page ${p} / ${t}`,
              totalN: (n: number) => `${n} customers`,
          }
        : {
              title: '客户管理',
              sort: '排序',
              sortRecent: '最近注册',
              sortBalance: '余额从高到低',
              invalidToken: '登录已过期',
              loadFailed: '加载客户列表失败',
              loading: '加载中...',
              empty: '暂无客户。',
              searchPlaceholder: '搜索邮箱或别名…',
              search: '搜索',
              clear: '清除',
              colCustomer: '客户',
              colJoined: '注册时间',
              colStatus: '状态',
              colBalance: '余额',
              balancePending: '待同步',
              balanceUpdated: (time: string) => `余额更新于 ${time}（北京时间）`,
              colKeys: 'Key 数',
              colCalls: '调用(30天)',
              colCost: '消费(30天)',
              active: '正常',
              disabled: '已停用',
              banned: '已封禁',
              prev: '上一页',
              next: '下一页',
              pageOf: (p: number, t: number) => `第 ${p} / ${t} 页`,
              totalN: (n: number) => `共 ${n} 位客户`,
          };
}

const fmtCny = (n: number): string => `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
// gotcha #20: server TZ is UTC in the container — pin Asia/Shanghai explicitly.
const fmtDate = (iso: string): string =>
    new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

function CustomersContent() {
    const searchParams = useSearchParams();
    const theme = searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const uiMode = searchParams.get('ui_mode') || 'standalone';
    const locale = resolveLocale(searchParams.get('lang'));
    const isDark = theme === 'dark';
    const isEmbedded = uiMode === 'embedded';
    const t = getTexts(locale);

    // Preserve chrome params (theme / ui_mode / lang) when linking to detail.
    const detailQs = new URLSearchParams();
    detailQs.set('theme', theme);
    detailQs.set('ui_mode', uiMode);
    if (locale !== 'zh') detailQs.set('lang', locale);
    const detailHref = (id: string) => `/admin/customers/${id}?${detailQs.toString()}`;

    const [page, setPage] = useState(1);
    const [query, setQuery] = useState(''); // committed search term
    const [queryInput, setQueryInput] = useState(''); // text box value
    const [sort, setSort] = useState<CustomerSort>('recent');
    const [result, setResult] = useState<{
        url: string;
        data?: CustomersData;
        error?: 'unauthorized' | 'loadFailed';
    }>();
    const listParams = new URLSearchParams({ page: String(page), page_size: '20', sort });
    if (query) listParams.set('q', query);
    const listUrl = `/api/admin/customers?${listParams.toString()}`;
    const loading = result?.url !== listUrl;
    const data = loading ? undefined : result.data;
    const error = loading ? undefined : result.error;

    useEffect(() => {
        const controller = new AbortController();
        const { signal } = controller;
        async function fetchData() {
            try {
                const res = await fetch(listUrl, { signal });
                if (signal.aborted) return;
                if (res.status === 401) {
                    setResult({ url: listUrl, error: 'unauthorized' });
                    return;
                }
                if (!res.ok) throw new Error();
                const data = (await res.json()) as CustomersData;
                if (!signal.aborted) setResult({ url: listUrl, data });
            } catch {
                if (!signal.aborted) setResult({ url: listUrl, error: 'loadFailed' });
            }
        }
        void fetchData();
        return () => controller.abort();
    }, [listUrl]);

    const card = isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm';
    const tableWrap = ['overflow-x-auto rounded-xl border', card].join(' ');
    const thCls = `px-4 py-3 font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`;
    const rowBorder = isDark ? 'border-slate-700/50' : 'border-slate-100';

    const statusBadge = (status: CustomerRow['status']) => {
        const label = status === 'active' ? t.active : status === 'disabled' ? t.disabled : t.banned;
        const cls =
            status === 'active'
                ? isDark
                    ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : status === 'banned'
                  ? isDark
                      ? 'border-red-800 bg-red-950/40 text-red-300'
                      : 'border-red-200 bg-red-50 text-red-700'
                  : isDark
                    ? 'border-slate-600 bg-slate-700/40 text-slate-300'
                    : 'border-slate-200 bg-slate-100 text-slate-600';
        return <span className={`rounded-full border px-2 py-0.5 text-[11px] ${cls}`}>{label}</span>;
    };

    const submitSearch = (e: React.FormEvent) => {
        e.preventDefault();
        setPage(1);
        setQuery(queryInput.trim());
    };
    const clearSearch = () => {
        setQueryInput('');
        setPage(1);
        setQuery('');
    };

    const inputCls = [
        'rounded-lg border px-3 py-1.5 text-xs',
        isDark
            ? 'border-slate-600 bg-slate-800 text-slate-200 placeholder:text-slate-500'
            : 'border-slate-300 bg-white text-slate-800 placeholder:text-slate-400',
    ].join(' ');
    const btnCls = (variant: 'primary' | 'ghost') =>
        [
            'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
            variant === 'primary'
                ? 'border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-600'
                : isDark
                  ? 'border-slate-600 text-slate-300 hover:bg-slate-800'
                  : 'border-slate-300 text-slate-700 hover:bg-slate-100',
        ].join(' ');

    return (
        <PayPageLayout
            isDark={isDark}
            isEmbedded={isEmbedded}
            maxWidth="full"
            title={t.title}
            subtitle=""
            locale={locale}
            actions={
                <form onSubmit={submitSearch} className="flex flex-wrap items-center gap-2">
                    <input
                        type="text"
                        value={queryInput}
                        onChange={(e) => setQueryInput(e.target.value)}
                        placeholder={t.searchPlaceholder}
                        aria-label={t.searchPlaceholder}
                        className={inputCls}
                    />
                    <label
                        className={`flex items-center gap-2 text-xs ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
                    >
                        {t.sort}
                        <select
                            className={inputCls}
                            value={sort}
                            onChange={(e) => {
                                setSort(e.target.value === 'balance' ? 'balance' : 'recent');
                                setPage(1);
                            }}
                        >
                            <option value="recent">{t.sortRecent}</option>
                            <option value="balance">{t.sortBalance}</option>
                        </select>
                    </label>
                    <button type="submit" className={btnCls('primary')}>
                        {t.search}
                    </button>
                    {query && (
                        <button type="button" onClick={clearSearch} className={btnCls('ghost')}>
                            {t.clear}
                        </button>
                    )}
                </form>
            }
        >
            {error && (
                <div
                    className={`mb-4 rounded-lg border p-3 text-sm ${isDark ? 'border-red-800 bg-red-950/50 text-red-400' : 'border-red-200 bg-red-50 text-red-600'}`}
                >
                    {error === 'unauthorized' ? t.invalidToken : t.loadFailed}
                </div>
            )}

            {loading ? (
                <div className={`py-12 text-center ${isDark ? 'text-slate-400' : 'text-gray-500'}`}>{t.loading}</div>
            ) : !data || data.customers.length === 0 ? (
                <div
                    className={`rounded-xl border p-12 text-center ${card} ${isDark ? 'text-slate-400' : 'text-gray-500'}`}
                >
                    {t.empty}
                </div>
            ) : (
                <div className="space-y-3">
                    <div className={tableWrap}>
                        <table className="w-full text-sm">
                            <thead>
                                <tr className={`border-b ${rowBorder}`}>
                                    <th className={`${thCls} text-left`}>{t.colCustomer}</th>
                                    <th
                                        aria-sort={sort === 'recent' ? 'descending' : undefined}
                                        className={`${thCls} text-left`}
                                    >
                                        {t.colJoined} {sort === 'recent' && <span aria-hidden="true">↓</span>}
                                    </th>
                                    <th className={`${thCls} text-left`}>{t.colStatus}</th>
                                    <th
                                        aria-sort={sort === 'balance' ? 'descending' : undefined}
                                        className={`${thCls} text-right`}
                                    >
                                        {t.colBalance} {sort === 'balance' && <span aria-hidden="true">↓</span>}
                                    </th>
                                    <th className={`${thCls} text-right`}>{t.colKeys}</th>
                                    <th className={`${thCls} text-right`}>{t.colCalls}</th>
                                    <th className={`${thCls} text-right`}>{t.colCost}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.customers.map((c) => (
                                    <tr key={c.id} className={`border-b ${rowBorder}`}>
                                        <td className="px-4 py-3">
                                            <Link
                                                href={detailHref(c.id)}
                                                className={
                                                    isDark
                                                        ? 'text-indigo-300 hover:underline'
                                                        : 'text-indigo-600 hover:underline'
                                                }
                                            >
                                                {c.admin_alias || c.email}
                                            </Link>
                                            {c.admin_alias && (
                                                <div
                                                    className={`mt-0.5 break-all text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                                                >
                                                    {c.email}
                                                </div>
                                            )}
                                        </td>
                                        <td className={`px-4 py-3 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                                            {fmtDate(c.created_at)}
                                        </td>
                                        <td className="px-4 py-3">{statusBadge(c.status)}</td>
                                        <td
                                            className={`px-4 py-3 text-right ${isDark ? 'text-slate-200' : 'text-slate-800'}`}
                                        >
                                            {c.balance_pending ? (
                                                <span
                                                    className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                                                >
                                                    {t.balancePending}
                                                </span>
                                            ) : (
                                                <span
                                                    title={
                                                        c.balance_cached_at
                                                            ? t.balanceUpdated(fmtDate(c.balance_cached_at))
                                                            : undefined
                                                    }
                                                >
                                                    {fmtCny(c.balance_cny)}
                                                </span>
                                            )}
                                        </td>
                                        <td
                                            className={`px-4 py-3 text-right ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
                                        >
                                            {c.key_count}
                                        </td>
                                        <td
                                            className={`px-4 py-3 text-right ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
                                        >
                                            {c.usage_30d.calls}
                                        </td>
                                        <td
                                            className={`px-4 py-3 text-right ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
                                        >
                                            {fmtCny(c.usage_30d.costCny)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Pagination */}
                    <div className="flex items-center justify-between">
                        <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                            {t.totalN(data.total)}
                        </span>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                disabled={data.page <= 1}
                                onClick={() => setPage((p) => Math.max(1, p - 1))}
                                className={btnCls('ghost')}
                            >
                                {t.prev}
                            </button>
                            <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                {t.pageOf(data.page, data.total_pages || 1)}
                            </span>
                            <button
                                type="button"
                                disabled={data.page >= data.total_pages}
                                onClick={() => setPage((p) => p + 1)}
                                className={btnCls('ghost')}
                            >
                                {t.next}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </PayPageLayout>
    );
}

function CustomersFallback() {
    const searchParams = useSearchParams();
    const locale = resolveLocale(searchParams.get('lang'));
    return (
        <div className="flex min-h-screen items-center justify-center">
            <div className="text-slate-500">{locale === 'en' ? 'Loading...' : '加载中...'}</div>
        </div>
    );
}

export default function CustomersPage() {
    return (
        <Suspense fallback={<CustomersFallback />}>
            <CustomersContent />
        </Suspense>
    );
}
