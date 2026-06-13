'use client';

/**
 * 请求日志查看 client island(superadmin 内部工具,zh-only,轻量 chrome —— 比
 * customers/ 的全 i18n+theme 机制简化,内部调试工具不值得双倍代码,brief §7
 * 允许 audit-first 偏离)。元数据 list/detail + 原文(in/out)懒加载,数据全走
 * /api/admin/request-logs*(superadmin 门 + 审计在服务端)。
 */
import { useCallback, useEffect, useState } from 'react';

interface LogRow {
    id: string;
    created_at: string;
    user_id: string | null;
    tenant_id: string | null;
    model: string | null;
    path: string;
    method: string;
    status_code: number | null;
    success: boolean;
    streamed: boolean;
    incomplete: boolean;
    input_tokens: number | null;
    output_tokens: number | null;
    input_bytes: number;
    output_bytes: number;
    duration_ms: number | null;
    input_r2_key: string | null;
    output_r2_key: string | null;
}
interface ListData {
    logs: LogRow[];
    total: number;
    page: number;
    page_size: number;
    total_pages: number;
}
interface BodyData {
    which: 'in' | 'out';
    key: string;
    total_bytes: number;
    truncated: boolean;
    body: string;
}

// gotcha #20:容器内 server TZ=UTC,显式钉北京时区。
const fmtDate = (iso: string): string =>
    new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const short = (s: string | null): string => (s ? s.slice(0, 8) : '—');

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm';
const btn = 'rounded bg-indigo-600 px-3 py-1 text-sm text-white hover:bg-indigo-700 disabled:opacity-50';
const btnGhost = 'rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50';

export function RequestLogsBrowser() {
    // 筛选(committed)
    const [filters, setFilters] = useState({
        user_id: '',
        model: '',
        status_code: '',
        success: '',
        streamed: '',
        from: '',
        to: '',
    });
    const [form, setForm] = useState(filters);
    const [page, setPage] = useState(1);
    const [data, setData] = useState<ListData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [selected, setSelected] = useState<Record<string, unknown> | null>(null);

    const fetchList = useCallback(async (p: number, f: typeof filters) => {
        setLoading(true);
        setError('');
        try {
            const params = new URLSearchParams({ page: String(p), page_size: '20' });
            for (const [k, v] of Object.entries(f)) if (v) params.set(k, v);
            const res = await fetch(`/api/admin/request-logs?${params.toString()}`);
            if (res.status === 401) {
                setError('无权限(需 superadmin)或登录已过期');
                return;
            }
            if (!res.ok) throw new Error();
            setData((await res.json()) as ListData);
        } catch {
            setError('加载请求日志失败');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchList(page, filters);
    }, [fetchList, page, filters]);

    const applyFilters = (e: React.FormEvent) => {
        e.preventDefault();
        setPage(1);
        setFilters(form);
    };

    return (
        <div className="space-y-4">
            <div>
                <h1 className="text-xl font-semibold">请求日志</h1>
                <p className="text-sm text-gray-500">
                    客户 /v1/* 调用的输入+输出捕获(superadmin only,每次查看都留审计)。
                </p>
            </div>

            <form onSubmit={applyFilters} className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col text-xs text-gray-500">
                    user_id
                    <input
                        className={inputCls}
                        value={form.user_id}
                        onChange={(e) => setForm({ ...form, user_id: e.target.value })}
                        placeholder="UUID"
                    />
                </label>
                <label className="flex flex-col text-xs text-gray-500">
                    model
                    <input
                        className={inputCls}
                        value={form.model}
                        onChange={(e) => setForm({ ...form, model: e.target.value })}
                        placeholder="模糊匹配"
                    />
                </label>
                <label className="flex flex-col text-xs text-gray-500">
                    status_code
                    <input
                        className={inputCls}
                        value={form.status_code}
                        onChange={(e) => setForm({ ...form, status_code: e.target.value })}
                        placeholder="如 200"
                    />
                </label>
                <label className="flex flex-col text-xs text-gray-500">
                    success
                    <select
                        className={inputCls}
                        value={form.success}
                        onChange={(e) => setForm({ ...form, success: e.target.value })}
                    >
                        <option value="">全部</option>
                        <option value="true">成功</option>
                        <option value="false">失败</option>
                    </select>
                </label>
                <label className="flex flex-col text-xs text-gray-500">
                    streamed
                    <select
                        className={inputCls}
                        value={form.streamed}
                        onChange={(e) => setForm({ ...form, streamed: e.target.value })}
                    >
                        <option value="">全部</option>
                        <option value="true">流式</option>
                        <option value="false">非流式</option>
                    </select>
                </label>
                <label className="flex flex-col text-xs text-gray-500">
                    从
                    <input
                        type="date"
                        className={inputCls}
                        value={form.from}
                        onChange={(e) => setForm({ ...form, from: e.target.value })}
                    />
                </label>
                <label className="flex flex-col text-xs text-gray-500">
                    到
                    <input
                        type="date"
                        className={inputCls}
                        value={form.to}
                        onChange={(e) => setForm({ ...form, to: e.target.value })}
                    />
                </label>
                <button type="submit" className={btn}>
                    筛选
                </button>
            </form>

            {error && <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>}

            {loading ? (
                <div className="py-12 text-center text-gray-500">加载中…</div>
            ) : !data || data.logs.length === 0 ? (
                <div className="rounded-xl border p-12 text-center text-gray-500">
                    暂无日志(捕获默认 off,需 operator 开)。
                </div>
            ) : (
                <>
                    <div className="overflow-x-auto rounded-xl border">
                        <table className="w-full text-xs">
                            <thead className="bg-gray-50">
                                <tr className="border-b text-left text-gray-500">
                                    <th className="px-3 py-2">时间</th>
                                    <th className="px-3 py-2">user</th>
                                    <th className="px-3 py-2">model</th>
                                    <th className="px-3 py-2">path</th>
                                    <th className="px-3 py-2">status</th>
                                    <th className="px-3 py-2">流式</th>
                                    <th className="px-3 py-2 text-right">in/out tok</th>
                                    <th className="px-3 py-2 text-right">in/out 字节</th>
                                    <th className="px-3 py-2 text-right">耗时</th>
                                    <th className="px-3 py-2"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.logs.map((r) => (
                                    <tr key={r.id} className="border-b hover:bg-gray-50">
                                        <td className="whitespace-nowrap px-3 py-2">{fmtDate(r.created_at)}</td>
                                        <td className="px-3 py-2 font-mono" title={r.user_id ?? ''}>
                                            {short(r.user_id)}
                                        </td>
                                        <td className="px-3 py-2">{r.model ?? '—'}</td>
                                        <td className="px-3 py-2">{r.path}</td>
                                        <td className="px-3 py-2">
                                            <span className={r.success ? 'text-green-600' : 'text-red-600'}>
                                                {r.status_code ?? '—'}
                                            </span>
                                            {r.incomplete && <span className="ml-1 text-amber-600">⚠中断</span>}
                                        </td>
                                        <td className="px-3 py-2">{r.streamed ? '是' : '否'}</td>
                                        <td className="px-3 py-2 text-right">
                                            {r.input_tokens ?? '—'}/{r.output_tokens ?? '—'}
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                            {r.input_bytes}/{r.output_bytes}
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                            {r.duration_ms != null ? `${r.duration_ms}ms` : '—'}
                                        </td>
                                        <td className="px-3 py-2">
                                            <button className={btnGhost} onClick={() => setSelected({ id: r.id })}>
                                                详情
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <div className="flex items-center justify-between text-sm">
                        <span className="text-gray-500">共 {data.total} 条</span>
                        <div className="flex items-center gap-2">
                            <button className={btnGhost} disabled={page <= 1} onClick={() => setPage(page - 1)}>
                                上一页
                            </button>
                            <span>
                                第 {data.page} / {data.total_pages} 页
                            </span>
                            <button
                                className={btnGhost}
                                disabled={page >= data.total_pages}
                                onClick={() => setPage(page + 1)}
                            >
                                下一页
                            </button>
                        </div>
                    </div>
                </>
            )}

            {selected && <DetailDrawer id={String(selected.id)} onClose={() => setSelected(null)} />}
        </div>
    );
}

/** 详情抽屉:拉单条元数据(view_meta)+ 按需拉 in/out 原文(view_input/output)。 */
function DetailDrawer({ id, onClose }: { id: string; onClose: () => void }) {
    const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
    const [metaError, setMetaError] = useState('');
    const [bodies, setBodies] = useState<Partial<Record<'in' | 'out', BodyData | { error: string }>>>({});
    const [loadingBody, setLoadingBody] = useState<'in' | 'out' | null>(null);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await fetch(`/api/admin/request-logs/${id}`);
                if (!res.ok) throw new Error();
                const j = (await res.json()) as { log: Record<string, unknown> };
                if (alive) setMeta(j.log);
            } catch {
                if (alive) setMetaError('加载元数据失败');
            }
        })();
        return () => {
            alive = false;
        };
    }, [id]);

    const loadBody = async (which: 'in' | 'out', full = false) => {
        setLoadingBody(which);
        try {
            const res = await fetch(`/api/admin/request-logs/${id}/body?which=${which}${full ? '&full=1' : ''}`);
            const j = await res.json();
            setBodies((b) => ({ ...b, [which]: res.ok ? (j as BodyData) : { error: j.error ?? '加载失败' } }));
        } catch {
            setBodies((b) => ({ ...b, [which]: { error: '加载失败' } }));
        } finally {
            setLoadingBody(null);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
            <div
                className="h-full w-full max-w-2xl overflow-y-auto bg-white p-5 shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="mb-3 flex items-center justify-between">
                    <h2 className="font-semibold">请求日志详情</h2>
                    <button className={btnGhost} onClick={onClose}>
                        关闭
                    </button>
                </div>
                <p className="mb-3 break-all font-mono text-xs text-gray-500">{id}</p>

                {metaError && <div className="text-sm text-red-600">{metaError}</div>}
                {meta && (
                    <pre className="mb-4 max-h-72 overflow-auto rounded bg-gray-50 p-3 text-xs">
                        {JSON.stringify(meta, null, 2)}
                    </pre>
                )}

                <div className="space-y-3">
                    {(['in', 'out'] as const).map((which) => {
                        const b = bodies[which];
                        return (
                            <div key={which} className="rounded border p-3">
                                <div className="mb-2 flex items-center gap-2">
                                    <span className="text-sm font-medium">
                                        {which === 'in' ? '输入原文' : '输出原文'}
                                    </span>
                                    <button
                                        className={btnGhost}
                                        disabled={loadingBody === which}
                                        onClick={() => loadBody(which)}
                                    >
                                        {loadingBody === which ? '加载中…' : '查看'}
                                    </button>
                                </div>
                                {b && 'error' in b && <div className="text-sm text-red-600">{b.error}</div>}
                                {b && 'body' in b && (
                                    <>
                                        {b.truncated && (
                                            <div className="mb-1 text-xs text-amber-600">
                                                已截断(共 {b.total_bytes} 字节)。
                                                <button
                                                    className="ml-1 underline"
                                                    onClick={() => loadBody(which, true)}
                                                >
                                                    加载完整
                                                </button>
                                            </div>
                                        )}
                                        <pre className="max-h-80 overflow-auto rounded bg-gray-50 p-2 text-xs">
                                            {b.body}
                                        </pre>
                                    </>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
