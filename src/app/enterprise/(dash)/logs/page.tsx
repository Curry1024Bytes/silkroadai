/**
 * 企业门户调用日志页(P2):seedance_video_tasks 明细(计费真相表)。最近 100 条。
 */
import { prisma } from '@/lib/db';
import { getEnterpriseSessionUser } from '@/lib/enterprise/session';
import { ENTERPRISE_TIER } from '@/lib/enterprise/billing';
import { fmtCnyPrecise, fmtTime, fmtTokens, taskStatusLabel } from '../format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 调用日志' };

export default async function EnterpriseLogsPage() {
    const user = (await getEnterpriseSessionUser())!;
    const tasks = await prisma.seedanceVideoTask.findMany({
        where: { user_id: user.id, tier: ENTERPRISE_TIER },
        orderBy: { created_at: 'desc' },
        take: 100,
    });

    return (
        <section className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-gray-900">视频生成任务(最近 100 条)</h2>
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
                                <th className="py-1">费用</th>
                            </tr>
                        </thead>
                        <tbody>
                            {tasks.map((t) => (
                                <tr key={t.id} className="border-t border-gray-100">
                                    <td className="py-2 pr-4 text-gray-600">{fmtTime(t.created_at)}</td>
                                    <td className="py-2 pr-4 font-mono text-xs text-gray-500">{t.id.slice(0, 24)}…</td>
                                    <td className="py-2 pr-4">{t.model}</td>
                                    <td className="py-2 pr-4">{t.duration}s</td>
                                    <td className="py-2 pr-4">{taskStatusLabel(t.status)}</td>
                                    <td className="py-2 pr-4">{fmtTokens(t.tokens)}</td>
                                    <td className="py-2">
                                        {t.billed && t.cost_cny != null ? fmtCnyPrecise(t.cost_cny) : '—'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <p className="mt-3 text-xs text-gray-400">
                费用按上游实际 token 用量 × 档位费率计;失败任务不计费。成片直链约 24 小时过期,请及时下载。
            </p>
        </section>
    );
}
