'use client';

/**
 * 每次调用明细表 — the customer's core ask (brief §3). One row per call,
 * merging new-api consume (type=2) + error (type=5) logs:
 *
 *   | 时间 | 模型 | 时长 | Tokens(输入/输出) | 消耗 ¥ | 结果 |
 *
 * Client island so it can paginate in place + expand a failed row to show
 * the error `content` without a server round-trip. The parent server
 * component fetches a bounded recent window, post-filters to this user, and
 * passes the merged+sorted rows down as plain serializable objects.
 *
 * 生图友好: image-generation calls report token=0 → formatTokens shows "—"
 * (not a misleading "0 / 0"); the model name + ¥ + result still read clearly.
 */
import { useState } from 'react';
import { formatDuration, formatTokens, callResult } from './format';

export interface CallRow {
    id: number;
    /** unix seconds */
    createdAt: number;
    model: string;
    useTimeMs: number;
    promptTokens: number;
    completionTokens: number;
    quota: number;
    /** ¥ cost of this call, computed server-side (quotaToCny) and passed down.
     *  This is a 'use client' island — it must NOT call quotaToCny itself, as
     *  NEWAPI_QUOTA_PER_USD / USD_TO_CNY_RATE are server-only env (undefined in
     *  the client bundle → stale 500k/7.2 defaults → ~2× over-display). */
    costCny: number;
    /** new-api log type — 2=consume(成功) / 5=error(失败) */
    type: number;
    /** error detail (only meaningful when type=5) */
    content: string;
}

const PAGE_SIZE = 20;

const HEAD = 'text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border text-muted-ink';

export function CallDetailTable({ rows }: { rows: CallRow[] }) {
    const [page, setPage] = useState(0);
    const [expanded, setExpanded] = useState<number | null>(null);

    if (rows.length === 0) {
        return (
            <div className="rounded-xl border border-brand-border bg-surface px-4 py-8 text-center text-sm text-minor-ink shadow-card">
                该时间段内暂无调用记录
            </div>
        );
    }

    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const safePage = Math.min(page, totalPages - 1);
    const start = safePage * PAGE_SIZE;
    const pageRows = rows.slice(start, start + PAGE_SIZE);

    return (
        <div>
            <div className="overflow-x-auto rounded-xl border border-brand-border bg-surface shadow-card">
                <table className="w-full border-collapse">
                    <thead>
                        <tr className="bg-paper-muted">
                            <th className={HEAD}>时间</th>
                            <th className={HEAD}>模型</th>
                            <th className={`${HEAD} text-right`}>时长</th>
                            <th className={`${HEAD} text-right`}>Tokens(输入/输出)</th>
                            <th className={`${HEAD} text-right`}>消耗</th>
                            <th className={`${HEAD} text-center`}>结果</th>
                        </tr>
                    </thead>
                    <tbody>
                        {pageRows.map((row) => {
                            const result = callResult(row.type);
                            const isError = result === 'error';
                            const isOpen = expanded === row.id;
                            return (
                                <CallRowItem
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

            <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-ink">
                <span className="tabular-nums">
                    共 {rows.length.toLocaleString('en-US')} 条 · 第 {safePage + 1} / {totalPages} 页
                </span>
                <div className="flex gap-2">
                    <button
                        type="button"
                        onClick={() => setPage(Math.max(0, safePage - 1))}
                        disabled={safePage === 0}
                        className="rounded-lg border border-brand-border bg-surface px-3 py-1.5 text-xs text-navy transition-colors hover:bg-paper-muted disabled:cursor-not-allowed disabled:text-minor-ink disabled:hover:bg-surface"
                    >
                        上一页
                    </button>
                    <button
                        type="button"
                        onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
                        disabled={safePage >= totalPages - 1}
                        className="rounded-lg border border-brand-border bg-surface px-3 py-1.5 text-xs text-navy transition-colors hover:bg-paper-muted disabled:cursor-not-allowed disabled:text-minor-ink disabled:hover:bg-surface"
                    >
                        下一页
                    </button>
                </div>
            </div>
        </div>
    );
}

/** A call row + its optional expanded error-detail sub-row. */
function CallRowItem({
    row,
    isError,
    isOpen,
    onToggle,
}: {
    row: CallRow;
    isError: boolean;
    isOpen: boolean;
    onToggle: () => void;
}) {
    const cell = 'px-4 py-3 text-sm text-ink border-b border-brand-border';
    return (
        <>
            <tr className={isOpen ? 'bg-paper-muted/40' : undefined}>
                <td className={`${cell} whitespace-nowrap text-muted-ink`}>
                    {new Date(row.createdAt * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                </td>
                <td className={`${cell} font-mono text-xs`}>{row.model || '<unknown>'}</td>
                <td className={`${cell} text-right tabular-nums text-muted-ink`}>{formatDuration(row.useTimeMs)}</td>
                <td className={`${cell} text-right tabular-nums text-muted-ink`}>
                    {formatTokens(row.promptTokens, row.completionTokens)}
                </td>
                <td className={`${cell} text-right tabular-nums font-medium`}>¥{row.costCny.toFixed(2)}</td>
                <td className={`${cell} text-center`}>
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
                    <td colSpan={6} className="border-b border-brand-border px-4 py-2.5">
                        <p className="m-0 mb-1 text-xs font-medium text-status-error-text">错误详情</p>
                        <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-paper-muted px-3 py-2 font-mono text-xs text-ink">
                            {row.content || '(上游未返回错误详情)'}
                        </pre>
                    </td>
                </tr>
            )}
        </>
    );
}
