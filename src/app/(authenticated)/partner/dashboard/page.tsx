import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/session';
import { getMessages } from '@/lib/i18n/server';
import { partnerMessages } from '@/lib/i18n/messages/partner';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
    const m = await getMessages(partnerMessages);
    return { title: m.dashboard.title };
}

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/partner/dashboard', { method: 'GET', headers: { cookie } });
    return getCurrentUser(req);
}

export default async function PartnerDashboardPage() {
    const user = await getSessionUser();
    if (!user?.tenant_id) return null;
    const m = await getMessages(partnerMessages);

    const [wallet, recentEarnings, customerCount] = await Promise.all([
        prisma.partnerWallet.findUnique({ where: { tenant_id: user.tenant_id } }),
        prisma.partnerEarning.findMany({
            where: { tenant_id: user.tenant_id },
            orderBy: { settled_at: 'desc' },
            take: 5,
        }),
        prisma.user.count({ where: { tenant_id: user.tenant_id } }),
    ]);

    const balanceCny = wallet ? Number(wallet.balance_cny) : 0;
    const totalEarned = wallet ? Number(wallet.total_earned_cny) : 0;
    const shortcuts = [
        { href: '/partner/wholesale', label: m.nav.wholesale },
        { href: '/partner/pricing', label: m.nav.pricing },
        { href: '/partner/customers', label: m.nav.customers },
        { href: '/partner/earnings', label: m.nav.earnings },
        { href: '/partner/wallet', label: m.nav.wallet },
        { href: '/partner/domain', label: m.nav.domain },
        { href: '/partner/brand', label: m.nav.brand },
    ];

    return (
        <div className="mx-auto max-w-4xl space-y-6 p-6">
            <h1 className="text-2xl font-bold text-portal-ink">{m.dashboard.title}</h1>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="rounded-xl border border-portal-line bg-portal-panel p-5">
                    <p className="text-sm text-portal-muted">{m.dashboard.balance}</p>
                    <p className="mt-1 text-2xl font-bold text-brand-accent">¥{balanceCny.toFixed(2)}</p>
                </div>
                <div className="rounded-xl border border-portal-line bg-portal-panel p-5">
                    <p className="text-sm text-portal-muted">{m.dashboard.totalEarned}</p>
                    <p className="mt-1 text-2xl font-bold text-portal-ink">¥{totalEarned.toFixed(2)}</p>
                </div>
                <div className="rounded-xl border border-portal-line bg-portal-panel p-5">
                    <p className="text-sm text-portal-muted">{m.dashboard.customers}</p>
                    <p className="mt-1 text-2xl font-bold text-portal-ink">{customerCount}</p>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {shortcuts.map(({ href, label }) => (
                    <Link
                        key={href}
                        href={href}
                        className="flex h-16 items-center justify-center rounded-xl border border-portal-line bg-portal-canvas text-sm font-medium text-portal-ink hover:bg-portal-soft"
                    >
                        {label}
                    </Link>
                ))}
            </div>

            {recentEarnings.length > 0 && (
                <div className="rounded-xl border border-portal-line bg-portal-panel p-5">
                    <h2 className="mb-4 text-sm font-semibold text-portal-ink">{m.dashboard.recent}</h2>
                    <div className="space-y-2">
                        {recentEarnings.map((e) => {
                            const profit = Number(e.profit_cny);
                            return (
                                <div key={e.id} className="flex items-center justify-between text-sm">
                                    <span className="font-mono text-xs text-portal-muted">
                                        {e.model_slug}
                                        {e.kind === 'refund' ? ` (${m.earnings.refund})` : ''}
                                    </span>
                                    <span className={profit < 0 ? 'text-red-500' : 'text-emerald-600'}>
                                        {profit < 0 ? '−' : '+'}¥{Math.abs(profit).toFixed(4)}
                                    </span>
                                    <span className="text-xs text-portal-subtle">
                                        {new Date(e.settled_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                    <Link href="/partner/earnings" className="mt-3 block text-xs text-brand-accent hover:underline">
                        {m.dashboard.viewAll}
                    </Link>
                </div>
            )}
        </div>
    );
}
