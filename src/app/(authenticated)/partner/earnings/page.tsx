import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getMessages } from '@/lib/i18n/server';
import { partnerMessages } from '@/lib/i18n/messages/partner';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
    const m = await getMessages(partnerMessages);
    return { title: m.earnings.title };
}

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/partner/earnings', { method: 'GET', headers: { cookie } });
    return getCurrentUser(req);
}

export default async function PartnerEarningsPage() {
    const user = await getSessionUser();
    if (!user?.tenant_id) return null;
    const m = await getMessages(partnerMessages);

    const [earnings, total] = await Promise.all([
        prisma.partnerEarning.findMany({
            where: { tenant_id: user.tenant_id },
            orderBy: { settled_at: 'desc' },
            take: 50,
        }),
        prisma.partnerEarning.count({ where: { tenant_id: user.tenant_id } }),
    ]);

    const totalProfit = earnings.reduce((sum, e) => sum + Number(e.profit_cny), 0);

    return (
        <div className="mx-auto max-w-5xl space-y-6 p-6">
            <div>
                <h1 className="text-2xl font-bold text-portal-ink">{m.earnings.title}</h1>
                <p className="mt-1 text-sm text-portal-muted">{m.earnings.summary(total, totalProfit.toFixed(4))}</p>
            </div>

            <div className="overflow-x-auto rounded-xl border border-portal-line">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-portal-line text-portal-muted">
                            <th className="px-4 py-3 text-left font-medium">{m.earnings.model}</th>
                            <th className="px-4 py-3 text-left font-medium">{m.earnings.group}</th>
                            <th className="px-4 py-3 text-right font-medium">{m.earnings.tokens}</th>
                            <th className="px-4 py-3 text-right font-medium">{m.earnings.cost}</th>
                            <th className="px-4 py-3 text-right font-medium">{m.earnings.revenue}</th>
                            <th className="px-4 py-3 text-right font-medium">{m.earnings.profit}</th>
                            <th className="px-4 py-3 text-right font-medium">{m.earnings.settledAt}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {earnings.length === 0 ? (
                            <tr>
                                <td colSpan={7} className="px-4 py-8 text-center text-portal-muted">
                                    {m.earnings.empty}
                                </td>
                            </tr>
                        ) : (
                            earnings.map((e) => {
                                const profit = Number(e.profit_cny);
                                const refund = e.kind === 'refund';
                                return (
                                    <tr key={e.id} className="border-b border-portal-line/50 last:border-0">
                                        <td className="px-4 py-3 font-mono text-xs text-portal-ink">
                                            {e.model_slug}
                                            {refund && (
                                                <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-500">
                                                    {m.earnings.refund}
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 font-mono text-xs text-portal-muted">{e.group_key}</td>
                                        <td className="px-4 py-3 text-right text-xs text-portal-muted">
                                            {refund ? '—' : `${e.prompt_tokens.toLocaleString()} / ${e.completion_tokens.toLocaleString()}`}
                                        </td>
                                        <td className="px-4 py-3 text-right text-portal-muted">¥{Number(e.wholesale_cny).toFixed(4)}</td>
                                        <td className="px-4 py-3 text-right text-portal-ink">¥{Number(e.retail_cny).toFixed(4)}</td>
                                        <td className={`px-4 py-3 text-right font-semibold ${profit < 0 ? 'text-red-500' : 'text-emerald-600'}`}>
                                            {profit < 0 ? '−' : '+'}¥{Math.abs(profit).toFixed(4)}
                                        </td>
                                        <td className="px-4 py-3 text-right text-xs text-portal-muted">
                                            {new Date(e.settled_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
