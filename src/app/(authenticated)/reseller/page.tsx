/**
 * /reseller — entry page (PR-U2).
 *
 * Server-side gate: when the user already has an active Reseller row,
 * redirect to /reseller/dashboard. Otherwise render the join page
 * (agreement summary + checkbox + CTA → POST /api/portal/reseller/join).
 *
 * Layout handles auth; we just need user.id to compute reseller status.
 */
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { fetchResellerStatus } from '@/lib/reseller/fetch-status';
import { JoinForm } from './join-form';
import { AgreementDisclosure } from '@/components/reseller/AgreementDisclosure';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';

export const dynamic = 'force-dynamic';
export const metadata = { title: '加入代理 — Silk Road AI' };

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/reseller', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

export default async function ResellerEntryPage() {
    const user = await getSessionUser();
    if (!user) return null; // layout gates; defensive narrowing
    const { isReseller } = await fetchResellerStatus(user.id);
    if (isReseller) redirect('/reseller/dashboard');

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <div className="flex flex-col gap-1">
                        <p className="text-xs uppercase tracking-wider text-muted-ink m-0">代理计划</p>
                        <CardTitle as="h1">加入 Silk Road AI 代理</CardTitle>
                    </div>
                </CardHeader>
                <CardContent>
                    <p className="text-sm leading-relaxed text-muted-ink mb-4">
                        将你的邀请链接分享给朋友 / 社群 / 自媒体粉丝,他们注册后的所有充值都有你的佣金, 长达{' '}
                        <strong className="text-navy">24 个月归因期</strong>。累计 GMV 越高,费率越高: Bronze 10% →
                        Silver 15% → Gold 20%。
                    </p>
                    <ul className="text-sm text-muted-ink space-y-1.5 pl-5 list-disc">
                        <li>开放注册,任意已登录用户可一键加入,无审核</li>
                        <li>注册后自动生成默认邀请码,可创建最多 10 个自定义码</li>
                        <li>客户充值后 14 天确认,每月可申请结算,单次满 ¥100 起结</li>
                    </ul>
                </CardContent>
            </Card>

            <AgreementDisclosure />

            <JoinForm />
        </div>
    );
}
