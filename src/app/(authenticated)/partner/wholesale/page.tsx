import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getMessages } from '@/lib/i18n/server';
import { partnerMessages } from '@/lib/i18n/messages/partner';
import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
    const m = await getMessages(partnerMessages);
    return { title: m.wholesale.title };
}

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/partner/wholesale', { method: 'GET', headers: { cookie } });
    return getCurrentUser(req);
}

export default async function PartnerWholesalePage() {
    const user = await getSessionUser();
    if (!user?.tenant_id) return null;
    const m = await getMessages(partnerMessages);

    const [prices, groups] = await Promise.all([
        prisma.partnerGroupPrice.findMany({
            where: { tenant_id: user.tenant_id },
            orderBy: { group_key: 'asc' },
        }),
        prisma.channelGroup.findMany({
            where: { tenant_id: PLATFORM_TENANT_ID, enabled: true },
            select: { key: true, display_name: true },
        }),
    ]);
    const names = new Map(groups.map((group) => [group.key, group.display_name]));

    return (
        <div className="mx-auto max-w-4xl space-y-6 p-6">
            <div>
                <h1 className="text-2xl font-bold text-portal-ink">{m.wholesale.title}</h1>
                <p className="mt-1 text-sm text-portal-muted">{m.wholesale.intro}</p>
            </div>

            {prices.length === 0 ? (
                <div className="rounded-xl border border-portal-line bg-portal-panel p-8 text-center text-sm text-portal-muted">
                    {m.wholesale.empty}
                </div>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-portal-line">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-portal-line text-portal-muted">
                                <th className="px-4 py-3 text-left font-medium">{m.wholesale.group}</th>
                                <th className="px-4 py-3 text-right font-medium">{m.wholesale.wholesale}</th>
                                <th className="px-4 py-3 text-right font-medium">{m.wholesale.retail}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {prices.map((p) => (
                                <tr key={p.group_key} className="border-b border-portal-line/50 last:border-0">
                                    <td className="px-4 py-3 text-portal-ink">
                                        {names.get(p.group_key) ?? p.group_key}
                                        <span className="ml-2 font-mono text-xs text-portal-subtle">{p.group_key}</span>
                                    </td>
                                    <td className="px-4 py-3 text-right font-mono text-portal-ink">
                                        {Number(p.wholesale_ratio)}
                                    </td>
                                    <td className="px-4 py-3 text-right font-mono text-portal-ink">
                                        {p.retail_ratio != null ? Number(p.retail_ratio) : m.wholesale.closed}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <div className="rounded-xl border border-portal-line bg-portal-soft p-4 text-xs text-portal-muted">
                {m.wholesale.note}
            </div>
        </div>
    );
}
