'use client';

import { useState } from 'react';

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
    [key: string]: unknown;
}

export function PayForm({ enabledPaymentTypes }: { enabledPaymentTypes: string[] }) {
    const [selectedTier, setSelectedTier] = useState<number | 'custom'>(DEFAULT_TIERS_CNY[2]);
    const [customAmount, setCustomAmount] = useState<string>('');
    const [paymentType, setPaymentType] = useState<string>(enabledPaymentTypes[0] ?? '');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const effectiveAmount =
        selectedTier === 'custom'
            ? Number.parseFloat(customAmount)
            : selectedTier;

    const canSubmit =
        Number.isFinite(effectiveAmount) &&
        (effectiveAmount as number) > 0 &&
        paymentType.length > 0 &&
        !submitting;

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
            if (data.payUrl) {
                // Redirect to gateway. Submit button's spinner covers the
                // brief flicker before navigation completes.
                window.location.href = data.payUrl;
                return;
            }
            // No payUrl — Stripe popup / QR-only flows handled by the
            // existing /pay/[orderId] subroute. Send the user there.
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
        return (
            <p style={{ color: '#c44' }}>
                当前没有可用的支付方式,请联系管理员配置 ENABLED_PAYMENT_TYPES。
            </p>
        );
    }

    return (
        <form onSubmit={handleSubmit}>
            <fieldset style={{ border: 'none', padding: 0, margin: '0 0 20px' }}>
                <legend style={{ fontSize: 13, color: '#5a6478', padding: 0, marginBottom: 8 }}>
                    选择金额(CNY)
                </legend>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
                    {DEFAULT_TIERS_CNY.map((tier) => {
                        const active = selectedTier === tier;
                        return (
                            <button
                                key={tier}
                                type="button"
                                onClick={() => setSelectedTier(tier)}
                                style={{
                                    padding: '10px 0',
                                    background: active ? '#0a1535' : '#f5f7fa',
                                    color: active ? '#fff' : '#1a2540',
                                    border: '1px solid',
                                    borderColor: active ? '#0a1535' : '#e5e8ee',
                                    borderRadius: 4,
                                    cursor: 'pointer',
                                    fontSize: 14,
                                }}
                            >
                                ¥{tier}
                            </button>
                        );
                    })}
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
                    <input
                        type="radio"
                        name="amount-source"
                        checked={selectedTier === 'custom'}
                        onChange={() => setSelectedTier('custom')}
                    />
                    <span style={{ fontSize: 13, color: '#5a6478' }}>自定义金额:</span>
                    <input
                        type="number"
                        step="0.01"
                        min="1"
                        max="99999999.99"
                        placeholder="¥"
                        value={customAmount}
                        onFocus={() => setSelectedTier('custom')}
                        onChange={(e) => setCustomAmount(e.target.value)}
                        style={{
                            flex: 1,
                            padding: '6px 8px',
                            border: '1px solid #e5e8ee',
                            borderRadius: 4,
                            fontSize: 14,
                        }}
                    />
                </label>
            </fieldset>

            <fieldset style={{ border: 'none', padding: 0, margin: '0 0 24px' }}>
                <legend style={{ fontSize: 13, color: '#5a6478', padding: 0, marginBottom: 8 }}>
                    支付方式
                </legend>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {enabledPaymentTypes.map((t) => (
                        <label
                            key={t}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                padding: 10,
                                border: '1px solid',
                                borderColor: paymentType === t ? '#0a1535' : '#e5e8ee',
                                borderRadius: 4,
                                cursor: 'pointer',
                                background: paymentType === t ? '#f0f2f8' : '#fff',
                            }}
                        >
                            <input
                                type="radio"
                                name="payment-type"
                                value={t}
                                checked={paymentType === t}
                                onChange={() => setPaymentType(t)}
                            />
                            <span style={{ fontSize: 14, color: '#1a2540' }}>
                                {PROVIDER_LABEL[t] ?? t}
                            </span>
                        </label>
                    ))}
                </div>
            </fieldset>

            {error && (
                <p style={{ color: '#c44', fontSize: 13, margin: '0 0 12px' }}>{error}</p>
            )}

            <button
                type="submit"
                disabled={!canSubmit}
                style={{
                    width: '100%',
                    padding: '12px 0',
                    background: canSubmit ? '#0a1535' : '#a8aebc',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 4,
                    cursor: canSubmit ? 'pointer' : 'not-allowed',
                    fontSize: 15,
                }}
            >
                {submitting ? '正在跳转支付…' : '前往支付'}
            </button>
        </form>
    );
}
