/**
 * 企业门户概览页(P2):余额 / 累计消费 / 生成次数 三卡 + 最近任务 + 接入信息。
 * 数据全部本库直读(Account / LedgerEntry / seedance_video_tasks),不碰 new-api。
 */
import { prisma } from '@/lib/db';
import { getEnterpriseSessionUser } from '@/lib/enterprise/session';
import { ENTERPRISE_TIER } from '@/lib/enterprise/billing';
import { fmtCny, fmtCnyPrecise, fmtTime, taskStatusLabel } from './format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 概览' };

const ENTRY_BASE = process.env.NEXT_PUBLIC_ENTERPRISE_BASE_URL || 'http://128.241.232.23';

export default async function EnterpriseOverviewPage() {
    const user = (await getEnterpriseSessionUser())!; // layout 已守门

    const account = await prisma.account.findUnique({
        where: { user_id: user.id },
        select: { id: true, balance_cny: true },
    });
    const [spentAgg, taskCount, recent] = await Promise.all([
        account
            ? prisma.ledgerEntry.aggregate({
                  where: { account_id: account.id, kind: 'charge' },
                  _sum: { amount_cny: true },
              })
            : Promise.resolve(null),
        prisma.seedanceVideoTask.count({ where: { user_id: user.id, tier: ENTERPRISE_TIER } }),
        prisma.seedanceVideoTask.findMany({
            where: { user_id: user.id, tier: ENTERPRISE_TIER },
            orderBy: { created_at: 'desc' },
            take: 5,
        }),
    ]);
    const balance = account ? Number(account.balance_cny) : 0;
    const spent = spentAgg?._sum.amount_cny ? Math.abs(Number(spentAgg._sum.amount_cny)) : 0;

    return (
        <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-3">
                <StatCard label="可用余额" value={fmtCny(balance)} accent />
                <StatCard label="累计消费" value={fmtCny(spent)} />
                <StatCard label="生成任务数" value={String(taskCount)} />
            </div>

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
                                    <td className="py-2 pr-4">{taskStatusLabel(t.status)}</td>
                                    <td className="py-2">{t.cost_cny != null ? fmtCnyPrecise(t.cost_cny) : '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
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
                        <dd className="inline">seedance-2-0 / seedance-2-0-fast / seedance-2-0-mini</dd>
                    </div>
                    <div>
                        <dt className="inline font-medium text-gray-800">分辨率:</dt>{' '}
                        <dd className="inline">
                            <span className="font-mono">resolution</span> 参数 720p / 1080p / 4k(默认 720p;4k 仅
                            seedance-2-0);带参考图/视频自动识别,无需换模型名
                        </dd>
                    </div>
                </dl>
            </section>
        </div>
    );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
    return (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
            <p className="text-xs text-gray-500">{label}</p>
            <p className={`mt-1 text-2xl font-semibold ${accent ? 'text-blue-700' : 'text-gray-900'}`}>{value}</p>
        </div>
    );
}
