'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState, Suspense } from 'react';
import { FileUp, Plus, RefreshCw } from 'lucide-react';
import PayPageLayout from '@/components/PayPageLayout';
import { resolveLocale, type Locale } from '@/lib/locale';

type Status = 'verified' | 'estimated' | 'unmatched';
interface Entry {
    id: string;
    status: Status;
    source: string;
    newapi_log_id: number | null;
    newapi_request_id: string | null;
    upstream_request_id: string | null;
    upstream_provider: string | null;
    upstream_route: string;
    upstream_model: string | null;
    upstream_amount: string;
    currency: string;
    cny_per_unit: string;
    cost_multiplier: string;
    cost_cny: string;
    evidence_summary: string | null;
    created_at: string;
}
interface Data {
    entries: Entry[];
    total: number;
    page: number;
    page_size: number;
    total_pages: number;
}

const EMPTY_FORM = {
    upstream_route: '',
    upstream_provider: '',
    upstream_model: '',
    upstream_amount: '',
    currency: 'USD',
    cny_per_unit: '',
    cost_multiplier: '1',
    status: 'verified' as Status,
    newapi_log_id: '',
    newapi_request_id: '',
    upstream_request_id: '',
    evidence_hash: '',
    evidence_summary: '',
};

function text(locale: Locale) {
    return locale === 'en'
        ? {
              title: 'Upstream cost ledger',
              subtitle: 'Auditable supplier cost evidence. Customer balances and new-api are unchanged.',
              refresh: 'Refresh',
              import: 'Import CSV',
              manual: 'Add entry',
              loading: 'Loading…',
              empty: 'No cost entries.',
              status: { verified: 'Verified', estimated: 'Estimated', unmatched: 'Unmatched' } as Record<
                  Status,
                  string
              >,
              route: 'Route',
              model: 'Model',
              amount: 'Source amount',
              cost: 'Cost (CNY)',
              link: 'Request link',
              time: 'Created',
              prev: 'Previous',
              next: 'Next',
              page: (p: number, n: number) => `Page ${p} / ${n}`,
              choose: 'Choose CSV',
              selected: 'Selected file',
              cancel: 'Cancel',
              save: 'Save entry',
              saving: 'Saving…',
              importing: 'Importing…',
              noFile: 'Select a CSV file first.',
              importDone: (n: number) => `Imported ${n} entries.`,
              failed: 'Request failed',
              fieldRoute: 'Upstream route *',
              fieldProvider: 'Provider',
              fieldModel: 'Upstream model',
              fieldAmount: 'Amount *',
              fieldRate: 'CNY per unit *',
              fieldMultiplier: 'Cost multiplier',
              fieldStatus: 'Status *',
              fieldLog: 'new-api log ID',
              fieldReq: 'new-api request ID',
              fieldUpReq: 'Upstream request ID',
              fieldEvidence: 'Evidence summary',
          }
        : {
              title: '上游成本台账',
              subtitle: '可审计的供应商成本证据。不会改变客户余额或 new-api。',
              refresh: '刷新',
              import: '导入 CSV',
              manual: '手工录入',
              loading: '加载中…',
              empty: '暂无成本记录。',
              status: { verified: '已核验', estimated: '估算', unmatched: '未匹配' } as Record<Status, string>,
              route: '上游线路',
              model: '模型',
              amount: '上游金额',
              cost: '成本(¥)',
              link: '关联请求',
              time: '创建时间',
              prev: '上一页',
              next: '下一页',
              page: (p: number, n: number) => `第 ${p} / ${n} 页`,
              choose: '选择 CSV',
              selected: '已选文件',
              cancel: '取消',
              save: '保存记录',
              saving: '保存中…',
              importing: '导入中…',
              noFile: '请先选择 CSV 文件。',
              importDone: (n: number) => `已导入 ${n} 条记录。`,
              failed: '请求失败',
              fieldRoute: '上游线路 *',
              fieldProvider: '供应商',
              fieldModel: '上游模型',
              fieldAmount: '上游金额 *',
              fieldRate: '人民币换算单价 *',
              fieldMultiplier: '成本倍率',
              fieldStatus: '状态 *',
              fieldLog: 'new-api 日志 ID',
              fieldReq: 'new-api Request ID',
              fieldUpReq: '上游 Request ID',
              fieldEvidence: '证据摘要',
          };
}

const money = (value: string | number) => `¥${Number(value).toFixed(6)}`;
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

function UpstreamCostsContent() {
    const searchParams = useSearchParams();
    const locale = resolveLocale(searchParams.get('lang'));
    const theme = searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const isDark = theme === 'dark';
    const isEmbedded = searchParams.get('ui_mode') === 'embedded';
    const t = text(locale);
    const [data, setData] = useState<Data | null>(null);
    const [page, setPage] = useState(1);
    const [status, setStatus] = useState<Status | ''>('');
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [modal, setModal] = useState<'manual' | 'import' | null>(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [file, setFile] = useState<File | null>(null);

    const fetchData = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const qs = new URLSearchParams({ page: String(page), page_size: '25' });
            if (status) qs.set('status', status);
            const res = await fetch(`/api/admin/upstream-costs?${qs}`);
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.message || body.error || t.failed);
            setData(body as Data);
        } catch (e) {
            setError(e instanceof Error ? e.message : t.failed);
        } finally {
            setLoading(false);
        }
    }, [page, status, t.failed]);

    useEffect(() => void fetchData(), [fetchData]);

    const update = (key: keyof typeof EMPTY_FORM, value: string) => setForm((old) => ({ ...old, [key]: value }));
    const submitManual = async () => {
        setBusy(true);
        setError('');
        try {
            const res = await fetch('/api/admin/upstream-costs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...form, newapi_log_id: form.newapi_log_id || null }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.message || body.error || t.failed);
            setModal(null);
            setForm(EMPTY_FORM);
            setNotice(locale === 'en' ? 'Entry saved.' : '成本记录已保存。');
            await fetchData();
        } catch (e) {
            setError(e instanceof Error ? e.message : t.failed);
        } finally {
            setBusy(false);
        }
    };
    const submitImport = async () => {
        if (!file) {
            setError(t.noFile);
            return;
        }
        setBusy(true);
        setError('');
        try {
            const body = new FormData();
            body.set('file', file);
            const res = await fetch('/api/admin/upstream-costs/import', { method: 'POST', body });
            const result = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(result.message || result.error || t.failed);
            setModal(null);
            setFile(null);
            setNotice(
                result.duplicate
                    ? locale === 'en'
                        ? 'This file was already imported.'
                        : '该文件已导入过。'
                    : t.importDone(result.imported),
            );
            await fetchData();
        } catch (e) {
            setError(e instanceof Error ? e.message : t.failed);
        } finally {
            setBusy(false);
        }
    };

    const card = isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm';
    const input = `w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 ${isDark ? 'border-slate-600 bg-slate-800 text-slate-100' : 'border-slate-300 bg-white text-slate-900'}`;
    const label = `mb-1 block text-xs font-medium ${isDark ? 'text-slate-300' : 'text-slate-700'}`;
    const button = (primary = false) =>
        `inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${primary ? 'border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-600' : isDark ? 'border-slate-600 text-slate-200 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'}`;
    const statusBadge = (value: Status) => {
        const colors =
            value === 'verified'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : value === 'estimated'
                  ? 'border-amber-200 bg-amber-50 text-amber-700'
                  : 'border-slate-200 bg-slate-100 text-slate-600';
        return <span className={`rounded-full border px-2 py-0.5 text-[11px] ${colors}`}>{t.status[value]}</span>;
    };

    return (
        <PayPageLayout
            isDark={isDark}
            isEmbedded={isEmbedded}
            maxWidth="full"
            title={t.title}
            subtitle={t.subtitle}
            locale={locale}
            actions={
                <div className="flex flex-wrap gap-2">
                    <button className={button()} onClick={() => void fetchData()} disabled={loading}>
                        <RefreshCw size={14} />
                        {t.refresh}
                    </button>
                    <button className={button()} onClick={() => setModal('import')}>
                        <FileUp size={14} />
                        {t.import}
                    </button>
                    <button className={button(true)} onClick={() => setModal('manual')}>
                        <Plus size={14} />
                        {t.manual}
                    </button>
                </div>
            }
        >
            {error && (
                <div
                    className={`mb-3 rounded-lg border p-3 text-sm ${isDark ? 'border-red-800 bg-red-950/50 text-red-300' : 'border-red-200 bg-red-50 text-red-700'}`}
                >
                    {error}
                </div>
            )}
            {notice && (
                <div
                    className={`mb-3 rounded-lg border p-3 text-sm ${isDark ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}
                >
                    {notice}
                </div>
            )}
            <div className="mb-3 flex items-center gap-2">
                <select
                    value={status}
                    onChange={(e) => {
                        setStatus(e.target.value as Status | '');
                        setPage(1);
                    }}
                    className={input + ' w-auto py-1.5 text-xs'}
                >
                    <option value="">{locale === 'en' ? 'All statuses' : '全部状态'}</option>
                    <option value="verified">{t.status.verified}</option>
                    <option value="estimated">{t.status.estimated}</option>
                    <option value="unmatched">{t.status.unmatched}</option>
                </select>
            </div>
            <div className={`overflow-x-auto rounded-xl border ${card}`}>
                {loading ? (
                    <div className="py-12 text-center text-sm text-slate-500">{t.loading}</div>
                ) : !data || data.entries.length === 0 ? (
                    <div className="py-12 text-center text-sm text-slate-500">{t.empty}</div>
                ) : (
                    <table className="w-full min-w-[980px] text-sm">
                        <thead>
                            <tr
                                className={`border-b ${isDark ? 'border-slate-700 text-slate-400' : 'border-slate-200 text-slate-500'}`}
                            >
                                <th className="px-4 py-3 text-left font-medium">{t.route}</th>
                                <th className="px-4 py-3 text-left font-medium">{t.model}</th>
                                <th className="px-4 py-3 text-left font-medium">{t.amount}</th>
                                <th className="px-4 py-3 text-left font-medium">{t.cost}</th>
                                <th className="px-4 py-3 text-left font-medium">{t.link}</th>
                                <th className="px-4 py-3 text-left font-medium">{t.time}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.entries.map((entry) => (
                                <tr
                                    key={entry.id}
                                    className={`border-b ${isDark ? 'border-slate-700/50' : 'border-slate-100'}`}
                                >
                                    <td className="px-4 py-3">
                                        <div className="font-medium">{entry.upstream_route}</div>
                                        <div className="mt-1 text-xs text-slate-500">
                                            {entry.upstream_provider || '—'} · {statusBadge(entry.status)}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                                        {entry.upstream_model || '—'}
                                    </td>
                                    <td className="px-4 py-3 tabular-nums">
                                        {entry.upstream_amount} {entry.currency}
                                    </td>
                                    <td className="px-4 py-3 font-medium tabular-nums">{money(entry.cost_cny)}</td>
                                    <td className="px-4 py-3 text-xs text-slate-500">
                                        {entry.newapi_log_id
                                            ? `log #${entry.newapi_log_id}`
                                            : entry.upstream_request_id || entry.newapi_request_id || '—'}
                                    </td>
                                    <td className="px-4 py-3 text-xs text-slate-500">{date(entry.created_at)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
            {data && data.total_pages > 1 && (
                <div className="mt-3 flex items-center justify-end gap-3 text-xs text-slate-500">
                    <button className={button()} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                        {t.prev}
                    </button>
                    <span>{t.page(page, data.total_pages)}</span>
                    <button
                        className={button()}
                        disabled={page >= data.total_pages}
                        onClick={() => setPage((p) => p + 1)}
                    >
                        {t.next}
                    </button>
                </div>
            )}

            {modal === 'import' && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div className={`w-full max-w-md rounded-xl border p-5 shadow-2xl ${card}`}>
                        <h2 className="mb-4 text-base font-semibold">{t.import}</h2>
                        <label className={label}>{t.choose}</label>
                        <input
                            type="file"
                            accept=".csv,text/csv"
                            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                            className={input}
                        />
                        {file && (
                            <p className="mt-2 text-xs text-slate-500">
                                {t.selected}: {file.name}
                            </p>
                        )}
                        <div className="mt-5 flex justify-end gap-2">
                            <button className={button()} onClick={() => setModal(null)}>
                                {t.cancel}
                            </button>
                            <button className={button(true)} disabled={busy} onClick={() => void submitImport()}>
                                {busy ? t.importing : t.import}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {modal === 'manual' && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div
                        className={`max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border p-5 shadow-2xl ${card}`}
                    >
                        <h2 className="mb-4 text-base font-semibold">{t.manual}</h2>
                        <div className="grid gap-3 sm:grid-cols-2">
                            {(
                                [
                                    ['upstream_route', t.fieldRoute],
                                    ['upstream_provider', t.fieldProvider],
                                    ['upstream_model', t.fieldModel],
                                    ['upstream_amount', t.fieldAmount],
                                    ['currency', 'Currency'],
                                    ['cny_per_unit', t.fieldRate],
                                    ['cost_multiplier', t.fieldMultiplier],
                                    ['newapi_log_id', t.fieldLog],
                                    ['newapi_request_id', t.fieldReq],
                                    ['upstream_request_id', t.fieldUpReq],
                                ] as const
                            ).map(([key, caption]) => (
                                <label key={key} className={label}>
                                    {caption}
                                    <input
                                        className={input}
                                        value={form[key]}
                                        onChange={(e) => update(key, e.target.value)}
                                    />
                                </label>
                            ))}
                            <label className={label}>
                                {t.fieldStatus}
                                <select
                                    className={input}
                                    value={form.status}
                                    onChange={(e) => update('status', e.target.value)}
                                >
                                    <option value="verified">{t.status.verified}</option>
                                    <option value="estimated">{t.status.estimated}</option>
                                    <option value="unmatched">{t.status.unmatched}</option>
                                </select>
                            </label>
                            <label className={`${label} sm:col-span-2`}>
                                {t.fieldEvidence}
                                <textarea
                                    className={input}
                                    rows={3}
                                    value={form.evidence_summary}
                                    onChange={(e) => update('evidence_summary', e.target.value)}
                                />
                            </label>
                        </div>
                        <div className="mt-5 flex justify-end gap-2">
                            <button className={button()} onClick={() => setModal(null)}>
                                {t.cancel}
                            </button>
                            <button className={button(true)} disabled={busy} onClick={() => void submitManual()}>
                                {busy ? t.saving : t.save}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </PayPageLayout>
    );
}

export default function UpstreamCostsPage() {
    return (
        <Suspense>
            <UpstreamCostsContent />
        </Suspense>
    );
}
