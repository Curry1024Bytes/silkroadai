/**
 * 运营后台 · 请求日志(2026-09-03):enterprise_request_logs 全客户明细。
 * 筛选(日期 / 客户 / 渠道 / 类型 / 结果 / 模型 / 任务号检索)+ 分页 50/页 + CSV 导出;
 * 行点进详情页看入参 / 上游响应 / 同任务时间线。superadmin 由 (panel)/layout 守门。
 */
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { buildReqlogWhere, type ReqlogFilters } from '@/lib/enterprise/request-log';
import { bjTimeStr } from '@/lib/enterprise/query';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 请求日志' };

const PAGE_SIZE = 50;

const KIND_LABEL: Record<string, string> = { submit: '提交', poll: '轮询', reconcile: '对账', asset_action: '素材' };

function resultBadge(l: { http_status: number | null; upstream_status: number | null; outcome: string | null }) {
    if (l.outcome === 'completed' || l.outcome === 'back_charged')
        return (
            <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs font-medium text-green-700">{l.outcome}</span>
        );
    if (l.outcome)
        return <span className="rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-600">{l.outcome}</span>;
    if (l.http_status != null && l.http_status >= 400)
        return (
            <span className="rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-600">
                HTTP {l.http_status}
            </span>
        );
    if (l.upstream_status != null && l.upstream_status >= 400)
        return (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                上游 {l.upstream_status}
            </span>
        );
    return <span className="text-xs text-gray-400">OK</span>;
}

export default async function EnterpriseAdminLogsPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | undefined>>;
}) {
    const sp = await searchParams;
    const filters: ReqlogFilters = {
        from: sp.from,
        to: sp.to,
        user: sp.user,
        region: sp.region,
        kind: sp.kind,
        model: sp.model,
        result: sp.result,
        q: sp.q,
    };
    const where = buildReqlogWhere(filters);
    const page = Math.max(1, Math.min(10_000, Number(sp.page) || 1));

    // 客户下拉:有 enterprise_upstream_keys 行的 User(含软删的 —— 老日志也要能按人查)
    const upstreamUsers = await prisma.enterpriseUpstreamKey.findMany({
        select: { user_id: true },
        distinct: ['user_id'],
    });
    const customerRows = await prisma.user.findMany({
        where: { id: { in: upstreamUsers.map((u) => u.user_id) } },
        select: { id: true, email: true },
        orderBy: { email: 'asc' },
    });

    const [total, logs] = await Promise.all([
        prisma.enterpriseRequestLog.count({ where }),
        prisma.enterpriseRequestLog.findMany({
            where,
            orderBy: { created_at: 'desc' },
            skip: (page - 1) * PAGE_SIZE,
            take: PAGE_SIZE,
            select: {
                id: true,
                created_at: true,
                kind: true,
                format: true,
                user_id: true,
                region: true,
                model: true,
                task_id: true,
                action: true,
                resource_id: true,
                http_status: true,
                upstream_status: true,
                cache_hit: true,
                outcome: true,
                error_code: true,
                duration_ms: true,
                upstream_ms: true,
            },
        }),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const emailById = new Map(customerRows.map((c) => [c.id, c.email]));

    const filterEntries = Object.entries({
        from: sp.from,
        to: sp.to,
        user: sp.user,
        region: sp.region,
        kind: sp.kind,
        model: sp.model,
        result: sp.result,
        q: sp.q,
    }).filter(([, v]) => v) as Array<[string, string]>;
    const qs = (p: number) => {
        const params = new URLSearchParams(filterEntries);
        params.set('page', String(p));
        return `?${params.toString()}`;
    };
    const exportHref = `/api/admin/enterprise/logs/export?${new URLSearchParams(filterEntries).toString()}`;
    const hasFilter = filterEntries.length > 0;

    return (
        <section className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-gray-900">请求日志(共 {total.toLocaleString('en-US')} 条)</h2>
                <Link href="/enterprise-admin" className="text-xs text-blue-600 hover:underline">
                    ← 返回客户面板
                </Link>
            </div>
            <form method="get" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
                <input
                    type="date"
                    name="from"
                    defaultValue={sp.from}
                    className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                />
                <span className="text-gray-400">—</span>
                <input
                    type="date"
                    name="to"
                    defaultValue={sp.to}
                    className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                />
                <select
                    name="user"
                    defaultValue={sp.user ?? ''}
                    className="max-w-[220px] rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                >
                    <option value="">全部客户</option>
                    {customerRows.map((c) => (
                        <option key={c.id} value={c.id}>
                            {c.email}
                        </option>
                    ))}
                </select>
                <select
                    name="region"
                    defaultValue={sp.region ?? ''}
                    className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                >
                    <option value="">全部渠道</option>
                    <option value="cn">国内(cn)</option>
                    <option value="global">海外(global)</option>
                    <option value="promax">proMax</option>
                    <option value="volc">火山(volc)</option>
                </select>
                <select
                    name="kind"
                    defaultValue={sp.kind ?? ''}
                    className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                >
                    <option value="">全部类型</option>
                    <option value="submit">提交</option>
                    <option value="poll">轮询</option>
                    <option value="reconcile">对账</option>
                    <option value="asset_action">素材库</option>
                </select>
                <select
                    name="result"
                    defaultValue={sp.result ?? ''}
                    className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                >
                    <option value="">全部结果</option>
                    <option value="ok">成功(2xx/3xx)</option>
                    <option value="4xx">客户侧 4xx</option>
                    <option value="5xx">服务 5xx</option>
                    <option value="upstream_err">上游报错</option>
                </select>
                <input
                    type="text"
                    name="model"
                    defaultValue={sp.model}
                    placeholder="模型名"
                    className="w-32 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                />
                <input
                    type="text"
                    name="q"
                    defaultValue={sp.q}
                    placeholder="任务/素材 ID / 客户请求号"
                    className="w-52 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                />
                <button
                    type="submit"
                    className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
                >
                    查询
                </button>
                {hasFilter && (
                    <a href="?" className="text-xs text-blue-600 hover:underline">
                        清除
                    </a>
                )}
                <a
                    href={exportHref}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                >
                    导出 CSV
                </a>
            </form>
            {logs.length === 0 ? (
                <p className="text-sm text-gray-500">没有匹配的日志。</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="text-xs text-gray-500">
                            <tr>
                                <th className="py-1 pr-4">时间(北京)</th>
                                <th className="py-1 pr-4">类型</th>
                                <th className="py-1 pr-4">客户</th>
                                <th className="py-1 pr-4">渠道</th>
                                <th className="py-1 pr-4">模型</th>
                                <th className="py-1 pr-4">任务/素材 ID</th>
                                <th className="py-1 pr-4">HTTP</th>
                                <th className="py-1 pr-4">耗时</th>
                                <th className="py-1 pr-4">结果</th>
                                <th className="py-1">详情</th>
                            </tr>
                        </thead>
                        <tbody>
                            {logs.map((l) => (
                                <tr key={l.id} className="border-t border-gray-100 align-top">
                                    <td className="py-2 pr-4 whitespace-nowrap text-gray-600">
                                        {bjTimeStr(l.created_at)}
                                    </td>
                                    <td className="py-2 pr-4">
                                        {KIND_LABEL[l.kind] ?? l.kind}
                                        {l.action && <span className="ml-1 text-xs text-gray-600">{l.action}</span>}
                                        {l.format && <span className="ml-1 text-xs text-gray-400">{l.format}</span>}
                                    </td>
                                    <td className="py-2 pr-4 text-xs">
                                        {l.user_id ? (
                                            (emailById.get(l.user_id) ?? l.user_id.slice(0, 8))
                                        ) : (
                                            <span className="text-gray-400">未鉴权</span>
                                        )}
                                    </td>
                                    <td className="py-2 pr-4">{l.region ?? '—'}</td>
                                    <td className="py-2 pr-4">{l.model ?? '—'}</td>
                                    <td className="py-2 pr-4 font-mono text-xs text-gray-500">
                                        {(l.task_id ?? l.resource_id)
                                            ? `${(l.task_id ?? l.resource_id)!.slice(0, 20)}${(l.task_id ?? l.resource_id)!.length > 20 ? '…' : ''}`
                                            : '—'}
                                    </td>
                                    <td className="py-2 pr-4">
                                        {l.http_status ?? '—'}
                                        {l.upstream_status != null && (
                                            <span className="ml-1 text-xs text-gray-400">
                                                /上游 {l.upstream_status}
                                                {l.cache_hit ? '(缓存)' : ''}
                                            </span>
                                        )}
                                    </td>
                                    <td className="py-2 pr-4 whitespace-nowrap text-xs text-gray-600">
                                        {l.duration_ms != null ? `${l.duration_ms}ms` : '—'}
                                        {l.upstream_ms != null && (
                                            <span className="text-gray-400">(上游 {l.upstream_ms})</span>
                                        )}
                                    </td>
                                    <td className="py-2 pr-4">
                                        {resultBadge(l)}
                                        {l.error_code && <p className="mt-0.5 text-xs text-red-500">{l.error_code}</p>}
                                    </td>
                                    <td className="py-2">
                                        <Link
                                            href={`/enterprise-admin/logs/${l.id}`}
                                            className="text-xs text-blue-600 hover:underline"
                                        >
                                            查看
                                        </Link>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {totalPages > 1 && (
                <div className="mt-3 flex items-center gap-3 text-sm">
                    {page > 1 ? (
                        <a href={qs(page - 1)} className="text-blue-600 hover:underline">
                            ← 上一页
                        </a>
                    ) : (
                        <span className="text-gray-300">← 上一页</span>
                    )}
                    <span className="text-gray-500">
                        {page} / {totalPages}
                    </span>
                    {page < totalPages ? (
                        <a href={qs(page + 1)} className="text-blue-600 hover:underline">
                            下一页 →
                        </a>
                    ) : (
                        <span className="text-gray-300">下一页 →</span>
                    )}
                </div>
            )}
            <p className="mt-3 text-xs text-gray-400">
                提交请求与素材库 Action 全量落库;轮询只记有信息量的(终态 / 上游报错 / 被拒),例行轮询不记。日志保留 60
                天。
            </p>
        </section>
    );
}
