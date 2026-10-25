'use client';

import type { PricingModel, TokenUnit } from '@newapi/features/pricing/types';
import { formatPlazaTokenAmount, plazaQuote } from '@/lib/models/plaza-pricing';
import { formatTieredPrice } from '@/lib/models/tiered-pricing-details';
import { ModelTierPrices } from './model-prices';

/** Shared by cards and table cells so the selected tariff never changes between views. */
export function PlazaPriceSummary({
    model,
    selectedGroup,
    tokenUnit = 'M',
}: {
    model: PricingModel;
    selectedGroup?: string;
    tokenUnit?: TokenUnit;
}) {
    const quote = plazaQuote(model, selectedGroup);
    const summary = quote?.summary;
    const perToken = summary?.unit === '元 / 百万 token';
    const divisor = perToken && tokenUnit === 'K' ? 1000 : 1;
    return (
        <div className="col-span-full min-w-0 space-y-2" aria-label={`${quote?.tier?.label ?? '当前分组'}价格摘要`}>
            {summary ? (
                <>
                    <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1">
                        {summary.rates.map((rate) => (
                            <div key={rate.label}>
                                <dt className="text-muted-foreground text-xs">{rate.label}</dt>
                                <dd className="m-0 break-words font-mono text-base font-semibold tabular-nums">
                                    {`¥${perToken ? formatPlazaTokenAmount(rate.amount, tokenUnit) : formatTieredPrice(rate.amount)}`}
                                </dd>
                            </div>
                        ))}
                    </dl>
                    <p className="text-muted-foreground m-0 text-xs">
                        {divisor === 1000 ? '元 / 千 token' : summary.unit}
                    </p>
                    {summary.condition && (
                        <p className="text-muted-foreground m-0 text-xs leading-relaxed">{summary.condition}</p>
                    )}
                    {summary.note && (
                        <p className="text-muted-foreground m-0 text-xs leading-relaxed">{summary.note}</p>
                    )}
                </>
            ) : (
                <p className="text-muted-foreground m-0 text-sm">未定价</p>
            )}
            {quote?.tier && <p className="m-0 text-xs font-medium">{quote.tier.label}</p>}
        </div>
    );
}

export function PlazaPriceDetails({ model, selectedGroup }: { model: PricingModel; selectedGroup?: string }) {
    const tariff = model.portal;
    if (!tariff) return null;
    const tiers = tariff.tiers.filter(
        (tier) =>
            Object.hasOwn(tariff.pricesByTier, tier.key) &&
            (!selectedGroup || selectedGroup === 'all' || selectedGroup === tier.key),
    );
    return (
        <div className="space-y-6 [&_.text-navy]:text-foreground [&_.text-muted-ink]:text-muted-foreground [&_.bg-paper-muted]:bg-muted">
            <p className="text-muted-foreground text-xs">人民币报价 · 使用对应分组的 API Key 调用</p>
            {tiers.length === 0 && <p className="text-muted-foreground text-sm">当前分组无可用报价</p>}
            {tiers.map((tier) => (
                <section key={tier.key} aria-label={`${tier.label}价格`} className="bg-muted/20 rounded-xl border p-4">
                    <h3 className="mb-3 text-sm font-semibold">{tier.label}</h3>
                    <ModelTierPrices price={tariff.pricesByTier[tier.key]} type={tariff.type} />
                </section>
            ))}
        </div>
    );
}

export function PlazaCachedPrice({
    model,
    selectedGroup,
    tokenUnit = 'M',
}: {
    model: PricingModel;
    selectedGroup?: string;
    tokenUnit?: TokenUnit;
}) {
    const quote = plazaQuote(model, selectedGroup);
    const details = quote?.price?.billing_details;
    const rate =
        details?.mode === 'tiered_token'
            ? details.tiers[0].rates.cache_read
            : details?.mode === 'component_token'
              ? details.rates.cache_read
              : null;
    if (rate == null) return <span className="text-muted-foreground text-xs">—</span>;
    return (
        <div className="space-y-1 text-xs">
            <span className="font-mono tabular-nums">{`¥${formatPlazaTokenAmount(rate, tokenUnit)}`}</span>
            <p className="text-muted-foreground m-0">/ {tokenUnit === 'K' ? '千' : '百万'} token</p>
            {quote?.summary?.condition && <p className="text-muted-foreground m-0">{quote.summary.condition}</p>}
            {quote?.tier && <p className="m-0">{quote.tier.label}</p>}
        </div>
    );
}
