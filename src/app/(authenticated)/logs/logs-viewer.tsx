'use client';
import { useLocale, useMessages } from '@/lib/i18n/client';
import { logsMessages } from '@/lib/i18n/messages/logs';

/**
 * 全功能调用日志查看器(客户「调用日志」页)。
 *
 * 顶部过滤条:日期范围(datetime-local ×2)+ Request ID / 令牌 / 模型 / 渠道 文本搜索。
 * 下面分页表格,数据来自 /api/portal/logs(服务端已折叠重试中间失败 + 脱敏错误文案)。
 * 分页是【服务端】的(new-api /api/log/ 一页 100 原始行),prev/next 走 page 参数。
 *
 * 只读、无副作用地展示;时间一律按 Asia/Shanghai 显示(gotcha #20)。结算退款、配不上预扣行的
 * 失败退款作为负金额独立行展示;配上的失败视频预扣行显示「失败」¥0(服务端已配对)。
 */
import { useCallback, useEffect, useState } from 'react';
import {
    AlertCircle,
    Check,
    CheckCircle2,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    Clipboard,
    Download,
    LoaderCircle,
    Search,
    SlidersHorizontal,
    Undo2,
} from 'lucide-react';
import { formatDuration, formatTokens, formatCacheTokens, callResult, refundLabel } from '../dashboard/format';
import { formatSignedCny } from '@/lib/format/number';
import { pickMessages, intlLocale, type Locale } from '@/lib/i18n';
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
    'h-10 w-full rounded-md border border-portal-line bg-portal-panel px-3 text-sm text-portal-ink outline-none ' +
    'placeholder:text-portal-subtle transition-colors focus:border-navy focus:ring-2 focus:ring-navy/10';
const HEAD =
    'whitespace-nowrap border-b border-portal-line px-4 py-2.5 text-left text-xs font-semibold text-portal-muted';
const CELL = 'border-b border-portal-line px-4 py-3 text-sm text-portal-ink';

interface LogsResult {
    rows: LogRow[];
    hasMore: boolean;
    error: string | null;
}

async function loadLogs(f: Filters, page: number, signal: AbortSignal, locale: Locale): Promise<LogsResult | null> {
    const copy = pickMessages(logsMessages, locale);
    const params = buildParams(f);
    params.set('page', String(page));
    try {
        const res = await fetch(`/api/portal/logs?${params.toString()}`, { signal });
        const data = (await res.json()) as {
            rows?: LogRow[];
            hasMore?: boolean;
            error?: string;
        };
        if (data.error === 'account_not_provisioned') {
            return { rows: [], hasMore: false, error: copy.errors.notProvisioned };
        }
        if (data.error) {
            return { rows: [], hasMore: false, error: copy.errors.loadFailed };
        }
        return { rows: data.rows ?? [], hasMore: !!data.hasMore, error: null };
    } catch {
        if (signal.aborted) return null;
        return { rows: [], hasMore: false, error: copy.errors.loadFailed };
    }
}

export function LogsViewer() {
    const copy = useMessages(logsMessages);
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
    const [loading, setLoading] = useState(true);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<number | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        void loadLogs(applied, page, controller.signal, locale).then((result) => {
            if (!result || controller.signal.aborted) return;
            setRows(result.rows);
            setHasMore(result.hasMore);
            setError(result.error);
            setLoading(false);
        });
        return () => controller.abort();
    }, [applied, page, locale]);

    const onSearch = () => {
        setExpanded(null);
        setError(null);
        setLoading(true);
        setPage(1);
        setApplied({ ...filters });
    };
    const goToPage = (nextPage: number) => {
        setExpanded(null);
        setError(null);
        setLoading(true);
        setPage(nextPage);
    };
    const set = (k: keyof Filters, v: string) => setFilters((f) => ({ ...f, [k]: v }));

    return (
        <div className="space-y-4">
            {/* 过滤条 */}
            <section className="overflow-hidden rounded-lg border border-portal-line bg-portal-panel shadow-portal">
                <div className="flex items-center gap-2 border-b border-portal-line px-4 py-3.5 sm:px-5">
                    <SlidersHorizontal size={17} className="text-portal-gold" strokeWidth={1.8} aria-hidden="true" />
                    <div>
                        <h2 className="m-0 text-sm font-semibold text-portal-ink">{copy.viewer.filters}</h2>
                        <p className="m-0 mt-0.5 text-xs text-portal-subtle">{copy.viewer.range}</p>
                    </div>
                </div>
                <div className="p-4 sm:p-5">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        <label className="flex flex-col gap-1.5 text-xs font-medium text-portal-muted">
                            {copy.filters.start}<input
                                type="datetime-local"
                                className={INPUT}
                                value={filters.start}
                                onChange={(ev) => set('start', ev.target.value)}
                            />
                        </label>
                        <label className="flex flex-col gap-1.5 text-xs font-medium text-portal-muted">
                            {copy.filters.end}<input
                                type="datetime-local"
                                className={INPUT}
                                value={filters.end}
                                onChange={(ev) => set('end', ev.target.value)}
                            />
                        </label>
                        <label className="flex flex-col gap-1.5 text-xs font-medium text-portal-muted">
                            {copy.table.colRequestId}<input
                                className={INPUT}
                                placeholder={copy.filters.requestIdPlaceholder}
                                value={filters.requestId}
                                onChange={(ev) => set('requestId', ev.target.value)}
                            />
                        </label>
                        <label className="flex flex-col gap-1.5 text-xs font-medium text-portal-muted">
                            {copy.filters.token}<input
                                className={INPUT}
                                placeholder={copy.filters.tokenPlaceholder}
                                value={filters.token}
                                onChange={(ev) => set('token', ev.target.value)}
                            />
                        </label>
                        <label className="flex flex-col gap-1.5 text-xs font-medium text-portal-muted">
                            {copy.filters.model}<input
                                className={INPUT}
                                placeholder={copy.filters.modelPlaceholder}
                                value={filters.model}
                                onChange={(ev) => set('model', ev.target.value)}
                            />
                        </label>
                        <label className="flex flex-col gap-1.5 text-xs font-medium text-portal-muted">
                            {copy.filters.channel}<input
                                className={INPUT}
                                placeholder={copy.filters.channelPlaceholder}
                                inputMode="numeric"
                                value={filters.channel}
                                onChange={(ev) => set('channel', ev.target.value)}
                            />
                        </label>
                    </div>
                    <div className="mt-4 flex flex-col-reverse gap-2 border-t border-portal-line pt-4 sm:flex-row sm:items-center sm:justify-end">
                        <button
                            type="button"
                            onClick={() => {
                                // 按当前过滤条件整段导出(服务端翻页拉全量);浏览器按
                                // Content-Disposition 直接下载,不离开本页。
                                window.location.assign(`/api/portal/logs/export?${buildParams(filters).toString()}`);
                            }}
                            title={copy.filters.exportTitle}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-portal-line bg-portal-panel px-4 text-sm font-medium text-portal-muted transition-colors hover:bg-portal-soft hover:text-portal-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/20"
                        >
                            <Download size={16} strokeWidth={1.8} aria-hidden="true" />
                            {copy.filters.exportCsv}</button>
                        <button
                            type="button"
                            onClick={onSearch}
                            disabled={loading}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-navy px-5 text-sm font-semibold text-white transition-colors hover:bg-navy-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {loading ? (
                                <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                            ) : (
                                <Search size={16} strokeWidth={1.8} aria-hidden="true" />
                            )}
                            {loading ? copy.filters.searching : copy.filters.search}
                        </button>
                    </div>
                </div>
            </section>

            {/* 结果表 */}
            {error ? (
                <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-portal-line bg-portal-panel px-5 py-8 text-center shadow-portal">
                    <span className="flex h-10 w-10 items-center justify-center rounded-md bg-status-error-bg text-status-error-text">
                        <AlertCircle size={20} strokeWidth={1.8} aria-hidden="true" />
                    </span>
                    <div>
                        <p className="m-0 text-sm font-semibold text-portal-ink">{copy.viewer.failed}</p>
                        <p className="m-0 mt-1 text-sm text-portal-muted">{error}</p>
                    </div>
                </div>
            ) : loading && rows.length === 0 ? (
                <div
                    role="status"
                    className="flex min-h-40 items-center justify-center gap-2 rounded-lg border border-portal-line bg-portal-panel px-5 py-8 text-sm text-portal-muted shadow-portal"
                >
                    <LoaderCircle size={18} className="animate-spin text-portal-gold" aria-hidden="true" />
                    {copy.viewer.loading}</div>
            ) : rows.length === 0 && !loading ? (
                <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-portal-line bg-portal-panel px-5 py-8 text-center shadow-portal">
                    <span className="flex h-10 w-10 items-center justify-center rounded-md bg-portal-gold-soft text-portal-gold">
                        <Search size={19} strokeWidth={1.8} aria-hidden="true" />
                    </span>
                    <p className="m-0 text-sm font-semibold text-portal-ink">{copy.viewer.empty}</p>
                    <p className="m-0 text-xs text-portal-subtle">{copy.viewer.hint}</p>
                </div>
            ) : (
                <div
                    className="overflow-x-auto rounded-lg border border-portal-line bg-portal-panel shadow-portal"
                    aria-busy={loading}
                >
                    <table className="w-full min-w-[1080px] border-collapse">
                        <thead>
                            <tr className="bg-portal-soft">
                                <th className={HEAD}>{copy.table.colTime}</th>
                                <th className={HEAD}>{copy.table.colModel}</th>
                                <th className={HEAD}>{copy.table.colKey}</th>
                                <th className={HEAD}>{copy.table.colRequestId}</th>
                                <th className={`${HEAD} text-right`}>{copy.table.colDuration}</th>
                                <th className={`${HEAD} text-right`}>{copy.table.colTokens}</th>
                                <th className={`${HEAD} text-right`}>{copy.table.colCost}</th>
                                <th className={`${HEAD} text-center`}>{copy.table.colResult}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => {
                                const result = callResult(row.type, row.refundKind);
                                const isOpen = expanded === row.id;
                                return (
                                    <LogRowItem
                                        key={row.id}
                                        row={row}
                                        result={result}
                                        isOpen={isOpen}
                                        onToggle={() => setExpanded(isOpen ? null : row.id)}
                                    />
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* 分页(服务端)*/}
            <div className="flex items-center justify-between gap-3 text-xs text-portal-muted">
                <span className="tabular-nums">
                    {copy.pager.page(page)}{loading ? copy.pager.loading : ''}
                </span>
                <div className="flex gap-2">
                    <button
                        type="button"
                        onClick={() => goToPage(Math.max(1, page - 1))}
                        disabled={page === 1 || loading}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-portal-line bg-portal-panel px-3 text-xs font-medium text-portal-muted transition-colors hover:bg-portal-soft hover:text-portal-ink disabled:cursor-not-allowed disabled:text-portal-subtle disabled:hover:bg-portal-panel"
                    >
                        <ChevronLeft size={14} aria-hidden="true" />
                        {copy.pager.prev}</button>
                    <button
                        type="button"
                        onClick={() => goToPage(page + 1)}
                        disabled={!hasMore || loading}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-portal-line bg-portal-panel px-3 text-xs font-medium text-portal-muted transition-colors hover:bg-portal-soft hover:text-portal-ink disabled:cursor-not-allowed disabled:text-portal-subtle disabled:hover:bg-portal-panel"
                    >
                        {copy.pager.next}<ChevronRight size={14} aria-hidden="true" />
                    </button>
                </div>
            </div>
        </div>
    );
}

function RequestIdCell({ value }: { value: string }) {
    const copy = useMessages(logsMessages);
    const locale = useLocale();
    const [copied, setCopied] = useState(false);
    if (!value) return <span className="text-portal-subtle">—</span>;
    return (
        <span className="inline-flex items-center gap-1.5">
            <span className="max-w-[150px] truncate font-mono text-xs text-portal-muted" title={value}>
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
                title={copied ? copy.table.copied : copy.table.copyFullRequestId}
                aria-label={copied ? 'Request ID 已复制' : copy.table.copyFullRequestId}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-portal-subtle transition-colors hover:bg-portal-active hover:text-portal-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/20"
            >
                {copied ? <Check size={13} aria-hidden="true" /> : <Clipboard size={13} aria-hidden="true" />}
            </button>
        </span>
    );
}

function LogRowItem({
    row,
    result,
    isOpen,
    onToggle,
}: {
    row: LogRow;
    result: ReturnType<typeof callResult>;
    isOpen: boolean;
    onToggle: () => void;
}) {
    const copy = useMessages(logsMessages);
    const locale = useLocale();
    const isRefund = result === 'settlement_refund' || result === 'failure_refund';
    return (
        <>
            <tr className={isOpen ? 'bg-portal-soft' : 'transition-colors hover:bg-portal-soft/70'}>
                <td className={`${CELL} whitespace-nowrap text-portal-muted`}>
                    {new Date(row.createdAt * 1000).toLocaleString(intlLocale(locale), { timeZone: 'Asia/Shanghai' })}
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
                    <RequestIdCell value={row.requestId} />
                </td>
                <td className={`${CELL} text-right tabular-nums text-portal-muted`}>{formatDuration(row.useTimeMs)}</td>
                <td className={`${CELL} text-right tabular-nums text-portal-muted`}>
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
                <td
                    className={`${CELL} text-right tabular-nums font-medium ${isRefund ? 'text-status-warning-text' : ''}`}
                >
                    {formatSignedCny(row.costCny, { preciseSmall: result === 'settlement_refund' })}
                </td>
                <td className={`${CELL} text-center`}>
                    {isRefund ? (
                        <button
                            type="button"
                            onClick={onToggle}
                            title={row.content || refundLabel(result, locale).chip}
                            aria-expanded={isOpen}
                            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-status-warning-border bg-status-warning-bg px-2 text-xs font-medium text-status-warning-text transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-warning-text/20"
                        >
                            <Undo2 size={13} strokeWidth={1.9} aria-hidden="true" />
                            {refundLabel(result, locale).chip}
                            {isOpen ? (
                                <ChevronUp size={12} aria-hidden="true" />
                            ) : (
                                <ChevronDown size={12} aria-hidden="true" />
                            )}
                        </button>
                    ) : result === 'error' ? (
                        <button
                            type="button"
                            onClick={onToggle}
                            title={row.content || copy.table.callFailed}
                            aria-expanded={isOpen}
                            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-status-error-border bg-status-error-bg px-2 text-xs font-medium text-status-error-text transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-error-text/20"
                        >
                            <AlertCircle size={13} strokeWidth={1.9} aria-hidden="true" />
                            {copy.table.failed}{isOpen ? (
                                <ChevronUp size={12} aria-hidden="true" />
                            ) : (
                                <ChevronDown size={12} aria-hidden="true" />
                            )}
                        </button>
                    ) : (
                        <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-status-success-border bg-status-success-bg px-2 text-xs font-medium text-status-success-text">
                            <CheckCircle2 size={13} strokeWidth={1.9} aria-hidden="true" />
                            {copy.table.success}</span>
                    )}
                </td>
            </tr>
            {result !== 'success' && isOpen && (
                <tr className="bg-portal-soft">
                    <td colSpan={8} className="border-b border-portal-line px-4 py-3">
                        <p
                            className={`m-0 mb-1 text-xs font-medium ${isRefund ? 'text-status-warning-text' : 'text-status-error-text'}`}
                        >
                            {isRefund ? refundLabel(result, locale).heading : copy.table.errorDetail}
                        </p>
                        <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-portal-line bg-portal-panel px-3 py-2 font-mono text-xs text-portal-ink">
                            {row.content || copy.table.noErrorDetail}
                        </pre>
                    </td>
                </tr>
            )}
        </>
    );
}
