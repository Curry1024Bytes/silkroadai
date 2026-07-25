/**
 * 企业门户概览页(2026-07-26):5 KPI 卡 + 模型消耗分布柱状图(近 30 天,复用主站
 * ModelConsumptionChart)+ 按模型 Top 5 —— 参考主站 dashboard 的统计组件(operator
 * 指定:是统计组件不是主题色,配色维持企业门户灰白系)。
 * 数据本库直读(Account/LedgerEntry/seedance_video_tasks),不碰 new-api。
 */
import { prisma } from '@/lib/db';
import { getEnterpriseSessionUser } from '@/lib/enterprise/session';
import { ENTERPRISE_TIER } from '@/lib/enterprise/billing';
import { reconcileStaleTasks } from '@/lib/enterprise/reconcile';
import { ModelConsumptionChart } from '@/app/(authenticated)/dashboard/model-consumption-chart';
import { fmtCny, fmtCnyPrecise, fmtTime, fmtTokens, taskStatusLabel } from './format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 概览' };

const ENTRY_BASE = process.env.NEXT_PUBLIC_ENTERPRISE_BASE_URL || 'http://128.241.232.23';
const CHART_DAYS = 30;
const TOP_MODELS = 5;

/** 本期 = 当月(北京时区)。 */
function monthStart(): Date {
    const now = new Date();
    const bj = new Date(now.getTime() + 8 * 3600_000);
    return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), 1) - 8 * 3600_000);
}

/** Date → 北京时区 YYYY-MM-DD。 */
function bjDate(d: Date): string {
    return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

export default async function EnterpriseOverviewPage() {
    const user = (await getEnterpriseSessionUser())!; // layout 已守门

    await reconcileStaleTasks(user.id); // 补齐滞留任务(状态/漏收)

    const account = await prisma.account.findUnique({
        where: { user_id: user.id },
        select: { id: true, balance_cny: true },
    });
    const acctId = account?.id;
    const chartSince = new Date(Date.now() - CHART_DAYS * 24 * 3600_000);
    const [spentAgg, monthAgg, taskCount, tokenAgg, recent, billedTasks] = await Promise.all([
        acctId
            ? prisma.ledgerEntry.aggregate({
                  where: { account_id: acctId, kind: 'charge' },
                  _sum: { amount_cny: true },
              })
            : Promise.resolve(null),
        acctId
            ? prisma.ledgerEntry.aggregate({
                  where: { account_id: acctId, kind: 'charge', created_at: { gte: monthStart() } },
                  _sum: { amount_cny: true },
              })
            : Promise.resolve(null),
        prisma.seedanceVideoTask.count({ where: { user_id: user.id, tier: ENTERPRISE_TIER } }),
        prisma.seedanceVideoTask.aggregate({
            where: { user_id: user.id, tier: ENTERPRISE_TIER, tokens: { not: null } },
            _sum: { tokens: true },
        }),
        prisma.seedanceVideoTask.findMany({
            where: { user_id: user.id, tier: ENTERPRISE_TIER },
            orderBy: { created_at: 'desc' },
            take: 5,
        }),
        // 图表/Top5 数据:近 30 天已计费任务(企业量级下直读聚合足够)
        prisma.seedanceVideoTask.findMany({
            where: {
                user_id: user.id,
                tier: ENTERPRISE_TIER,
                billed: true,
                cost_cny: { not: null },
                created_at: { gte: chartSince },
            },
            select: { model: true, cost_cny: true, created_at: true },
        }),
    ]);
    const balance = account ? Number(account.balance_cny) : 0;
    const spent = spentAgg?._sum.amount_cny ? Math.abs(Number(spentAgg._sum.amount_cny)) : 0;
    const monthSpent = monthAgg?._sum.amount_cny ? Math.abs(Number(monthAgg._sum.amount_cny)) : 0;
    const totalTokens = tokenAgg._sum.tokens ?? BigInt(0);

    // ── 按模型聚合(¥ + 次数)→ Top 5 + '其他' ──
    const byModel = new Map<string, { cny: number; count: number }>();
    for (const t of billedTasks) {
        const m = byModel.get(t.model) ?? { cny: 0, count: 0 };
        m.cny += Number(t.cost_cny);
        m.count += 1;
        byModel.set(t.model, m);
    }
    const ranked = [...byModel.entries()].sort((a, b) => b[1].cny - a[1].cny);
    const topModels = ranked.slice(0, TOP_MODELS);
    const chartModels = topModels.map(([m]) => m);
    if (ranked.length > TOP_MODELS) chartModels.push('其他');
    const totalChartCny = ranked.reduce((s, [, v]) => s + v.cny, 0);

    // ── 按天 × 模型堆叠(北京时区日桶,补齐无数据的日期)──
    const dayMap = new Map<string, Record<string, number>>();
    for (let i = CHART_DAYS - 1; i >= 0; i--) {
        dayMap.set(bjDate(new Date(Date.now() - i * 24 * 3600_000)), {});
    }
    for (const t of billedTasks) {
        const day = bjDate(t.created_at);
        const bucket = dayMap.get(day);
        if (!bucket) continue;
        const key = topModels.some(([m]) => m === t.model) ? t.model : '其他';
        bucket[key] = (bucket[key] ?? 0) + Number(t.cost_cny);
    }
    const chartByDay = [...dayMap.entries()].map(([date, values]) => ({ date, values }));

    return (
        <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <StatCard label="当前余额" value={fmtCny(balance)} sub="对公转账充值" accent />
                <StatCard label="历史消费" value={fmtCny(spent)} sub="累计" />
                <StatCard label="生成任务数" value={taskCount.toLocaleString('en-US')} sub="全部" />
                <StatCard label="统计 Tokens" value={fmtTokens(totalTokens)} sub="全部 · 输入+输出" />
                <StatCard label="本期消费" value={fmtCny(monthSpent)} sub="本自然月" />
            </div>

            <section className="rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="mb-3 text-sm font-semibold text-gray-900">模型消耗分布 · 近 {CHART_DAYS} 天</h2>
                {totalChartCny > 0 ? (
                    <ModelConsumptionChart byDay={chartByDay} models={chartModels} cnyPerQuota={1} />
                ) : (
                    <p className="text-sm text-gray-500">近 {CHART_DAYS} 天暂无消费。</p>
                )}
            </section>

            {topModels.length > 0 && (
                <section className="rounded-xl border border-gray-200 bg-white p-5">
                    <h2 className="mb-3 text-sm font-semibold text-gray-900">
                        按模型 Top {TOP_MODELS} · 近 {CHART_DAYS} 天
                    </h2>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {topModels.map(([model, v]) => {
                            const share = totalChartCny > 0 ? (v.cny / totalChartCny) * 100 : 0;
                            return (
                                <div key={model} className="rounded-lg border border-gray-100 p-4">
                                    <p className="truncate font-mono text-sm font-medium text-gray-900">{model}</p>
                                    <p className="mt-1 text-xs text-gray-500">
                                        {v.count.toLocaleString('en-US')} 次 · {fmtCny(v.cny)} · {share.toFixed(1)}%
                                    </p>
                                    <div className="mt-2 h-1.5 w-full rounded-full bg-gray-100">
                                        <div
                                            className="h-1.5 rounded-full bg-amber-500"
                                            style={{ width: `${Math.max(2, Math.min(100, share))}%` }}
                                        />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </section>
            )}

            <section className="rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="mb-3 text-sm font-semibold text-gray-900">最近任务</h2>
                {recent.length === 0 ? (
                    <p className="text-sm text-gray-500">暂无任务 —— 用 API 密钥调用视频生成后这里会显示记录。</p>
                ) : (
                    <table className="w-full text-left text-sm">
                        <thead className="text-xs text-gray-500">
                            <tr>
                                <th className="py-1 pr-4">时间</th>
                                <th className="py-1 pr-4">模型</th>
                                <th className="py-1 pr-4">状态</th>
                                <th className="py-1">费用</th>
                            </tr>
                        </thead>
                        <tbody>
                            {recent.map((t) => (
                                <tr key={t.id} className="border-t border-gray-100">
                                    <td className="py-2 pr-4 text-gray-600">{fmtTime(t.created_at)}</td>
                                    <td className="py-2 pr-4">{t.model}</td>
                                    <td className="py-2 pr-4">
                                        {t.status === 'failed' ? (
                                            <span className="text-red-600">失败</span>
                                        ) : (
                                            taskStatusLabel(t.status)
                                        )}
                                    </td>
                                    <td className="py-2">
                                        {t.billed && t.cost_cny != null ? fmtCnyPrecise(t.cost_cny) : '—'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <p className="mt-3 text-xs text-gray-400">
                    完整明细(分页 + 日期搜索 + 官方价/折扣对比 + 导出)见「调用日志」页。
                </p>
            </section>

            <section className="rounded-xl border border-gray-200 bg-white p-5 text-sm">
                <h2 className="mb-3 text-sm font-semibold text-gray-900">接入信息</h2>
                <dl className="space-y-1 text-gray-600">
                    <div>
                        <dt className="inline font-medium text-gray-800">Base URL:</dt>{' '}
                        <dd className="inline font-mono">{ENTRY_BASE}/v1</dd>
                    </div>
                    <div>
                        <dt className="inline font-medium text-gray-800">提交:</dt>{' '}
                        <dd className="inline font-mono">POST /v1/video/generations</dd>
                    </div>
                    <div>
                        <dt className="inline font-medium text-gray-800">轮询:</dt>{' '}
                        <dd className="inline font-mono">GET /v1/video/generations/{'{task_id}'}</dd>
                    </div>
                    <div>
                        <dt className="inline font-medium text-gray-800">鉴权:</dt>{' '}
                        <dd className="inline font-mono">Authorization: Bearer sk-ent-…</dd>
                    </div>
                    <div>
                        <dt className="inline font-medium text-gray-800">模型:</dt>{' '}
                        <dd className="inline">
                            seedance-2-0 / seedance-2-0-fast / seedance-2-0-mini(+ -global / -promax 版本)
                        </dd>
                    </div>
                </dl>
            </section>
        </div>
    );
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
    return (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
            <p className="text-xs text-gray-500">{label}</p>
            <p className={`mt-2 text-2xl font-semibold ${accent ? 'text-blue-700' : 'text-gray-900'}`}>{value}</p>
            {sub && <p className="mt-1 text-xs text-gray-400">{sub}</p>}
        </div>
    );
}
