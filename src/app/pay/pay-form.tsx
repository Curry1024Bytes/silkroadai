'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';

/** Default tiers (CNY). Approved values from W4-1 D2 brief — adjust by
 *  editing this constant; no DB-config knob exists yet. */
const DEFAULT_TIERS_CNY = [10, 30, 100, 300, 1000];

/** Friendly label for known payment-type strings. The registry returns codes
 *  like "alipay" / "wxpay" / "stripe" — render Chinese names for portal users. */
const PROVIDER_LABEL: Record<string, string> = {
    alipay: '支付宝',
    wxpay: '微信支付',
    stripe: 'Stripe (信用卡)',
    easypay: '易支付',
};

interface OrderResponse {
    orderId: string;
    payUrl?: string | null;
    qrCode?: string | null;
    clientSecret?: string | null;
    provider?: string;
    /** Token-of-bearer access to GET /api/orders/[id]?t=… for status
     *  polling on the QR page. Issued by createOrder, single-purpose. */
    statusAccessToken?: string;
    [key: string]: unknown;
}

export function PayForm({ enabledPaymentTypes }: { enabledPaymentTypes: string[] }) {
    const [selectedTier, setSelectedTier] = useState<number | 'custom'>(DEFAULT_TIERS_CNY[2]);
    const [customAmount, setCustomAmount] = useState<string>('');
    const [paymentType, setPaymentType] = useState<string>(enabledPaymentTypes[0] ?? '');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const effectiveAmount = selectedTier === 'custom' ? Number.parseFloat(customAmount) : selectedTier;

    const canSubmit =
        Number.isFinite(effectiveAmount) && (effectiveAmount as number) > 0 && paymentType.length > 0 && !submitting;

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        setError(null);
        try {
            const r = await fetch('/api/orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    amount: effectiveAmount,
                    payment_type: paymentType,
                    is_mobile: typeof window !== 'undefined' && /Mobile|Android|iPhone/i.test(navigator.userAgent),
                }),
            });
            if (!r.ok) {
                const data = await r.json().catch(() => ({}));
                setError(typeof data?.error === 'string' ? data.error : `请求失败 (${r.status})`);
                setSubmitting(false);
                return;
            }
            const data = (await r.json()) as OrderResponse;
            // W5 D6: easypay returns a QR image URL — zpayz `qrcode`/`img`
            // shortlinks (qr.alipay.com / weixin://wxpay) fail when redirected
            // on PC (browser opens an app-download landing). Show inline
            // QR + poll status instead.
            if (data.qrCode) {
                const params = new URLSearchParams({ orderId: data.orderId });
                if (data.statusAccessToken) params.set('t', data.statusAccessToken);
                window.location.href = `/pay/qr?${params.toString()}`;
                return;
            }
            if (data.payUrl) {
                // Redirect to gateway (alipay_direct mobile / stripe).
                window.location.href = data.payUrl;
                return;
            }
            // No qrCode and no payUrl — fall back to the legacy short-link
            // route (W4 alipay_direct mobile QR landing).
            if (data.orderId) {
                window.location.href = `/pay/${encodeURIComponent(data.orderId)}`;
                return;
            }
            setError('未收到支付跳转地址,请联系管理员');
            setSubmitting(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : '网络错误,请稍后重试');
            setSubmitting(false);
        }
    }

    if (enabledPaymentTypes.length === 0) {
        return <FormError severity="banner">当前没有可用的支付方式,请联系管理员配置 ENABLED_PAYMENT_TYPES。</FormError>;
    }

    return (
        <form onSubmit={handleSubmit}>
            <fieldset className="border-0 p-0 m-0 mb-5">
                <legend className="text-sm text-muted-ink p-0 mb-2">选择金额(CNY)</legend>
                <div className="grid grid-cols-5 gap-1.5">
                    {DEFAULT_TIERS_CNY.map((tier) => {
                        const active = selectedTier === tier;
                        return (
                            <button
                                key={tier}
                                type="button"
                                onClick={() => setSelectedTier(tier)}
                                className={[
                                    'py-2.5 rounded-lg border text-sm cursor-pointer',
                                    'transition-colors duration-150 ease-brand',
                                    active
                                        ? 'bg-navy text-paper border-navy'
                                        : 'bg-paper-muted text-ink border-brand-border hover:border-navy',
                                ].join(' ')}
                            >
                                ¥{tier}
                            </button>
                        );
                    })}
                </div>
                <label className="flex items-center gap-2 mt-3">
                    <input
                        type="radio"
                        name="amount-source"
                        checked={selectedTier === 'custom'}
                        onChange={() => setSelectedTier('custom')}
                        className="accent-navy"
                    />
                    <span className="text-sm text-muted-ink">自定义金额:</span>
                    <Input
                        type="number"
                        step="0.01"
                        min="1"
                        max="99999999.99"
                        placeholder="¥"
                        value={customAmount}
                        onFocus={() => setSelectedTier('custom')}
                        onChange={(e) => setCustomAmount(e.target.value)}
                        block={false}
                        className="flex-1 h-9 text-sm"
                    />
                </label>
            </fieldset>

            <fieldset className="border-0 p-0 m-0 mb-6">
                <legend className="text-sm text-muted-ink p-0 mb-2">支付方式</legend>
                <div className="flex flex-col gap-1.5">
                    {enabledPaymentTypes.map((t) => (
                        <label
                            key={t}
                            className={[
                                'flex items-center gap-2 px-3 py-2.5 rounded-lg border cursor-pointer',
                                'transition-colors duration-150 ease-brand',
                                paymentType === t
                                    ? 'border-navy bg-paper-muted'
                                    : 'border-brand-border bg-surface hover:border-muted-ink/40',
                            ].join(' ')}
                        >
                            <input
                                type="radio"
                                name="payment-type"
                                value={t}
                                checked={paymentType === t}
                                onChange={() => setPaymentType(t)}
                                className="accent-navy"
                            />
                            <span className="text-sm text-ink">{PROVIDER_LABEL[t] ?? t}</span>
                        </label>
                    ))}
                </div>
            </fieldset>

            <FormError>{error}</FormError>

            <Button type="submit" block size="lg" loading={submitting} disabled={!canSubmit}>
                {submitting ? '正在跳转支付…' : '前往支付'}
            </Button>
        </form>
    );
}
