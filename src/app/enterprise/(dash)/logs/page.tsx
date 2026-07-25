/**
 * 企业门户调用日志页(完整版 2026-07-24):seedance_video_tasks 明细(计费真相表)。
 * 分页(50/页)+ 日期范围搜索 + 失败原因列(权责透明)+ 官方价/折扣/实付对比列(对账)。
 * 页面加载先跑对账器:补齐「客户提交后不再轮询」导致的滞留任务(状态/失败原因/幂等补扣费)。
 */
import { prisma } from '@/lib/db';
import { getEnterpriseSessionUser } from '@/lib/enterprise/session';
import { ENTERPRISE_TIER } from '@/lib/enterprise/billing';
import { reconcileStaleTasks } from '@/lib/enterprise/reconcile';
import { officialCostCny, type Resolution } from '@/lib/seedance/cn-billing';
import { variantForModel } from '@/lib/seedance/cn-adapter';
import { parseDay } from '@/lib/enterprise/query';
import { fmtCnyPrecise, fmtTime, fmtTokens, taskStatusLabel } from '../format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 调用日志' };

const PAGE_SIZE = 50;

export default async function EnterpriseLogsPage({
    searchParams,
}: {
    searchParams: Promise<{ page?: string; from?: string; to?: string; status?: string }>;
}) {
    const user = (await getEnterpriseSessionUser())!;
    const sp = await searchParams;

    // 对账器:补齐滞留任务(best-effort,不阻塞页面出错)
    await reconcileStaleTasks(user.id);

    const page = Math.max(1, Math.min(10_000, Number(sp.page) || 1));
    const from = parseDay(sp.from);
    const to = parseDay(sp.to, true);
    const statusFilter = ['queued', 'in_progress', 'completed', 'failed'].includes(sp.status ?? '')
        ? sp.status
        : undefined;

    const where = {
        user_id: user.id,
        tier: ENTERPRISE_TIER,
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(from || to ? { created_at: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    };
    const [total, tasks] = await Promise.all([
        prisma.seedanceVideoTask.count({ where }),
        prisma.seedanceVideoTask.findMany({
            where,
            orderBy: { created_at: 'desc' },
            skip: (page - 1) * PAGE_SIZE,
            take: PAGE_SIZE,
        }),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const qs = (p: number) => {
        const params = new URLSearchParams();
        if (sp.from) params.set('from', sp.from);
        if (sp.to) params.set('to', sp.to);
        if (statusFilter) params.set('status', statusFilter);
        params.set('page', String(p));
        return `?${params.toString()}`;
    };

    return (
        <section className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-gray-900">
                    视频生成任务(共 {total.toLocaleString('en-US')} 条)
                </h2>
                <form method="get" className="flex flex-wrap items-center gap-2 text-sm">
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
                        name="status"
                        defaultValue={statusFilter ?? ''}
                        className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                    >
                        <option value="">全部状态</option>
                        <option value="completed">已完成</option>
                        <option value="failed">失败</option>
                        <option value="queued">排队中</option>
                        <option value="in_progress">生成中</option>
                    </select>
                    <button
                        type="submit"
                        className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
                    >
                        查询
                    </button>
                    {(sp.from || sp.to || statusFilter) && (
                        <a href="?" className="text-xs text-blue-600 hover:underline">
                            清除
                        </a>
                    )}
                    <a
                        href={`/api/enterprise/export/logs?${new URLSearchParams({
                            ...(sp.from ? { from: sp.from } : {}),
                            ...(sp.to ? { to: sp.to } : {}),
                            ...(statusFilter ? { status: statusFilter } : {}),
                        }).toString()}`}
                        className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                    >
                        导出 CSV
                    </a>
                </form>
            </div>
            {tasks.length === 0 ? (
                <p className="text-sm text-gray-500">暂无任务记录。</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="text-xs text-gray-500">
                            <tr>
                                <th className="py-1 pr-4">时间</th>
                                <th className="py-1 pr-4">任务 ID</th>
                                <th className="py-1 pr-4">模型</th>
                                <th className="py-1 pr-4">时长</th>
                                <th className="py-1 pr-4">状态</th>
                                <th className="py-1 pr-4">Tokens</th>
                                <th className="py-1 pr-4">官方价</th>
                                <th className="py-1 pr-4">折扣</th>
                                <th className="py-1">实付</th>
                            </tr>
                        </thead>
                        <tbody>
                            {tasks.map((t) => {
                                const paid = t.billed && t.cost_cny != null ? Number(t.cost_cny) : null;
                                const official =
                                    paid != null && t.tokens != null
                                        ? officialCostCny(
                                              t.tokens,
                                              t.resolution as Resolution,
                                              t.has_video,
                                              variantForModel(t.model),
                                          )
                                        : null;
                                const discount =
                                    paid != null && official != null && official > 0 ? (paid / official) * 10 : null;
                                return (
                                    <tr key={t.id} className="border-t border-gray-100 align-top">
                                        <td className="py-2 pr-4 text-gray-600">{fmtTime(t.created_at)}</td>
                                        <td className="py-2 pr-4 font-mono text-xs text-gray-500">
                                            {t.id.slice(0, 24)}…
                                        </td>
                                        <td className="py-2 pr-4">{t.model}</td>
                                        <td className="py-2 pr-4">{t.duration}s</td>
                                        <td className="py-2 pr-4">
                                            {t.status === 'failed' ? (
                                                <span className="text-red-600">失败</span>
                                            ) : (
                                                taskStatusLabel(t.status)
                                            )}
                                            {t.status === 'failed' && t.fail_reason && (
                                                <p className="mt-0.5 max-w-[260px] text-xs leading-snug text-red-500">
                                                    {t.fail_reason}
                                                </p>
                                            )}
                                        </td>
                                        <td className="py-2 pr-4">{fmtTokens(t.tokens)}</td>
                                        <td className="py-2 pr-4 text-gray-400">
                                            {official != null ? <s>{fmtCnyPrecise(official)}</s> : '—'}
                                        </td>
                                        <td className="py-2 pr-4">
                                            {discount != null ? (
                                                <span className="rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-600">
                                                    {(Math.round(discount * 100) / 100).toString()}折
                                                </span>
                                            ) : (
                                                '—'
                                            )}
                                        </td>
                                        <td className="py-2 font-medium">{paid != null ? fmtCnyPrecise(paid) : '—'}</td>
                                    </tr>
                                );
                            })}
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
                官方价 = 火山引擎官方挂牌价;实付 = 官方价 × 您的折扣。费用按上游实际 token 用量计;
                失败任务不计费(失败原因见状态列)。成片直链约 24 小时过期,请及时下载。
            </p>
        </section>
    );
}
