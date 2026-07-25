/**
 * 企业门户概览页(2026-07-24 改 silkroadai 暖纸风):5 张 KPI 卡(余额/累计消费/生成次数/
 * 统计 tokens/本期消费)+ 最近任务 + 接入信息。数据本库直读(Account/LedgerEntry/
 * seedance_video_tasks),不碰 new-api。
 */
import { prisma } from '@/lib/db';
import { getEnterpriseSessionUser } from '@/lib/enterprise/session';
import { ENTERPRISE_TIER } from '@/lib/enterprise/billing';
import { reconcileStaleTasks } from '@/lib/enterprise/reconcile';
import { fmtCny, fmtCnyPrecise, fmtTime, fmtTokens, taskStatusLabel } from './format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 概览' };

const ENTRY_BASE = process.env.NEXT_PUBLIC_ENTERPRISE_BASE_URL || 'http://128.241.232.23';

/** 本期 = 当月(北京时区)。 */
function monthStart(): Date {
    const now = new Date();
    const bj = new Date(now.getTime() + 8 * 3600_000);
    return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), 1) - 8 * 3600_000);
}

export default async function EnterpriseOverviewPage() {
    const user = (await getEnterpriseSessionUser())!; // layout 已守门

    await reconcileStaleTasks(user.id); // 补齐滞留任务(状态/漏收)

    const account = await prisma.account.findUnique({
        where: { user_id: user.id },
        select: { id: true, balance_cny: true },
    });
    const acctId = account?.id;
    const [spentAgg, monthAgg, taskCount, tokenAgg, recent] = await Promise.all([
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
    ]);
    const balance = account ? Number(account.balance_cny) : 0;
    const spent = spentAgg?._sum.amount_cny ? Math.abs(Number(spentAgg._sum.amount_cny)) : 0;
    const monthSpent = monthAgg?._sum.amount_cny ? Math.abs(Number(monthAgg._sum.amount_cny)) : 0;
    const totalTokens = tokenAgg._sum.tokens ?? BigInt(0);

    return (
        <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <StatCard label="当前余额" value={fmtCny(balance)} sub="≈ 对公转账充值" accent />
                <StatCard label="历史消费" value={fmtCny(spent)} sub="累计" />
                <StatCard label="生成任务数" value={taskCount.toLocaleString('en-US')} sub="全部" />
                <StatCard label="统计 Tokens" value={fmtTokens(totalTokens)} sub="全部 · 输入+输出" />
                <StatCard label="本期消费" value={fmtCny(monthSpent)} sub="本自然月" />
            </div>

            <section className="rounded-xl border border-brand-border bg-surface p-5 shadow-card">
                <h2 className="mb-3 text-sm font-semibold text-ink">最近任务</h2>
                {recent.length === 0 ? (
                    <p className="text-sm text-minor-ink">暂无任务 —— 用 API 密钥调用视频生成后这里会显示记录。</p>
                ) : (
                    <table className="w-full text-left text-sm">
                        <thead className="text-xs text-minor-ink">
                            <tr>
                                <th className="py-1 pr-4">时间</th>
                                <th className="py-1 pr-4">模型</th>
                                <th className="py-1 pr-4">状态</th>
                                <th className="py-1">费用</th>
                            </tr>
                        </thead>
                        <tbody>
                            {recent.map((t) => (
                                <tr key={t.id} className="border-t border-brand-border">
                                    <td className="py-2 pr-4 text-muted-ink">{fmtTime(t.created_at)}</td>
                                    <td className="py-2 pr-4 text-ink">{t.model}</td>
                                    <td className="py-2 pr-4">
                                        {t.status === 'failed' ? (
                                            <span className="text-red-600">失败</span>
                                        ) : (
                                            <span className="text-muted-ink">{taskStatusLabel(t.status)}</span>
                                        )}
                                    </td>
                                    <td className="py-2 text-ink">
                                        {t.billed && t.cost_cny != null ? fmtCnyPrecise(t.cost_cny) : '—'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <p className="mt-3 text-xs text-minor-ink">
                    完整明细(分页 + 日期搜索 + 官方价/折扣对比)见「调用日志」页。
                </p>
            </section>

            <section className="rounded-xl border border-brand-border bg-surface p-5 text-sm shadow-card">
                <h2 className="mb-3 text-sm font-semibold text-ink">接入信息</h2>
                <dl className="space-y-1 text-muted-ink">
                    <div>
                        <dt className="inline font-medium text-ink">Base URL:</dt>{' '}
                        <dd className="inline font-mono">{ENTRY_BASE}/v1</dd>
                    </div>
                    <div>
                        <dt className="inline font-medium text-ink">提交:</dt>{' '}
                        <dd className="inline font-mono">POST /v1/video/generations</dd>
                    </div>
                    <div>
                        <dt className="inline font-medium text-ink">轮询:</dt>{' '}
                        <dd className="inline font-mono">GET /v1/video/generations/{'{task_id}'}</dd>
                    </div>
                    <div>
                        <dt className="inline font-medium text-ink">鉴权:</dt>{' '}
                        <dd className="inline font-mono">Authorization: Bearer sk-ent-…</dd>
                    </div>
                    <div>
                        <dt className="inline font-medium text-ink">模型:</dt>{' '}
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
        <div className="rounded-xl border border-brand-border bg-surface p-5 shadow-card">
            <p className="text-xs text-minor-ink">{label}</p>
            <p className={`mt-2 text-2xl font-semibold ${accent ? 'text-navy' : 'text-ink'}`}>{value}</p>
            {sub && <p className="mt-1 text-xs text-minor-ink">{sub}</p>}
        </div>
    );
}
