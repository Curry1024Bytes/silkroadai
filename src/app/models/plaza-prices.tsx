'use client';

import type { PricingModel, TokenUnit } from '@newapi/features/pricing/types';
import { formatPlazaTokenAmount, plazaQuote } from '@/lib/models/plaza-pricing';
import { formatTieredPrice, tieredPricingConditionLabel } from '@/lib/models/tiered-pricing-details';
import { primaryTokenRates } from '@/lib/models/catalog-pricing-details';
import { useLocale } from '@/lib/i18n/client';
import { pickMessages } from '@/lib/i18n';
import { modelsMessages, translateSummaryLabel } from '@/lib/i18n/messages/models';
import { ModelTierPrices, PriceProvenanceNote } from './model-prices';

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
    const locale = useLocale();
    const m = pickMessages(modelsMessages, locale);
    const quote = plazaQuote(model, selectedGroup);
    const summary = quote?.summary;
    // `summary` labels come from catalog-price-summary.ts in Chinese; the unit check below
    // compares that source value, translation happens only at display time.
    const perToken = summary?.unit === '元 / 百万 token';
    const divisor = perToken && tokenUnit === 'K' ? 1000 : 1;
    const details = quote?.price?.billing_details;
    // Tiered token conditions come from tieredPricingConditionLabel, which has its own English form.
    const condition =
        locale === 'en' && details?.mode === 'tiered_token' && summary?.condition
            ? tieredPricingConditionLabel(details.tiers[0], true)
            : summary?.condition
              ? translateSummaryLabel(m, summary.condition)
              : null;
    return (
        <div
            className="col-span-full flex min-w-0 flex-col gap-2"
            aria-label={m.prices.summaryAria(quote?.tier?.label ?? null)}
        >
            {summary ? (
                <>
                    <dl
                        className={`m-0 grid gap-x-4 gap-y-1 ${summary.rates.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}
                    >
                        {summary.rates.map((rate) => (
                            <div key={rate.label} className="row-span-2 grid min-w-0 grid-rows-subgrid gap-y-1">
                                <dt className="text-muted-foreground text-xs leading-5">
                                    {translateSummaryLabel(m, rate.label)}
                                </dt>
                                <dd className="m-0 min-w-0 font-mono text-base leading-6 font-semibold tabular-nums [overflow-wrap:anywhere]">
                                    {`¥${perToken ? formatPlazaTokenAmount(rate.amount, tokenUnit) : formatTieredPrice(rate.amount)}`}
                                </dd>
                            </div>
                        ))}
                    </dl>
                    <p className="text-muted-foreground m-0 text-xs leading-5">
                        {divisor === 1000 ? m.prices.perThousandTokens : translateSummaryLabel(m, summary.unit)}
                    </p>
                    {condition && <p className="text-muted-foreground m-0 text-xs leading-relaxed">{condition}</p>}
                    {summary.note && (
                        <p className="text-muted-foreground m-0 text-xs leading-relaxed">
                            {translateSummaryLabel(m, summary.note)}
                        </p>
                    )}
                    <PriceProvenanceNote price={quote?.price ?? null} />
                </>
            ) : (
                <p className="text-muted-foreground m-0 text-sm">{m.prices.unpriced}</p>
            )}
            {quote?.tier && <p className="m-0 text-xs leading-5 font-medium break-words">{quote.tier.label}</p>}
        </div>
    );
}

export function PlazaPriceDetails({ model, selectedGroup }: { model: PricingModel; selectedGroup?: string }) {
    const m = pickMessages(modelsMessages, useLocale());
    const tariff = model.portal;
    if (!tariff) return null;
    const tiers = tariff.tiers.filter(
        (tier) =>
            Object.hasOwn(tariff.pricesByTier, tier.key) &&
            (!selectedGroup || selectedGroup === 'all' || selectedGroup === tier.key),
    );
    return (
        <div className="space-y-6 [&_.text-navy]:text-foreground [&_.text-muted-ink]:text-muted-foreground [&_.bg-paper-muted]:bg-muted">
            <p className="text-muted-foreground text-xs">{m.prices.detailsIntro}</p>
            {tiers.length === 0 && <p className="text-muted-foreground text-sm">{m.prices.noTierQuote}</p>}
            {tiers.map((tier) => (
                <section
                    key={tier.key}
                    aria-label={m.prices.tierAria(tier.label)}
                    className="bg-muted/20 rounded-xl border p-4"
                >
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
    const locale = useLocale();
    const m = pickMessages(modelsMessages, locale);
    const quote = plazaQuote(model, selectedGroup);
    const details = quote?.price?.billing_details;
    const rate =
        details?.mode === 'component_token'
            ? details.rates.cache_read
            : (primaryTokenRates(details ?? null)?.cache_read ?? null);
    if (rate == null) return <span className="text-muted-foreground text-xs">—</span>;
    return (
        <div className="space-y-1 text-xs">
            <span className="font-mono tabular-nums">{`¥${formatPlazaTokenAmount(rate, tokenUnit)}`}</span>
            <p className="text-muted-foreground m-0">{m.prices.perToken(tokenUnit === 'K' ? 'K' : 'M')}</p>
            {quote?.summary?.condition && (
                <p className="text-muted-foreground m-0">
                    {locale === 'en' && details?.mode === 'tiered_token'
                        ? tieredPricingConditionLabel(details.tiers[0], true)
                        : translateSummaryLabel(m, quote.summary.condition)}
                </p>
            )}
            {quote?.tier && <p className="m-0">{quote.tier.label}</p>}
        </div>
    );
}
