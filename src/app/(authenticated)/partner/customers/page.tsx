import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getMessages } from '@/lib/i18n/server';
import { partnerMessages } from '@/lib/i18n/messages/partner';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
    const m = await getMessages(partnerMessages);
    return { title: m.customers.title };
}

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/partner/customers', { method: 'GET', headers: { cookie } });
    return getCurrentUser(req);
}

export default async function PartnerCustomersPage() {
    const user = await getSessionUser();
    if (!user?.tenant_id) return null;
    const m = await getMessages(partnerMessages);

    const [users, total] = await Promise.all([
        prisma.user.findMany({
            where: { tenant_id: user.tenant_id },
            select: { id: true, email: true, newapi_username: true, role: true, status: true, created_at: true },
            orderBy: { created_at: 'desc' },
            take: 50,
        }),
        prisma.user.count({ where: { tenant_id: user.tenant_id } }),
    ]);

    return (
        <div className="mx-auto max-w-4xl space-y-6 p-6">
            <div>
                <h1 className="text-2xl font-bold text-portal-ink">{m.customers.title}</h1>
                <p className="mt-1 text-sm text-portal-muted">{m.customers.summary(total)}</p>
            </div>

            <div className="overflow-x-auto rounded-xl border border-portal-line">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-portal-line text-portal-muted">
                            <th className="px-4 py-3 text-left font-medium">{m.customers.email}</th>
                            <th className="px-4 py-3 text-left font-medium">{m.customers.username}</th>
                            <th className="px-4 py-3 text-center font-medium">{m.customers.status}</th>
                            <th className="px-4 py-3 text-right font-medium">{m.customers.createdAt}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.length === 0 ? (
                            <tr>
                                <td colSpan={4} className="px-4 py-8 text-center text-portal-muted">
                                    {m.customers.empty}
                                </td>
                            </tr>
                        ) : (
                            users.map((u) => (
                                <tr key={u.id} className="border-b border-portal-line/50 last:border-0">
                                    <td className="px-4 py-3 text-portal-ink">{u.email}</td>
                                    <td className="px-4 py-3 font-mono text-xs text-portal-muted">{u.newapi_username ?? '—'}</td>
                                    <td className={`px-4 py-3 text-center ${u.status === 'active' ? 'text-emerald-500' : 'text-amber-500'}`}>
                                        {u.status}
                                    </td>
                                    <td className="px-4 py-3 text-right text-xs text-portal-muted">
                                        {new Date(u.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
