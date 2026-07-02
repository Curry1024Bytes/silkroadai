/**
 * Portal /pay page — replaces the W1 Sub2API iframe-embedded UI (now at
 * page.legacy.tsx, kept for reference). Server-side gate: must have a valid
 * silkroad_session cookie, otherwise we redirect to /login.
 *
 * The form itself is a client component for interactivity (tier picker +
 * provider radio + submit button posts JSON to /api/orders, which redirects
 * to the gateway via window.location).
 *
 * W7 P2 visual: paper backdrop + Card, mirroring /login. Tier buttons +
 * provider radio cards in `pay-form.tsx` use design tokens.
 */
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getEnabledPaymentTypes } from '@/lib/payment/resolve-enabled-types';
import { Logo } from '@/components/brand/Logo';
import { Card } from '@/components/ui/Card';
import { PayForm } from './pay-form';
import { FirstRechargeBonusBanner } from './first-recharge-bonus-banner';

export const dynamic = 'force-dynamic';
export const metadata = { title: '充值 — Silk Road AI' };

/** Bridge: getCurrentUser expects a NextRequest, but a server component only
 *  has the request via `headers()`. Reconstruct a thin NextRequest carrying
 *  just the cookie header so the helper can read silkroad_session. */
async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const fakeUrl = 'http://internal/pay';
    const req = new NextRequest(fakeUrl, { method: 'GET', headers: { cookie } });
    return getCurrentUser(req);
}

export default async function PayPage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const user = await getSessionUser();
    if (!user) {
        // Forward any error/lang query so /login can surface a banner if needed.
        const params = (await searchParams) ?? {};
        const qs = new URLSearchParams();
        qs.set('next', '/pay');
        for (const [k, v] of Object.entries(params)) {
            if (typeof v === 'string') qs.set(k, v);
        }
        redirect(`/login?${qs.toString()}`);
    }

    // Enabled payment providers come from the registry filtered by the DB
    // ENABLED_PAYMENT_TYPES config. May be empty if env not configured (the
    // form handles that case with a clear message).
    let enabledTypes: string[] = [];
    try {
        enabledTypes = await getEnabledPaymentTypes();
    } catch (err) {
        console.warn('[pay] getEnabledPaymentTypes failed (rendering empty list):', err);
    }

    return (
        <main className="min-h-screen bg-paper px-4 py-8 flex justify-center">
            <Card className="w-full max-w-lg p-8">
                <header className="mb-6 flex items-center gap-3">
                    <Logo variant="primary-flat" size={28} />
                    <p className="m-0 text-xs text-minor-ink">Connecting Global Intelligence.</p>
                </header>
                <h2 className="m-0 mb-4 text-base font-semibold text-navy">账户充值</h2>
                <p className="m-0 mb-5 text-sm text-muted-ink">
                    登录账户:<strong className="text-navy">{user.email}</strong>
                </p>
                {/* W6 D1: 首充 20% bonus 横幅。only render 给还没拿过 bonus 的
                 *  user — 字段在 getCurrentUser 返回的 User 上。banner 仅 UI 提示,
                 *  真正的入账与 race-safe 防护在 executeRecharge 的事务内 CAS
                 *  lock,不依赖 banner 状态。 */}
                {user.first_recharge_bonus_granted === false && <FirstRechargeBonusBanner />}
                <PayForm enabledPaymentTypes={enabledTypes} />
                {/* 充值失败求助入口:第三方支付网关偶发超时(易支付网关侧问题),
                 *  给客户一个人工兜底渠道。文案与微信号按 operator 提供的原样展示,
                 *  微信号 select-all 方便一键复制。 */}
                <p className="m-0 mt-6 pt-4 border-t border-brand-border text-center text-xs text-muted-ink">
                    充值遇到问题?请联系微信客服 <span className="font-medium text-navy select-all">lambda_yyh充值</span>
                </p>
            </Card>
        </main>
    );
}
