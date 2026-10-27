'use client';

/**
 * 全功能调用日志查看器(客户「调用日志」页)。
 *
 * 顶部过滤条:日期范围(datetime-local ×2)+ Request ID / 令牌 / 模型 / 渠道 文本搜索。
 * 下面分页表格,数据来自 /api/portal/logs(服务端已折叠重试中间失败 + 脱敏错误文案)。
 * 分页是【服务端】的(new-api /api/log/ 一页 100 原始行),prev/next 走 page 参数。
 *
 * 只读、无副作用地展示;时间一律按 Asia/Shanghai 显示(gotcha #20)。
 */
import { useCallback, useEffect, useState } from 'react';
import { intlLocale } from '@/lib/i18n';
import { useLocale, useMessages } from '@/lib/i18n/client';
import { logsMessages, type LogsMessages } from '@/lib/i18n/messages/logs';
import { formatDuration, formatTokens, formatCacheTokens, callResult } from '../dashboard/format';
import type { LogRow } from '@/app/api/portal/logs/route';

interface Filters {
    start: string;
    end: string;
    requestId: string;
    token: string;
    model: string;
    channel: string;
}

/** datetime-local(本地时区)字符串 → unix 秒。 */
function toUnix(local: string): number | undefined {
    if (!local) return undefined;
    const t = new Date(local).getTime();
    return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
}

/** 默认近 7 天(datetime-local 形态 YYYY-MM-DDTHH:mm,本地时区)。 */
function defaultRange(): { start: string; end: string } {
    const pad = (n: number) => String(n).padStart(2, '0');
    const fmt = (d: Date) =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const now = new Date();
    const start = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    return { start: fmt(start), end: fmt(now) };
}

/** 过滤条件 → query string(/api/portal/logs 与 /export 共用同一套参数)。 */
function buildParams(f: Filters): URLSearchParams {
    const params = new URLSearchParams();
    const s = toUnix(f.start);
    const e = toUnix(f.end);
    if (s) params.set('start', String(s));
    if (e) params.set('end', String(e));
    if (f.requestId.trim()) params.set('request_id', f.requestId.trim());
    if (f.token.trim()) params.set('token', f.token.trim());
    if (f.model.trim()) params.set('model', f.model.trim());
    if (f.channel.trim()) params.set('channel', f.channel.trim());
    return params;
}

const INPUT =
    'h-9 px-3 text-sm text-ink rounded-lg border border-brand-border bg-surface placeholder:text-minor-ink outline-none transition-shadow focus:border-navy focus:shadow-focus';
const HEAD = 'text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border text-muted-ink';
const CELL = 'px-4 py-3 text-sm text-ink border-b border-brand-border';

type TableMessages = LogsMessages['table'];

export function LogsViewer() {
    const m = useMessages(logsMessages);
    const locale = useLocale();
    const dr = defaultRange();
    const [filters, setFilters] = useState<Filters>({
        start: dr.start,
        end: dr.end,
        requestId: '',
        token: '',
        model: '',
        channel: '',
    });
    // 实际查询用的快照 —— 点「搜索」才更新,避免边打字边查。
    const [applied, setApplied] = useState<Filters>(filters);
    const [page, setPage] = useState(1);
    const [rows, setRows] = useState<LogRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<number | null>(null);

    const { notProvisioned, loadFailed } = m.errors;
    const fetchLogs = useCallback(
        async (f: Filters, p: number) => {
            setLoading(true);
            setError(null);
            const params = buildParams(f);
            params.set('page', String(p));
            try {
                const res = await fetch(`/api/portal/logs?${params.toString()}`);
                const data = (await res.json()) as {
                    rows?: LogRow[];
                    hasMore?: boolean;
                    error?: string;
                };
                if (data.error === 'account_not_provisioned') {
                    setError(notProvisioned);
                    setRows([]);
                    setHasMore(false);
                } else if (data.error) {
                    setError(loadFailed);
                    setRows([]);
                    setHasMore(false);
                } else {
                    setRows(data.rows ?? []);
                    setHasMore(!!data.hasMore);
                }
            } catch {
                setError(loadFailed);
                setRows([]);
                setHasMore(false);
            } finally {
                setLoading(false);
            }
        },
        [notProvisioned, loadFailed],
    );

    useEffect(() => {
        void fetchLogs(applied, page);
    }, [applied, page, fetchLogs]);

    const onSearch = () => {
        setExpanded(null);
        setPage(1);
        setApplied({ ...filters });
    };
    const set = (k: keyof Filters, v: string) => setFilters((f) => ({ ...f, [k]: v }));

    return (
        <div>
            {/* 过滤条 */}
            <div className="mb-4 rounded-xl border border-brand-border bg-surface p-4 shadow-card">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <label className="flex flex-col gap-1 text-xs text-muted-ink">
                        {m.filters.start}
                        <input
                            type="datetime-local"
                            className={INPUT}
                            value={filters.start}
                            onChange={(ev) => set('start', ev.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-ink">
                        {m.filters.end}
                        <input
                            type="datetime-local"
                            className={INPUT}
                            value={filters.end}
                            onChange={(ev) => set('end', ev.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-ink">
                        {m.filters.requestId}
                        <input
                            className={INPUT}
                            placeholder={m.filters.requestIdPlaceholder}
                            value={filters.requestId}
                            onChange={(ev) => set('requestId', ev.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-ink">
                        {m.filters.token}
                        <input
                            className={INPUT}
                            placeholder={m.filters.tokenPlaceholder}
                            value={filters.token}
                            onChange={(ev) => set('token', ev.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-ink">
                        {m.filters.model}
                        <input
                            className={INPUT}
                            placeholder={m.filters.modelPlaceholder}
                            value={filters.model}
                            onChange={(ev) => set('model', ev.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-ink">
                        {m.filters.channel}
                        <input
                            className={INPUT}
                            placeholder={m.filters.channelPlaceholder}
                            inputMode="numeric"
                            value={filters.channel}
                            onChange={(ev) => set('channel', ev.target.value)}
                        />
                    </label>
                </div>
                <div className="mt-3 flex items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={() => {
                            // 按当前过滤条件整段导出(服务端翻页拉全量);浏览器按
                            // Content-Disposition 直接下载,不离开本页。
                            window.location.assign(`/api/portal/logs/export?${buildParams(filters).toString()}`);
                        }}
                        title={m.filters.exportTitle}
                        className="inline-flex h-9 items-center rounded-lg border border-brand-border bg-surface px-4 text-sm font-medium text-navy transition-colors hover:bg-paper-muted"
                    >
                        {m.filters.exportCsv}
                    </button>
                    <button
                        type="button"
                        onClick={onSearch}
                        disabled={loading}
                        className="inline-flex h-9 items-center rounded-lg bg-navy px-5 text-sm font-medium text-paper transition-colors hover:bg-navy-strong disabled:opacity-50"
                    >
                        {loading ? m.filters.searching : m.filters.search}
                    </button>
                </div>
            </div>

            {/* 结果表 */}
            {error ? (
                <div className="rounded-xl border border-brand-border bg-surface px-4 py-8 text-center text-sm text-minor-ink shadow-card">
                    {error}
                </div>
            ) : rows.length === 0 && !loading ? (
                <div className="rounded-xl border border-brand-border bg-surface px-4 py-8 text-center text-sm text-minor-ink shadow-card">
                    {m.empty}
                </div>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-brand-border bg-surface shadow-card">
                    <table className="w-full border-collapse">
                        <thead>
                            <tr className="bg-paper-muted">
                                <th className={HEAD}>{m.table.colTime}</th>
                                <th className={HEAD}>{m.table.colModel}</th>
                                <th className={HEAD}>{m.table.colKey}</th>
                                <th className={HEAD}>{m.table.colRequestId}</th>
                                <th className={`${HEAD} text-right`}>{m.table.colDuration}</th>
                                <th className={`${HEAD} text-right`}>{m.table.colTokens}</th>
                                <th className={`${HEAD} text-right`}>{m.table.colCost}</th>
                                <th className={`${HEAD} text-center`}>{m.table.colResult}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => {
                                const isError = callResult(row.type) === 'error';
                                const isOpen = expanded === row.id;
                                return (
                                    <LogRowItem
                                        key={row.id}
                                        row={row}
                                        isError={isError}
                                        isOpen={isOpen}
                                        onToggle={() => setExpanded(isOpen ? null : row.id)}
                                        m={m.table}
                                        intl={intlLocale(locale)}
                                    />
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* 分页(服务端)*/}
            <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-ink">
                <span className="tabular-nums">
                    {m.pager.page(page)}
                    {loading ? m.pager.loading : ''}
                </span>
                <div className="flex gap-2">
                    <button
                        type="button"
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page === 1 || loading}
                        className="rounded-lg border border-brand-border bg-surface px-3 py-1.5 text-xs text-navy transition-colors hover:bg-paper-muted disabled:cursor-not-allowed disabled:text-minor-ink disabled:hover:bg-surface"
                    >
                        {m.pager.prev}
                    </button>
                    <button
                        type="button"
                        onClick={() => setPage((p) => p + 1)}
                        disabled={!hasMore || loading}
                        className="rounded-lg border border-brand-border bg-surface px-3 py-1.5 text-xs text-navy transition-colors hover:bg-paper-muted disabled:cursor-not-allowed disabled:text-minor-ink disabled:hover:bg-surface"
                    >
                        {m.pager.next}
                    </button>
                </div>
            </div>
        </div>
    );
}

function RequestIdCell({ value, m }: { value: string; m: TableMessages }) {
    const [copied, setCopied] = useState(false);
    if (!value) return <span className="text-minor-ink">—</span>;
    return (
        <span className="inline-flex items-center gap-1.5">
            <span className="max-w-[150px] truncate font-mono text-xs text-muted-ink" title={value}>
                {value}
            </span>
            <button
                type="button"
                onClick={async () => {
                    try {
                        await navigator.clipboard.writeText(value);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                    } catch {
                        /* clipboard unavailable — no-op */
                    }
                }}
                title={m.copyFullRequestId}
                className="shrink-0 rounded border border-brand-border bg-surface px-1.5 py-0.5 text-[10px] text-muted-ink transition-colors hover:bg-paper-muted"
            >
                {copied ? m.copied : m.copy}
            </button>
        </span>
    );
}

function LogRowItem({
    row,
    isError,
    isOpen,
    onToggle,
    m,
    intl,
}: {
    row: LogRow;
    isError: boolean;
    isOpen: boolean;
    onToggle: () => void;
    m: TableMessages;
    /** `Intl` tag for the time cell (always paired with Asia/Shanghai — gotcha #20). */
    intl: string;
}) {
    const locale = useLocale();
    return (
        <>
            <tr className={isOpen ? 'bg-paper-muted/40' : undefined}>
                <td className={`${CELL} whitespace-nowrap text-muted-ink`}>
                    {new Date(row.createdAt * 1000).toLocaleString(intl, { timeZone: 'Asia/Shanghai' })}
                </td>
                <td className={`${CELL} font-mono text-xs`}>{row.model || '<unknown>'}</td>
                <td className={`${CELL} text-xs`}>
                    <span
                        className="inline-block max-w-[140px] truncate align-bottom"
                        title={row.tokenName || undefined}
                    >
                        {row.tokenName || '—'}
                    </span>
                </td>
                <td className={CELL}>
                    <RequestIdCell value={row.requestId} m={m} />
                </td>
                <td className={`${CELL} text-right tabular-nums text-muted-ink`}>{formatDuration(row.useTimeMs)}</td>
                <td className={`${CELL} text-right tabular-nums text-muted-ink`}>
                    {formatTokens(row.promptTokens, row.completionTokens, row.perImageBilled)}
                    {(() => {
                        // 缓存读写副行(参照 new-api):只有真用了 prompt cache 才渲染
                        const cacheText = formatCacheTokens(
                            row.cacheReadTokens,
                            row.cacheWriteTokens,
                            row.perImageBilled,
                            locale,
                        );
                        return cacheText ? (
                            <span className="mt-0.5 block text-[11px] leading-tight text-minor-ink">{cacheText}</span>
                        ) : null;
                    })()}
                </td>
                <td className={`${CELL} text-right tabular-nums font-medium`}>¥{row.costCny.toFixed(2)}</td>
                <td className={`${CELL} text-center`}>
                    {isError ? (
                        <button
                            type="button"
                            onClick={onToggle}
                            title={row.content || m.callFailed}
                            aria-expanded={isOpen}
                            className="inline-flex items-center gap-1 rounded border border-status-error-border bg-status-error-bg px-2 py-0.5 text-xs font-medium text-status-error-text"
                        >
                            {m.failed}
                            <span aria-hidden className="text-[10px]">
                                {isOpen ? '▲' : '▼'}
                            </span>
                        </button>
                    ) : (
                        <span className="inline-flex items-center rounded border border-status-success-border bg-status-success-bg px-2 py-0.5 text-xs font-medium text-status-success-text">
                            {m.success}
                        </span>
                    )}
                </td>
            </tr>
            {isError && isOpen && (
                <tr className="bg-paper-muted/40">
                    <td colSpan={8} className="border-b border-brand-border px-4 py-2.5">
                        <p className="m-0 mb-1 text-xs font-medium text-status-error-text">{m.errorDetail}</p>
                        <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-paper-muted px-3 py-2 font-mono text-xs text-ink">
                            {row.content || m.noErrorDetail}
                        </pre>
                    </td>
                </tr>
            )}
        </>
    );
}
