/**
 * 企业门户计费流水页(完整版 2026-07-24):LedgerEntry 明细(充值/扣费/调整)+ 余额快照。
 * 分页(50/页)+ 日期范围搜索 + 类型筛选。
 */
import { prisma } from '@/lib/db';
import { getEnterpriseSessionUser } from '@/lib/enterprise/session';
import { parseDay } from '@/lib/enterprise/query';
import { fmtCny, fmtCnyPrecise, fmtTime } from '../format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 计费流水' };

const PAGE_SIZE = 50;

const KIND_LABEL: Record<string, string> = {
    recharge: '充值',
    charge: '消费',
    adjustment: '调整',
    migration: '迁移',
};

export default async function EnterpriseBillingPage({
    searchParams,
}: {
    searchParams: Promise<{ page?: string; from?: string; to?: string; kind?: string }>;
}) {
    const user = (await getEnterpriseSessionUser())!;
    const sp = await searchParams;
    const account = await prisma.account.findUnique({
        where: { user_id: user.id },
        select: { id: true, balance_cny: true },
    });

    const page = Math.max(1, Math.min(10_000, Number(sp.page) || 1));
    const from = parseDay(sp.from);
    const to = parseDay(sp.to, true);
    const kindFilter = ['recharge', 'charge', 'adjustment', 'migration'].includes(sp.kind ?? '') ? sp.kind : undefined;

    const where = account
        ? {
              account_id: account.id,
              ...(kindFilter ? { kind: kindFilter } : {}),
              ...(from || to ? { created_at: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
          }
        : null;

    const [total, entries] = account
        ? await Promise.all([
              prisma.ledgerEntry.count({ where: where! }),
              prisma.ledgerEntry.findMany({
                  where: where!,
                  orderBy: { created_at: 'desc' },
                  skip: (page - 1) * PAGE_SIZE,
                  take: PAGE_SIZE,
              }),
          ])
        : [0, []];
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const qs = (p: number) => {
        const params = new URLSearchParams();
        if (sp.from) params.set('from', sp.from);
        if (sp.to) params.set('to', sp.to);
        if (kindFilter) params.set('kind', kindFilter);
        params.set('page', String(p));
        return `?${params.toString()}`;
    };

    return (
        <div className="space-y-4">
            <div className="rounded-xl border border-gray-200 bg-white p-5">
                <p className="text-xs text-gray-500">当前余额</p>
                <p className="mt-1 text-2xl font-semibold text-blue-700">
                    {fmtCny(account ? Number(account.balance_cny) : 0)}
                </p>
                <p className="mt-1 text-xs text-gray-400">充值走对公转账,打款确认后由商务入账。</p>
            </div>
            <section className="rounded-xl border border-gray-200 bg-white p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold text-gray-900">
                        流水明细(共 {total.toLocaleString('en-US')} 条)
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
                            name="kind"
                            defaultValue={kindFilter ?? ''}
                            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                        >
                            <option value="">全部类型</option>
                            <option value="charge">消费</option>
                            <option value="recharge">充值</option>
                            <option value="adjustment">调整</option>
                        </select>
                        <button
                            type="submit"
                            className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
                        >
                            查询
                        </button>
                        {(sp.from || sp.to || kindFilter) && (
                            <a href="?" className="text-xs text-blue-600 hover:underline">
                                清除
                            </a>
                        )}
                        <a
                            href={`/api/enterprise/export/billing?${new URLSearchParams({
                                ...(sp.from ? { from: sp.from } : {}),
                                ...(sp.to ? { to: sp.to } : {}),
                                ...(kindFilter ? { kind: kindFilter } : {}),
                            }).toString()}`}
                            className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                        >
                            导出 CSV
                        </a>
                    </form>
                </div>
                <p className="mb-2 text-xs text-gray-400">
                    消费的「时间」为任务<b>完成扣费</b>的时刻(视频生成需数分钟,晚于「调用日志」里的任务创建时间);
                    对账请以「关联任务」列的任务 ID 为准。
                </p>
                {entries.length === 0 ? (
                    <p className="text-sm text-gray-500">暂无流水。</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="text-xs text-gray-500">
                                <tr>
                                    <th className="py-1 pr-4">时间</th>
                                    <th className="py-1 pr-4">类型</th>
                                    <th className="py-1 pr-4">金额</th>
                                    <th className="py-1 pr-4">余额快照</th>
                                    <th className="py-1 pr-4">备注</th>
                                    <th className="py-1">关联任务</th>
                                </tr>
                            </thead>
                            <tbody>
                                {entries.map((e) => {
                                    const amt = Number(e.amount_cny);
                                    return (
                                        <tr key={e.id} className="border-t border-gray-100">
                                            <td className="py-2 pr-4 text-gray-600">{fmtTime(e.created_at)}</td>
                                            <td className="py-2 pr-4">{KIND_LABEL[e.kind] ?? e.kind}</td>
                                            <td className={`py-2 pr-4 ${amt < 0 ? 'text-gray-900' : 'text-green-700'}`}>
                                                {amt < 0 ? fmtCnyPrecise(amt) : `+${fmtCny(amt)}`}
                                            </td>
                                            <td className="py-2 pr-4 text-gray-600">{fmtCny(e.balance_after)}</td>
                                            <td className="py-2 pr-4 text-gray-500">{e.note ?? '—'}</td>
                                            <td className="py-2 font-mono text-xs text-gray-500">{e.ref ?? '—'}</td>
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
            </section>
        </div>
    );
}
