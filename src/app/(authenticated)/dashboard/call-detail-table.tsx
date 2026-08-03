'use client';

/**
 * 每次调用明细表 — the customer's core ask (brief §3). One row per call,
 * merging new-api consume (type=2) + error (type=5/6) logs:
 *
 *   | 时间 | 模型 | Key | Request ID | 时长 | Tokens(输入/输出) | 消耗 ¥ | 结果 |
 *
 * `Key` = the token alias (new-api `token_name`) so the customer can see
 * WHICH of their keys made each call; `Request ID` = new-api's per-request id
 * (copyable — it's a 40-char handle only useful if you can paste it into a
 * support message). Both added at customer request ("日志信息太少,最少显示每条
 * 请求是哪个 key 跟 request ID").
 *
 * Client island so it can paginate in place + expand a failed row to show
 * the error `content` without a server round-trip. The parent server
 * component fetches a bounded recent window, post-filters to this user, and
 * passes the merged+sorted rows down as plain serializable objects.
 *
 * Tokens 列按【计费口径】显示(perImageBilled,server 端按 other.model_price 算):按张计费的生图
 * (Gemini 生图等)token 是噪声、极不一致(1/0、9/124…)→ 显示 "—";按 token 计费的(gpt-image-2 /
 * 所有 LLM)token 就是计费依据 → 如实显示。¥ + 结果照常清晰。
 */
import { useState } from 'react';
import { Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, XCircle } from 'lucide-react';
import { formatDuration, formatTokens, formatCacheTokens, callResult } from './format';

export interface CallRow {
    id: number;
    /** unix seconds */
    createdAt: number;
    model: string;
    /** key alias (new-api token_name) — which API key made this call */
    tokenName: string;
    /** new-api request id — the customer's support / upstream-trace handle */
    requestId: string;
    useTimeMs: number;
    promptTokens: number;
    completionTokens: number;
    /** 缓存读(命中)tokens — server 端从 `other.cache_tokens` 解析(缺省 0)。
     *  Anthropic 面 promptTokens 不含这部分,是"输入 2 却 ¥0.07"的解释。 */
    cacheReadTokens: number;
    /** 缓存写(创建)tokens — server 端从 `other.cache_creation_tokens` 解析(缺省 0)。 */
    cacheWriteTokens: number;
    /** 按张计费(生图 ModelPrice)→ token 列显示 "—"(token 是噪声);false = 按 token 计费
     *  (gpt-image-2 / LLM 等)→ 显示真实 token。由 server 端按 `other.model_price` 算好传入。 */
    perImageBilled: boolean;
    quota: number;
    /** ¥ cost of this call, computed server-side (quotaToCny) and passed down.
     *  This is a 'use client' island — it must NOT call quotaToCny itself, as
     *  NEWAPI_QUOTA_PER_USD / USD_TO_CNY_RATE are server-only env (undefined in
     *  the client bundle → stale 500k/7.2 defaults → ~2× over-display). */
    costCny: number;
    /** new-api log type — 2=consume(成功) / 5=error(失败) / 6=视频任务失败·已退款(失败,¥0) */
    type: number;
    /** error / 失败详情(type=5 上游错误;type=6 已退款说明) */
    content: string;
}

const PAGE_SIZE = 20;

const HEAD =
    'text-left px-4 py-3 text-xs font-semibold border-b border-portal-line text-portal-muted whitespace-nowrap';

/** Table spans 8 columns; the expanded error-detail sub-row must match. */
const COL_SPAN = 8;

export function CallDetailTable({ rows }: { rows: CallRow[] }) {
    const [page, setPage] = useState(0);
    const [expanded, setExpanded] = useState<number | null>(null);

    if (rows.length === 0) {
        return (
            <div className="flex min-h-[156px] items-center justify-center rounded-lg border border-dashed border-portal-line bg-portal-panel px-6 text-center text-sm text-portal-subtle">
                该时间段内暂无调用记录。完成首次 API 调用后,记录会显示在这里。
            </div>
        );
    }

    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const safePage = Math.min(page, totalPages - 1);
    const start = safePage * PAGE_SIZE;
    const pageRows = rows.slice(start, start + PAGE_SIZE);

    return (
        <div>
            <div className="overflow-x-auto rounded-lg border border-portal-line bg-portal-panel shadow-portal">
                <table className="w-full border-collapse">
                    <thead>
                        <tr className="bg-portal-soft">
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

            <div className="mt-3 flex items-center justify-between gap-3 text-xs text-portal-muted">
                <span className="tabular-nums">
                    共 {rows.length.toLocaleString('en-US')} 条 · 第 {safePage + 1} / {totalPages} 页
                </span>
                <div className="flex gap-2">
                    <button
                        type="button"
                        onClick={() => setPage(Math.max(0, safePage - 1))}
                        disabled={safePage === 0}
                        className="inline-flex h-8 items-center gap-1 rounded-md border border-portal-line bg-portal-panel px-2.5 text-xs text-portal-muted transition-colors hover:bg-portal-soft hover:text-portal-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-portal-panel"
                    >
                        <ChevronLeft size={14} aria-hidden="true" />
                        上一页
                    </button>
                    <button
                        type="button"
                        onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
                        disabled={safePage >= totalPages - 1}
                        className="inline-flex h-8 items-center gap-1 rounded-md border border-portal-line bg-portal-panel px-2.5 text-xs text-portal-muted transition-colors hover:bg-portal-soft hover:text-portal-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-portal-panel"
                    >
                        下一页
                        <ChevronRight size={14} aria-hidden="true" />
                    </button>
                </div>
            </div>
        </div>
    );
}

/** Request-id cell: truncated mono id + a copy button (the full 40-char id is
 *  only useful if it can be pasted into a support message). Empty id → "—". */
function RequestIdCell({ value }: { value: string }) {
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
                        /* clipboard unavailable (insecure ctx / old browser) — no-op */
                    }
                }}
                title="复制完整 Request ID"
                aria-label={copied ? '已复制 Request ID' : '复制 Request ID'}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-portal-subtle transition-colors hover:bg-portal-active hover:text-portal-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
            >
                {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                <span className="sr-only">{copied ? '已复制' : '复制'}</span>
            </button>
        </span>
    );
}

/** 缓存读写副行(参照 new-api):仅当该调用真用了 prompt cache 才渲染,灰色小字不抢主信息。 */
function CacheTokensLine({ row }: { row: CallRow }) {
    const text = formatCacheTokens(row.cacheReadTokens, row.cacheWriteTokens, row.perImageBilled);
    if (!text) return null;
    return <span className="mt-0.5 block text-[11px] leading-tight text-minor-ink">{text}</span>;
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
    const cell = 'px-4 py-3 text-sm text-portal-ink border-b border-portal-line';
    return (
        <>
            <tr className={isOpen ? 'bg-portal-soft' : 'transition-colors hover:bg-portal-soft/70'}>
                <td className={`${cell} whitespace-nowrap text-portal-muted`}>
                    {new Date(row.createdAt * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                </td>
                <td className={`${cell} font-mono text-xs`}>{row.model || '<unknown>'}</td>
                <td className={`${cell} text-xs`}>
                    <span
                        className="inline-block max-w-[140px] truncate align-bottom"
                        title={row.tokenName || undefined}
                    >
                        {row.tokenName || '—'}
                    </span>
                </td>
                <td className={cell}>
                    <RequestIdCell value={row.requestId} />
                </td>
                <td className={`${cell} text-right tabular-nums text-portal-muted`}>{formatDuration(row.useTimeMs)}</td>
                <td className={`${cell} text-right tabular-nums text-portal-muted`}>
                    {formatTokens(row.promptTokens, row.completionTokens, row.perImageBilled)}
                    <CacheTokensLine row={row} />
                </td>
                <td className={`${cell} text-right tabular-nums font-medium`}>¥{row.costCny.toFixed(2)}</td>
                <td className={`${cell} text-center`}>
                    {isError ? (
                        <button
                            type="button"
                            onClick={onToggle}
                            title={row.content || '调用失败'}
                            aria-expanded={isOpen}
                            className="inline-flex items-center gap-1.5 rounded bg-status-error-bg px-2 py-1 text-xs font-medium text-status-error-text transition-colors hover:bg-red-100"
                        >
                            <XCircle size={13} aria-hidden="true" />
                            失败
                            {isOpen ? (
                                <ChevronUp size={12} aria-hidden="true" />
                            ) : (
                                <ChevronDown size={12} aria-hidden="true" />
                            )}
                        </button>
                    ) : (
                        <span className="inline-flex items-center gap-1.5 rounded bg-status-success-bg px-2 py-1 text-xs font-medium text-status-success-text">
                            <CheckCircle2 size={13} aria-hidden="true" />
                            成功
                        </span>
                    )}
                </td>
            </tr>
            {isError && isOpen && (
                <tr className="bg-portal-soft">
                    <td colSpan={COL_SPAN} className="border-b border-portal-line px-4 py-3">
                        <p className="m-0 mb-1 text-xs font-medium text-status-error-text">错误详情</p>
                        <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-portal-active px-3 py-2 font-mono text-xs text-portal-ink">
                            {row.content || '(上游未返回错误详情)'}
                        </pre>
                    </td>
                </tr>
            )}
        </>
    );
}
