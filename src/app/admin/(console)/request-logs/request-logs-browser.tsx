'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
    EMPTY_FILTERS,
    buildLogQuery,
    formatDuration,
    formatNumber,
    groupLogs,
    logDate,
    logTime,
    taskId,
    type Filters,
    type LogRow,
    type View,
} from './request-log-display';
import { RequestLogDetail, RequestStatus } from './request-log-detail';
import styles from './request-logs.module.css';

interface ListData {
    logs: LogRow[];
    total: number;
    page: number;
    page_size: number;
    total_pages: number;
}

const views: { id: View; label: string }[] = [
    { id: 'all', label: '全部请求' },
    { id: 'failed', label: '失败请求' },
    { id: 'incomplete', label: '中断请求' },
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function LogLines({
    rows,
    expanded,
    toggle,
    onSelect,
}: {
    rows: LogRow[];
    expanded: boolean;
    toggle: () => void;
    onSelect: (id: string) => void;
}) {
    const first = rows[0];
    const task = taskId(first);
    const folded = rows.length > 1;
    const oldest = rows[rows.length - 1];
    return (
        <>
            <tr className={folded ? styles.groupRow : undefined}>
                <td>
                    <div className={styles.primaryLine}>{logTime(first.created_at)}</div>
                    <div className={styles.secondary}>{logDate(first.created_at)}</div>
                </td>
                <td>
                    <span className={styles.method}>{first.method}</span>
                    <span className={styles.pathName} title={first.path}>
                        {task ? '视频任务查询' : first.path}
                    </span>
                    {task && (
                        <div className={styles.pathDetail} title={first.path}>
                            {task}
                        </div>
                    )}
                </td>
                <td>
                    <div className={styles.primaryLine} title={first.model ?? undefined}>
                        {first.model ?? '—'}
                    </div>
                    <div className={styles.secondary} title={first.user_id ?? undefined}>
                        {first.user_id ? first.user_id.slice(0, 8) : '未识别用户'}
                        {first.streamed ? ' · 流式' : ''}
                    </div>
                </td>
                <td>
                    <RequestStatus row={first} />
                </td>
                <td className={styles.numeric}>
                    {first.input_tokens == null && first.output_tokens == null
                        ? '—'
                        : formatNumber(first.input_tokens) + ' / ' + formatNumber(first.output_tokens)}
                </td>
                <td className={styles.numeric}>{formatDuration(first.duration_ms)}</td>
                <td className={styles.rowAction}>
                    {folded ? (
                        <button type="button" className={styles.groupButton} aria-expanded={expanded} onClick={toggle}>
                            {expanded ? '收起' : '展开'} {rows.length} 条
                        </button>
                    ) : (
                        <button type="button" className={styles.textButton} onClick={() => onSelect(first.id)}>
                            详情
                        </button>
                    )}
                </td>
            </tr>
            {folded && expanded && (
                <tr className={styles.expandedRow}>
                    <td colSpan={7}>
                        <div className={styles.pollPanel}>
                            <div className={styles.secondary}>
                                {logDate(oldest.created_at)} {logTime(oldest.created_at)} 至 {logDate(first.created_at)}{' '}
                                {logTime(first.created_at)} · 当前页 {rows.length} 条查询
                            </div>
                            <ul>
                                {rows.map((row) => (
                                    <li key={row.id}>
                                        <time dateTime={row.created_at}>
                                            {logDate(row.created_at)} {logTime(row.created_at)}
                                        </time>
                                        <span>{formatDuration(row.duration_ms)}</span>
                                        <button
                                            type="button"
                                            className={styles.textButton}
                                            onClick={() => onSelect(row.id)}
                                        >
                                            详情
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </td>
                </tr>
            )}
        </>
    );
}

export function RequestLogsBrowser() {
    const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
    const [form, setForm] = useState<Filters>(EMPTY_FILTERS);
    const [view, setView] = useState<View>('all');
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [revision, setRevision] = useState(0);
    const [collapse, setCollapse] = useState(true);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [advanced, setAdvanced] = useState(false);
    const [formError, setFormError] = useState('');
    const [selected, setSelected] = useState<string | null>(null);
    const query = buildLogQuery(filters, view, page, pageSize).toString();
    const requestKey = revision + ':' + query;
    const [result, setResult] = useState<{ key: string; data?: ListData; error?: string }>();
    const loading = result?.key !== requestKey;
    const data = loading ? undefined : result.data;
    const error = loading ? undefined : result.error;

    useEffect(() => {
        const controller = new AbortController();
        async function load() {
            try {
                const response = await fetch('/api/admin/request-logs?' + query, {
                    signal: controller.signal,
                    cache: 'no-store',
                });
                if (controller.signal.aborted) return;
                if (response.status === 401 || response.status === 403) {
                    setResult({ key: requestKey, error: '登录已过期或权限不足，请重新登录。' });
                    return;
                }
                if (!response.ok) throw new Error();
                const next: ListData = await response.json();
                if (!controller.signal.aborted) {
                    if (next.page > next.total_pages) setPage(next.total_pages);
                    else setResult({ key: requestKey, data: next });
                }
            } catch {
                if (!controller.signal.aborted) setResult({ key: requestKey, error: '请求日志加载失败，请重试。' });
            }
        }
        void load();
        return () => controller.abort();
    }, [query, requestKey]);

    const update = (key: keyof Filters, value: string) => setForm((previous) => ({ ...previous, [key]: value }));
    const refresh = () => {
        setExpanded(new Set());
        setRevision((value) => value + 1);
    };
    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (form.user_id.trim() && !uuid.test(form.user_id.trim())) {
            setFormError('请输入完整的用户 UUID。');
            return;
        }
        if (form.from && form.to && form.from > form.to) {
            setFormError('开始日期应早于或等于结束日期。');
            return;
        }
        setFormError('');
        setFilters(form);
        setPage(1);
        refresh();
    }
    function reset() {
        setForm(EMPTY_FILTERS);
        setFilters(EMPTY_FILTERS);
        setFormError('');
        setView('all');
        setPage(1);
        refresh();
    }
    function movePage(next: number) {
        setExpanded(new Set());
        setPage(next);
    }
    function toggleGroup(id: string) {
        setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    const groups = groupLogs(data?.logs ?? [], collapse);
    const collapsedCount = (data?.logs.length ?? 0) - groups.length;
    const advancedCount = [filters.user_id, filters.method, filters.status_code, filters.streamed].filter((value) =>
        value.trim(),
    ).length;
    return (
        <main className={styles.workspace}>
            <header className={styles.heading}>
                <div>
                    <h1>请求日志</h1>
                    <p>排查 API 请求异常、视频任务查询及请求和响应原文。</p>
                </div>
                <button type="button" className={styles.button} onClick={refresh} disabled={loading}>
                    刷新日志
                </button>
            </header>

            <section className={styles.panel} aria-label="日志筛选">
                <div className={styles.views} aria-label="请求结果">
                    {views.map((item) => (
                        <button
                            type="button"
                            key={item.id}
                            aria-pressed={item.id === view}
                            onClick={() => {
                                setView(item.id);
                                movePage(1);
                            }}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
                <form onSubmit={submit} className={styles.filters}>
                    <div className={styles.filterGrid}>
                        <label>
                            接口路径 / 任务 ID
                            <input
                                type="search"
                                maxLength={300}
                                value={form.path}
                                onChange={(e) => update('path', e.target.value)}
                                placeholder="例 /v1/videos 或 task_…"
                            />
                        </label>
                        <label>
                            模型
                            <input
                                type="search"
                                value={form.model}
                                onChange={(e) => update('model', e.target.value)}
                                placeholder="输入模型名称"
                            />
                        </label>
                        <label>
                            开始日期
                            <input
                                type="date"
                                max={form.to || undefined}
                                value={form.from}
                                onChange={(e) => update('from', e.target.value)}
                            />
                        </label>
                        <label>
                            结束日期
                            <input
                                type="date"
                                min={form.from || undefined}
                                value={form.to}
                                onChange={(e) => update('to', e.target.value)}
                            />
                        </label>
                    </div>
                    {advanced && (
                        <div className={styles.filterGrid} id="request-log-advanced-filters">
                            <label>
                                用户 UUID
                                <input
                                    value={form.user_id}
                                    onChange={(e) => update('user_id', e.target.value)}
                                    placeholder="输入完整 UUID"
                                />
                            </label>
                            <label>
                                HTTP 方法
                                <select value={form.method} onChange={(e) => update('method', e.target.value)}>
                                    <option value="">全部</option>
                                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) => (
                                        <option key={method}>{method}</option>
                                    ))}
                                </select>
                            </label>
                            <label>
                                HTTP 状态码
                                <input
                                    type="number"
                                    min={100}
                                    max={599}
                                    value={form.status_code}
                                    onChange={(e) => update('status_code', e.target.value)}
                                    placeholder="例 404"
                                />
                            </label>
                            <label>
                                响应方式
                                <select value={form.streamed} onChange={(e) => update('streamed', e.target.value)}>
                                    <option value="">全部</option>
                                    <option value="true">流式</option>
                                    <option value="false">非流式</option>
                                </select>
                            </label>
                        </div>
                    )}
                    {formError && (
                        <div className={styles.error} role="alert">
                            {formError}
                        </div>
                    )}
                    <div className={styles.controls}>
                        <button
                            className={styles.textButton}
                            type="button"
                            aria-expanded={advanced}
                            aria-controls={advanced ? 'request-log-advanced-filters' : undefined}
                            onClick={() => setAdvanced(!advanced)}
                        >
                            {advanced ? '收起更多筛选' : '更多筛选'}
                            {advancedCount > 0 ? '（' + advancedCount + ' 项）' : ''}
                        </button>
                        <div>
                            <button className={styles.button} type="button" onClick={reset}>
                                重置
                            </button>
                            <button className={styles.primaryButton} type="submit">
                                查询
                            </button>
                        </div>
                    </div>
                </form>
            </section>

            <section className={styles.panel} aria-label="请求记录" aria-busy={loading}>
                <div className={styles.resultsHeader}>
                    <div>
                        <h2>
                            请求记录 <span aria-live="polite">{data ? formatNumber(data.total) + ' 条' : ''}</span>
                        </h2>
                        <p>
                            {collapsedCount > 0 ? '当前页已折叠 ' + collapsedCount + ' 条重复查询 · ' : ''}
                            北京时间（UTC+8）
                        </p>
                    </div>
                    <label className={styles.check}>
                        <input type="checkbox" checked={collapse} onChange={(e) => setCollapse(e.target.checked)} />
                        折叠当前页重复轮询
                    </label>
                </div>
                {error ? (
                    <div className={styles.notice} role="alert">
                        <p>{error}</p>
                        <button type="button" className={styles.button} onClick={refresh}>
                            重试
                        </button>
                    </div>
                ) : loading ? (
                    <div className={styles.notice} role="status">
                        正在加载请求日志…
                    </div>
                ) : !groups.length ? (
                    <div className={styles.notice} role="status">
                        没有符合条件的请求。
                    </div>
                ) : (
                    <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="日志列表，可横向滚动">
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th scope="col">时间</th>
                                    <th scope="col">请求</th>
                                    <th scope="col">模型 / 用户</th>
                                    <th scope="col">状态</th>
                                    <th scope="col" className={styles.numeric}>
                                        输入 / 输出 Token
                                    </th>
                                    <th scope="col" className={styles.numeric}>
                                        耗时
                                    </th>
                                    <th scope="col" className={styles.rowAction}>
                                        操作
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {groups.map((rows) => (
                                    <LogLines
                                        key={rows[0].id}
                                        rows={rows}
                                        expanded={expanded.has(rows[0].id)}
                                        toggle={() => toggleGroup(rows[0].id)}
                                        onSelect={setSelected}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {data && (
                    <footer className={styles.pagination}>
                        <label>
                            每页
                            <select
                                value={pageSize}
                                onChange={(e) => {
                                    setPageSize(Number(e.target.value));
                                    movePage(1);
                                }}
                            >
                                {[20, 50, 100].map((size) => (
                                    <option key={size}>{size}</option>
                                ))}
                            </select>
                            条
                        </label>
                        <div>
                            <button
                                type="button"
                                className={styles.button}
                                disabled={page <= 1}
                                onClick={() => movePage(page - 1)}
                            >
                                上一页
                            </button>
                            <span>
                                {data.page} / {data.total_pages}
                            </span>
                            <button
                                type="button"
                                className={styles.button}
                                disabled={page >= data.total_pages}
                                onClick={() => movePage(page + 1)}
                            >
                                下一页
                            </button>
                        </div>
                    </footer>
                )}
            </section>
            {selected && <RequestLogDetail key={selected} id={selected} onClose={() => setSelected(null)} />}
        </main>
    );
}
