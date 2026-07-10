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
import { formatDuration, formatTokens, callResult } from '../dashboard/format';
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

const INPUT =
    'h-9 px-3 text-sm text-ink rounded-lg border border-brand-border bg-surface placeholder:text-minor-ink outline-none transition-shadow focus:border-navy focus:shadow-focus';
const HEAD = 'text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border text-muted-ink';
const CELL = 'px-4 py-3 text-sm text-ink border-b border-brand-border';

export function LogsViewer() {
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

    const fetchLogs = useCallback(async (f: Filters, p: number) => {
        setLoading(true);
        setError(null);
        const params = new URLSearchParams();
        const s = toUnix(f.start);
        const e = toUnix(f.end);
        if (s) params.set('start', String(s));
        if (e) params.set('end', String(e));
        if (f.requestId.trim()) params.set('request_id', f.requestId.trim());
        if (f.token.trim()) params.set('token', f.token.trim());
        if (f.model.trim()) params.set('model', f.model.trim());
        if (f.channel.trim()) params.set('channel', f.channel.trim());
        params.set('page', String(p));
        try {
            const res = await fetch(`/api/portal/logs?${params.toString()}`);
            const data = (await res.json()) as {
                rows?: LogRow[];
                hasMore?: boolean;
                error?: string;
            };
            if (data.error === 'account_not_provisioned') {
                setError('账号尚未开通,暂无调用日志。');
                setRows([]);
                setHasMore(false);
            } else if (data.error) {
                setError('加载失败,请稍后重试。');
                setRows([]);
                setHasMore(false);
            } else {
                setRows(data.rows ?? []);
                setHasMore(!!data.hasMore);
            }
        } catch {
            setError('加载失败,请稍后重试。');
            setRows([]);
            setHasMore(false);
        } finally {
            setLoading(false);
        }
    }, []);

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
                        起始时间
                        <input
                            type="datetime-local"
                            className={INPUT}
                            value={filters.start}
                            onChange={(ev) => set('start', ev.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-ink">
                        结束时间
                        <input
                            type="datetime-local"
                            className={INPUT}
                            value={filters.end}
                            onChange={(ev) => set('end', ev.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-ink">
                        Request ID
                        <input
                            className={INPUT}
                            placeholder="精确匹配"
                            value={filters.requestId}
                            onChange={(ev) => set('requestId', ev.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-ink">
                        令牌名(Key)
                        <input
                            className={INPUT}
                            placeholder="如 prod-openai"
                            value={filters.token}
                            onChange={(ev) => set('token', ev.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-ink">
                        模型名
                        <input
                            className={INPUT}
                            placeholder="如 gpt-image-2"
                            value={filters.model}
                            onChange={(ev) => set('model', ev.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-ink">
                        渠道 ID
                        <input
                            className={INPUT}
                            placeholder="数字"
                            inputMode="numeric"
                            value={filters.channel}
                            onChange={(ev) => set('channel', ev.target.value)}
                        />
                    </label>
                </div>
                <div className="mt-3 flex justify-end">
                    <button
                        type="button"
                        onClick={onSearch}
                        disabled={loading}
                        className="inline-flex h-9 items-center rounded-lg bg-navy px-5 text-sm font-medium text-paper transition-colors hover:bg-navy-strong disabled:opacity-50"
                    >
                        {loading ? '查询中…' : '搜索'}
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
                    该时间段 / 条件下暂无调用记录
                </div>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-brand-border bg-surface shadow-card">
                    <table className="w-full border-collapse">
                        <thead>
                            <tr className="bg-paper-muted">
                                <th className={HEAD}>时间</th>
                                <th className={HEAD}>模型</th>
                                <th className={HEAD}>Key</th>
                                <th className={HEAD}>Request ID</th>
                                <th className={`${HEAD} text-right`}>时长</th>
                                <th className={`${HEAD} text-right`}>Tokens(输入/输出)</th>
                                <th className={`${HEAD} text-right`}>消耗</th>
                                <th className={`${HEAD} text-center`}>结果</th>
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
                    第 {page} 页{loading ? ' · 加载中…' : ''}
                </span>
                <div className="flex gap-2">
                    <button
                        type="button"
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page === 1 || loading}
                        className="rounded-lg border border-brand-border bg-surface px-3 py-1.5 text-xs text-navy transition-colors hover:bg-paper-muted disabled:cursor-not-allowed disabled:text-minor-ink disabled:hover:bg-surface"
                    >
                        上一页
                    </button>
                    <button
                        type="button"
                        onClick={() => setPage((p) => p + 1)}
                        disabled={!hasMore || loading}
                        className="rounded-lg border border-brand-border bg-surface px-3 py-1.5 text-xs text-navy transition-colors hover:bg-paper-muted disabled:cursor-not-allowed disabled:text-minor-ink disabled:hover:bg-surface"
                    >
                        下一页
                    </button>
                </div>
            </div>
        </div>
    );
}

function RequestIdCell({ value }: { value: string }) {
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
                title="复制完整 Request ID"
                className="shrink-0 rounded border border-brand-border bg-surface px-1.5 py-0.5 text-[10px] text-muted-ink transition-colors hover:bg-paper-muted"
            >
                {copied ? '已复制' : '复制'}
            </button>
        </span>
    );
}

function LogRowItem({
    row,
    isError,
    isOpen,
    onToggle,
}: {
    row: LogRow;
    isError: boolean;
    isOpen: boolean;
    onToggle: () => void;
}) {
    return (
        <>
            <tr className={isOpen ? 'bg-paper-muted/40' : undefined}>
                <td className={`${CELL} whitespace-nowrap text-muted-ink`}>
                    {new Date(row.createdAt * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
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
                <td className={`${CELL} text-right tabular-nums text-muted-ink`}>{formatDuration(row.useTimeMs)}</td>
                <td className={`${CELL} text-right tabular-nums text-muted-ink`}>
                    {formatTokens(row.promptTokens, row.completionTokens, row.model)}
                </td>
                <td className={`${CELL} text-right tabular-nums font-medium`}>¥{row.costCny.toFixed(2)}</td>
                <td className={`${CELL} text-center`}>
                    {isError ? (
                        <button
                            type="button"
                            onClick={onToggle}
                            title={row.content || '调用失败'}
                            aria-expanded={isOpen}
                            className="inline-flex items-center gap-1 rounded border border-status-error-border bg-status-error-bg px-2 py-0.5 text-xs font-medium text-status-error-text"
                        >
                            失败
                            <span aria-hidden className="text-[10px]">
                                {isOpen ? '▲' : '▼'}
                            </span>
                        </button>
                    ) : (
                        <span className="inline-flex items-center rounded border border-status-success-border bg-status-success-bg px-2 py-0.5 text-xs font-medium text-status-success-text">
                            成功
                        </span>
                    )}
                </td>
            </tr>
            {isError && isOpen && (
                <tr className="bg-paper-muted/40">
                    <td colSpan={8} className="border-b border-brand-border px-4 py-2.5">
                        <p className="m-0 mb-1 text-xs font-medium text-status-error-text">错误详情</p>
                        <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-paper-muted px-3 py-2 font-mono text-xs text-ink">
                            {row.content || '(无错误详情)'}
                        </pre>
                    </td>
                </tr>
            )}
        </>
    );
}
