/**
 * 企业门户计费流水页(P2):LedgerEntry 明细(充值/扣费/调整)+ 余额快照。最近 100 条。
 */
import { prisma } from '@/lib/db';
import { getEnterpriseSessionUser } from '@/lib/enterprise/session';
import { fmtCny, fmtCnyPrecise, fmtTime } from '../format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 计费流水' };

const KIND_LABEL: Record<string, string> = {
    recharge: '充值',
    charge: '消费',
    adjustment: '调整',
    migration: '迁移',
};

export default async function EnterpriseBillingPage() {
    const user = (await getEnterpriseSessionUser())!;
    const account = await prisma.account.findUnique({
        where: { user_id: user.id },
        select: { id: true, balance_cny: true },
    });
    const entries = account
        ? await prisma.ledgerEntry.findMany({
              where: { account_id: account.id },
              orderBy: { created_at: 'desc' },
              take: 100,
          })
        : [];

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
                <h2 className="mb-3 text-sm font-semibold text-gray-900">流水明细(最近 100 条)</h2>
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
                                    <th className="py-1">备注</th>
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
                                            <td className="py-2 text-gray-500">{e.note ?? '—'}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </div>
    );
}
