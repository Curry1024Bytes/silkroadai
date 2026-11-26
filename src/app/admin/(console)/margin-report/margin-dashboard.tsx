'use client';

import { Fragment, Suspense, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ActualMarginReport, MarginChargeDetail, MarginTotals } from '@/lib/billing/actual-margin';

const dates = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });
const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const fmt = (value: string | null) => (value === null ? '待对账' : '¥' + money.format(Number(value)));

function period(days: number) {
    const now = Date.now();
    return { start: dates.format(new Date(now - (days - 1) * 86_400_000)), end: dates.format(new Date(now)) };
}

const example = {
    entries: [
        {
            channel_id: 24,
            reference_kind: 'task',
            reference_id: 'example-task-id',
            amount: '1.234567',
            currency: 'CNY',
            cny_per_unit: '1',
            status: 'verified',
            evidence: '供应商账单编号',
        },
    ],
};

const errors: Record<string, string> = {
    source_missing: '请配置 new-api 账单只读连接。',
    source_unavailable: '暂时无法读取 new-api 账单。',
    invalid_period: '请选择 2026 年 8 月 25 日及以后有效日期，单次可查看 93 天。',
    range_too_large: '所选期间超过 8 万条账单记录，请缩小日期范围。',
    invalid_invoice: '账单格式有误，请对照模板检查。',
    file_too_large: '文件过大，请分批导入。',
    duplicate_in_batch: '账单内有重复的渠道和请求编号。',
    conflicting_cost: '同一个请求已有不同的采购记录，请核对账单。',
    import_unavailable: '暂时无法保存供应商账单。',
    unauthorized: '请以超级管理员身份登录。',
};

function invoiceTemplate() {
    const blob = new Blob([JSON.stringify(example, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'supplier-invoice-template.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function CostImport({ panel, button, onSaved }: { panel: string; button: string; onSaved: () => void }) {
    const [file, setFile] = useState<File>();
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!file || busy) return;
        setBusy(true);
        setNotice(undefined);
        try {
            if (file.size > 800_000) {
                setNotice({ error: true, text: errors.file_too_large });
                return;
            }
            const response = await fetch('/api/admin/margin-report/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: (await file.text()).replace(/^\uFEFF/, ''),
            });
            const result = await response.json();
            if (!response.ok) {
                const line = typeof result.row === 'number' ? ' 位置为第 ' + (result.row + 1) + ' 条。' : '';
                setNotice({ error: true, text: (errors[result.error] ?? '导入失败。') + line });
                return;
            }
            setNotice({
                text:
                    '新增 ' +
                    result.inserted +
                    ' 条，核验 ' +
                    result.promoted +
                    ' 条，已存在 ' +
                    result.duplicates +
                    ' 条。',
            });
            onSaved();
        } catch {
            setNotice({ error: true, text: '导入失败，请重试。' });
        } finally {
            setBusy(false);
        }
    }
    return (
        <details className={panel + ' p-4'}>
            <summary className="cursor-pointer font-medium">导入上游账单</summary>
            <form className="mt-3 space-y-3" onSubmit={submit}>
                <p className="text-sm">
                    用渠道编号和任务 ID 或请求 ID 匹配。每条填写该笔最终净采购金额、采购币种、人民币换算比例和账单凭据。
                </p>
                <div className="flex flex-wrap items-end gap-3">
                    <button type="button" className={button} onClick={invoiceTemplate}>
                        下载导入模板
                    </button>
                    <label className="flex flex-col gap-1 text-sm">
                        账单文件（JSON）
                        <input
                            type="file"
                            accept=".json,application/json"
                            onChange={(event) => setFile(event.target.files?.[0])}
                        />
                    </label>
                    <button type="submit" disabled={!file || busy} className={button}>
                        {busy ? '导入中…' : '确认导入'}
                    </button>
                </div>
                {notice && (
                    <p
                        role={notice.error ? 'alert' : 'status'}
                        className={'text-sm ' + (notice.error ? 'text-red-500' : '')}
                    >
                        {notice.text}
                    </p>
                )}
            </form>
        </details>
    );
}

function Coverage({ total }: { total: MarginTotals }) {
    if (!total.calls) return <span>无用量</span>;
    return (
        <>
            <span className="whitespace-nowrap">
                {total.verifiedCalls.toLocaleString()} / {total.calls.toLocaleString()} 已对账
            </span>
            {total.pendingCalls > 0 && (
                <span className="block whitespace-nowrap text-xs opacity-75">
                    {total.pendingCalls.toLocaleString()} 笔待对账
                </span>
            )}
            {total.estimatedCalls > 0 && (
                <span className="block whitespace-nowrap text-xs opacity-75">
                    {total.estimatedCalls.toLocaleString()} 笔估算
                </span>
            )}
        </>
    );
}

function Amounts({ total }: { total: MarginTotals }) {
    const cost =
        total.verifiedCostCny === null
            ? total.estimatedCostCny === null
                ? '待对账'
                : '约 ' + fmt(total.estimatedCostCny)
            : fmt(total.verifiedCostCny);
    const profit = total.profitCny === null ? total.estimatedProfitCny : total.profitCny;
    const amountClass = 'whitespace-nowrap px-3 py-3 text-right tabular-nums';
    const lossClass = profit !== null && Number(profit) < 0 ? ' text-red-600 dark:text-red-300' : '';
    return (
        <>
            <td className={amountClass}>{total.calls.toLocaleString()}</td>
            <td className={amountClass}>{fmt(total.netCny)}</td>
            <td className={amountClass}>{total.calls ? cost : '—'}</td>
            <td className={amountClass + ' font-medium' + lossClass}>
                {total.calls ? (total.profitCny === null && profit !== null ? '约 ' : '') + fmt(profit) : '—'}
            </td>
            <td className={amountClass + lossClass}>
                {total.marginPct === null ? '—' : Number(total.marginPct).toFixed(1) + '%'}
            </td>
            <td className="px-3 py-3 text-right text-xs">
                <Coverage total={total} />
            </td>
        </>
    );
}

const chargeTime = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'short',
    timeStyle: 'medium',
});
const refLabel = { task: '任务 ID', upstream: '上游请求 ID', request: '请求 ID' };
const detailStatus = { verified: '已对账', estimated: '估算', pending: '待对账' };

function ChannelCharges({ query, button }: { query: string; button: string }) {
    const [page, setPage] = useState(1);
    const [result, setResult] = useState<{
        page: number;
        data?: { charges: MarginChargeDetail[]; total: number; pageSize: number };
        failed?: boolean;
    }>();
    useEffect(() => {
        const controller = new AbortController();
        async function load() {
            try {
                const response = await fetch('/api/admin/margin-report?' + query + '&page=' + page, {
                    signal: controller.signal,
                    cache: 'no-store',
                });
                if (!response.ok) throw new Error();
                const data = await response.json();
                if (!controller.signal.aborted) setResult({ page, data });
            } catch {
                if (!controller.signal.aborted) setResult({ page, failed: true });
            }
        }
        void load();
        return () => controller.abort();
    }, [page, query]);
    if (result?.page !== page) return <p role="status">正在读取渠道账单…</p>;
    if (!result.data) return <p role="alert">渠道账单加载失败。关闭后重新打开可重试。</p>;
    const { charges, total, pageSize } = result.data;
    return (
        <div className="space-y-2">
            <table className="w-full text-left text-xs">
                <thead>
                    <tr>
                        <th scope="col">时间（北京时间）</th>
                        <th scope="col">匹配编号</th>
                        <th scope="col" className="text-right">
                            客户净扣
                        </th>
                        <th scope="col" className="text-right">
                            采购成本
                        </th>
                        <th scope="col" className="text-right">
                            状态
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {charges.map((charge) => (
                        <tr key={charge.id}>
                            <td className="whitespace-nowrap py-2 pr-3">
                                {chargeTime.format(new Date(charge.time * 1_000))}
                            </td>
                            <td className="py-2 pr-3">
                                {charge.references.map(([kind, ref]) => (
                                    <div key={kind + ':' + ref}>
                                        {refLabel[kind]} <code className="select-all">{ref}</code>
                                    </div>
                                ))}
                                {!charge.references.length && '—'}
                            </td>
                            <td className="text-right">{fmt(charge.netCny)}</td>
                            <td className="text-right">{fmt(charge.costCny)}</td>
                            <td className="text-right">{detailStatus[charge.status]}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <div className="flex items-center justify-end gap-2">
                <button type="button" className={button} disabled={page <= 1} onClick={() => setPage(page - 1)}>
                    上一页
                </button>
                <span>
                    {page} / {Math.max(1, Math.ceil(total / pageSize))}
                </span>
                <button
                    type="button"
                    className={button}
                    disabled={page * pageSize >= total}
                    onClick={() => setPage(page + 1)}
                >
                    下一页
                </button>
            </div>
        </div>
    );
}

function Dashboard() {
    const theme = useSearchParams().get('theme') === 'dark';
    const [range, setRange] = useState(() => period(30));
    const [draft, setDraft] = useState(range);
    const [refresh, setRefresh] = useState(0);
    const [search, setSearch] = useState('');
    const [focus, setFocus] = useState('all');
    const [open, setOpen] = useState<Set<string>>(() => new Set());
    const [channelDetail, setChannelDetail] = useState('');
    const [result, setResult] = useState<{ key: string; data?: ActualMarginReport; error?: string }>();
    const query = new URLSearchParams(range).toString();
    const key = query + ':' + refresh;
    const data = result?.key === key ? result.data : undefined;
    const error = result?.key === key ? result.error : undefined;

    useEffect(() => {
        const controller = new AbortController();
        async function load() {
            try {
                const response = await fetch('/api/admin/margin-report?' + query, {
                    signal: controller.signal,
                    cache: 'no-store',
                });
                const payload = await response.json();
                if (controller.signal.aborted) return;
                if (!response.ok) setResult({ key, error: response.status === 401 ? 'unauthorized' : payload.error });
                else setResult({ key, data: payload });
            } catch {
                if (!controller.signal.aborted) setResult({ key, error: 'report_unavailable' });
            }
        }
        void load();
        return () => controller.abort();
    }, [key, query]);

    const muted = theme ? 'text-slate-400' : 'text-slate-600';
    const border = theme ? 'border-slate-700' : 'border-slate-200';
    const panel = 'min-w-0 rounded-xl border ' + border + (theme ? ' bg-slate-900' : ' bg-white');
    const button =
        'min-h-10 rounded-lg border px-3 text-sm font-medium disabled:opacity-50 ' +
        border +
        (theme ? ' hover:bg-slate-800' : ' hover:bg-slate-100');
    const field = 'min-h-10 rounded-lg border bg-transparent px-3 text-sm ' + border + (theme ? ' scheme-dark' : '');
    const totals = data?.summary;
    const models = (data?.models ?? []).filter((model) => {
        const term = search.trim().toLowerCase();
        return (
            (!term || model.model.toLowerCase().includes(term) || model.name.toLowerCase().includes(term)) &&
            (focus === 'all' ||
                (focus === 'loss' && model.profitCny !== null && Number(model.profitCny) < 0) ||
                (focus === 'pending' && model.calls > model.verifiedCalls))
        );
    });
    const setPeriod = (days: number) => {
        const next = period(days);
        setRange(next);
        setDraft(next);
    };
    function toggle(model: string) {
        setOpen((previous) => {
            const next = new Set(previous);
            if (next.has(model)) next.delete(model);
            else next.add(model);
            return next;
        });
    }
    return (
        <main
            className={
                'mx-auto max-w-[1600px] space-y-4 px-3 py-5 sm:px-6 ' + (theme ? 'text-slate-100' : 'text-slate-900')
            }
        >
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold">模型毛利</h1>
                    <p className={'mt-1 text-sm ' + muted}>客户净扣按结算流水日期统计，毛利取同一批已对账请求。</p>
                </div>
                <a
                    className={button + ' inline-flex items-center'}
                    href={'/admin/billing-shadow?theme=' + (theme ? 'dark' : 'light')}
                >
                    查看目录估算
                </a>
            </div>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    setRange(draft);
                    setRefresh((value) => value + 1);
                }}
                className={panel + ' flex flex-wrap items-end gap-3 p-4'}
            >
                <label className="flex flex-col gap-1 text-sm">
                    开始日期
                    <input
                        required
                        type="date"
                        className={field}
                        value={draft.start}
                        onChange={(event) => setDraft({ ...draft, start: event.target.value })}
                    />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                    结束日期
                    <input
                        required
                        type="date"
                        className={field}
                        value={draft.end}
                        onChange={(event) => setDraft({ ...draft, end: event.target.value })}
                    />
                </label>
                <button type="submit" className={button}>
                    查询
                </button>
                <button type="button" className={button} onClick={() => setPeriod(7)}>
                    近 7 天
                </button>
                <button type="button" className={button} onClick={() => setPeriod(30)}>
                    近 30 天
                </button>
                <span className={'self-center text-xs ' + muted}>北京时间</span>
            </form>
            {error ? (
                <p role="alert" className={panel + ' p-4 text-sm'}>
                    {errors[error] ?? '加载毛利看板失败。'}
                </p>
            ) : !totals ? (
                <p role="status" className={panel + ' p-4 text-sm'}>
                    正在读取账单…
                </p>
            ) : (
                <>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        {[
                            ['客户净扣', fmt(totals.netCny), totals.calls.toLocaleString() + ' 笔'],
                            [
                                '已对账采购成本',
                                fmt(totals.verifiedCostCny),
                                '对应客户净扣 ' + fmt(totals.verifiedNetCny),
                            ],
                            [
                                '已对账毛利',
                                fmt(totals.profitCny),
                                totals.marginPct === null
                                    ? '毛利率 —'
                                    : '毛利率 ' + Number(totals.marginPct).toFixed(1) + '%',
                            ],
                            [
                                '对账进度',
                                totals.verifiedCalls.toLocaleString() + ' / ' + totals.calls.toLocaleString(),
                                totals.pendingCalls.toLocaleString() + ' 笔待对账 · 净扣 ' + fmt(totals.pendingNetCny),
                            ],
                        ].map(([label, value, hint]) => (
                            <section key={label} className={panel + ' p-4'}>
                                <h2 className={'text-sm ' + muted}>{label}</h2>
                                <p
                                    className={
                                        'mt-2 text-2xl font-semibold tabular-nums ' +
                                        (label === '已对账毛利' && Number(totals.profitCny) < 0 ? 'text-red-600' : '')
                                    }
                                >
                                    {value}
                                </p>
                                <p className={'mt-1 text-xs ' + muted}>{hint}</p>
                            </section>
                        ))}
                    </div>
                    {totals.estimatedCalls > 0 && (
                        <p className={panel + ' px-4 py-3 text-sm'}>
                            {totals.estimatedCalls.toLocaleString()} 笔有采购估算，估算成本{' '}
                            {fmt(totals.estimatedCostCny)}，对应估算毛利 {fmt(totals.estimatedProfitCny)}。
                        </p>
                    )}
                    <section className={panel}>
                        <div className="flex flex-wrap items-end justify-between gap-3 p-4">
                            <h2 className="text-base font-semibold">
                                按模型 <span className={'text-sm font-normal ' + muted}>{models.length} 个</span>
                            </h2>
                            <div className="flex flex-wrap gap-3">
                                <label className="flex flex-col gap-1 text-sm">
                                    搜索模型
                                    <input
                                        className={field}
                                        type="search"
                                        value={search}
                                        onChange={(e) => setSearch(e.target.value)}
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    查看
                                    <select className={field} value={focus} onChange={(e) => setFocus(e.target.value)}>
                                        <option value="all">全部</option>
                                        <option value="loss">亏损模型</option>
                                        <option value="pending">待对账</option>
                                    </select>
                                </label>
                            </div>
                        </div>
                        {models.length === 0 ? (
                            <p className={'p-4 text-sm ' + muted}>没有符合条件的模型。</p>
                        ) : (
                            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="模型毛利明细">
                                <table className="w-full min-w-[880px] text-sm">
                                    <thead className={muted}>
                                        <tr>
                                            {[
                                                '模型 / 渠道',
                                                '笔数',
                                                '客户净扣',
                                                '采购成本',
                                                '毛利',
                                                '毛利率',
                                                '对账进度',
                                            ].map((label, index) => (
                                                <th
                                                    scope="col"
                                                    key={label}
                                                    className={
                                                        'whitespace-nowrap px-3 py-3 font-medium ' +
                                                        (index ? 'text-right' : 'text-left')
                                                    }
                                                >
                                                    {label}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {models.map((model) => (
                                            <Fragment key={model.model}>
                                                <tr className={'border-t ' + border}>
                                                    <td className="px-3 py-2">
                                                        {model.channels.length ? (
                                                            <button
                                                                type="button"
                                                                aria-expanded={open.has(model.model)}
                                                                onClick={() => toggle(model.model)}
                                                                className="min-h-10 text-left font-semibold underline-offset-4 hover:underline"
                                                            >
                                                                <span aria-hidden="true">
                                                                    {open.has(model.model) ? '▾ ' : '▸ '}
                                                                </span>
                                                                {model.model}
                                                            </button>
                                                        ) : (
                                                            <span className="font-medium">{model.model}</span>
                                                        )}
                                                    </td>
                                                    <Amounts total={model} />
                                                </tr>
                                                {open.has(model.model) &&
                                                    model.channels.map((channel) => (
                                                        <Fragment key={JSON.stringify([channel.id, channel.group])}>
                                                            <tr
                                                                className={
                                                                    'border-t ' +
                                                                    border +
                                                                    (theme ? ' bg-slate-800/60' : ' bg-slate-50')
                                                                }
                                                            >
                                                                <td className="px-6 py-3 text-left">
                                                                    <div className="font-medium">{channel.group}</div>
                                                                    <div className={'text-xs ' + muted}>
                                                                        #{channel.id} {channel.name}
                                                                    </div>
                                                                    <button
                                                                        type="button"
                                                                        className="mt-1 text-xs underline underline-offset-2"
                                                                        aria-expanded={
                                                                            channelDetail ===
                                                                            JSON.stringify([
                                                                                model.model,
                                                                                channel.id,
                                                                                channel.group,
                                                                            ])
                                                                        }
                                                                        onClick={() => {
                                                                            const channelKey = JSON.stringify([
                                                                                model.model,
                                                                                channel.id,
                                                                                channel.group,
                                                                            ]);
                                                                            setChannelDetail(
                                                                                channelDetail === channelKey
                                                                                    ? ''
                                                                                    : channelKey,
                                                                            );
                                                                        }}
                                                                    >
                                                                        账单明细
                                                                    </button>
                                                                </td>
                                                                <Amounts total={channel} />
                                                            </tr>
                                                            {channelDetail ===
                                                                JSON.stringify([
                                                                    model.model,
                                                                    channel.id,
                                                                    channel.group,
                                                                ]) && (
                                                                <tr className={'border-t ' + border}>
                                                                    <td colSpan={7} className="p-4">
                                                                        <ChannelCharges
                                                                            key={key + channelDetail}
                                                                            button={button}
                                                                            query={new URLSearchParams({
                                                                                ...range,
                                                                                model: model.model,
                                                                                channel: String(channel.id),
                                                                                group: channel.group,
                                                                            }).toString()}
                                                                        />
                                                                    </td>
                                                                </tr>
                                                            )}
                                                        </Fragment>
                                                    ))}
                                            </Fragment>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>
                </>
            )}
            <CostImport panel={panel} button={button} onSaved={() => setRefresh((value) => value + 1)} />
        </main>
    );
}

export default function MarginDashboard() {
    return (
        <Suspense fallback={<p className="p-4">正在加载…</p>}>
            <Dashboard />
        </Suspense>
    );
}
