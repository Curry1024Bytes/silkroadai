'use client';

import { Tag } from 'lucide-react';
import type { TierPricing } from '@/lib/models/machine-catalog';
import type { TieredPricingDetails } from '@/lib/admin/pricing-publish-types';
import CatalogMediaPriceDetails from '@/components/CatalogMediaPriceDetails';
import type { PricingModel, TokenUnit } from '@newapi/features/pricing/types';
import { formatPlazaTokenAmount, plazaQuote } from '@/lib/models/plaza-pricing';
import { formatTieredPrice, tieredPricingConditionLabel } from '@/lib/models/tiered-pricing-details';
import {
    catalogRequestMultiplierLines,
    catalogScheduledDiscountLines,
    primaryTokenRates,
} from '@/lib/models/catalog-pricing-details';
import { useLocale } from '@/lib/i18n/client';
import { pickMessages } from '@/lib/i18n';
import { modelsMessages, translateSummaryLabel, type ModelsMessages } from '@/lib/i18n/messages/models';
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
                    {quote?.price?.customer_pricing && <PriceProvenanceNote price={quote.price} />}
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
                    {!quote?.price?.customer_pricing && <PriceProvenanceNote price={quote?.price ?? null} />}
                </>
            ) : (
                <p className="text-muted-foreground m-0 text-sm">{m.prices.unpriced}</p>
            )}
            {quote?.tier && <p className="m-0 text-xs leading-5 font-medium break-words">{quote.tier.label}</p>}
        </div>
    );
}

type RateKey = keyof TieredPricingDetails['tiers'][number]['rates'];

function tokenColumns(m: ModelsMessages): [RateKey, string][] {
    return [
        ['input', m.prices.input],
        ['output', m.prices.output],
        ['cache_read', m.prices.cacheRead],
        ['cache_write', m.prices.cacheWrite5m],
        ['cache_write_1h', m.prices.cacheWrite1h],
        ['cache_write_12h', m.prices.cacheWrite12h],
    ];
}

function BaseTokenCards({ price, m }: { price: TierPricing; m: ModelsMessages }) {
    const details = price.billing_details;
    const rates = primaryTokenRates(details ?? null);
    const values = tokenColumns(m).map(([key, label]) => ({
        key,
        label,
        amount: rates
            ? rates[key]
            : key === 'input'
              ? price.input_cny_per_1m
              : key === 'output'
                ? price.output_cny_per_1m
                : null,
    }));
    const main = values.slice(0, 2).filter((value): value is typeof value & { amount: number } => value.amount != null);
    const cache = values.slice(2).filter((value): value is typeof value & { amount: number } => value.amount != null);
    return (
        <>
            {main.length > 0 && (
                <dl className="m-0 grid grid-cols-2 gap-2">
                    {main.map(({ key, label, amount }) => (
                        <div key={key} className="min-w-0 rounded-xl border bg-muted/35 p-3">
                            <dt className="text-muted-foreground text-xs">{label}</dt>
                            <dd className="m-0 mt-1 flex flex-wrap items-baseline gap-x-1 [overflow-wrap:anywhere]">
                                <strong className="font-mono text-base font-bold tabular-nums">
                                    {`¥${formatTieredPrice(amount)}`}
                                </strong>
                                <span className="text-muted-foreground text-xs">/ 1M</span>
                            </dd>
                        </div>
                    ))}
                </dl>
            )}
            {cache.length > 0 && (
                <dl className="m-0 space-y-1 rounded-xl border bg-muted/35 p-3 text-sm">
                    {cache.map(({ key, label, amount }) => (
                        <div key={key} className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">{label}</dt>
                            <dd className="m-0 text-right font-mono tabular-nums [overflow-wrap:anywhere]">
                                {`¥${formatTieredPrice(amount)}`}{' '}
                                <span className="text-muted-foreground text-xs">/ 1M</span>
                            </dd>
                        </div>
                    ))}
                </dl>
            )}
        </>
    );
}

function TokenPriceTable({ details, m, en }: { details: TieredPricingDetails; m: ModelsMessages; en: boolean }) {
    const columns = tokenColumns(m).filter(([key]) => details.tiers.some((row) => row.rates[key] != null));
    const notes = [
        ...catalogRequestMultiplierLines(details, en),
        ...(details.scheduled_discount ? catalogScheduledDiscountLines(details.scheduled_discount, en) : []),
    ];
    return (
        <>
            <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                    <thead className="text-muted-foreground border-b text-xs">
                        <tr>
                            <th scope="col" className="px-2 py-2 text-left font-medium">
                                {m.prices.tier}
                            </th>
                            {columns.map(([key, label]) => (
                                <th
                                    key={key}
                                    scope="col"
                                    className="px-2 py-2 text-right font-medium whitespace-nowrap"
                                >
                                    {label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {details.tiers.map((row) => (
                            <tr key={row.name} className="border-b last:border-b-0">
                                <th scope="row" className="px-2 py-2 text-left font-medium">
                                    <span className="inline-block rounded-full bg-info/10 px-2 py-0.5 text-xs text-info">
                                        {row.name}
                                    </span>
                                    {(row.min_input_tokens !== null || row.max_input_tokens !== null) && (
                                        <span className="text-muted-foreground mt-1 block text-xs">
                                            {tieredPricingConditionLabel(row, en)}
                                        </span>
                                    )}
                                </th>
                                {columns.map(([key]) => (
                                    <td
                                        key={key}
                                        className="px-2 py-2 text-right font-mono whitespace-nowrap tabular-nums"
                                    >
                                        {row.rates[key] == null ? '—' : `¥${formatTieredPrice(row.rates[key])}`}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {notes.length > 0 && (
                <ul className="text-muted-foreground m-0 space-y-1 px-3 py-2 text-xs">
                    {notes.map((line, index) => (
                        <li key={index}>{line}</li>
                    ))}
                </ul>
            )}
        </>
    );
}

export function PlazaPriceDetails({ model, selectedGroup }: { model: PricingModel; selectedGroup?: string }) {
    const locale = useLocale();
    const m = pickMessages(modelsMessages, locale);
    const en = locale === 'en';
    const tariff = model.portal;
    if (!tariff) return null;
    const tiers = tariff.tiers.filter(
        (tier) =>
            Object.hasOwn(tariff.pricesByTier, tier.key) &&
            (!selectedGroup || selectedGroup === 'all' || selectedGroup === tier.key),
    );
    const summaryTier = plazaQuote(model, selectedGroup)?.tier;
    const breakdown = summaryTier ? tariff.breakdownByTier?.[summaryTier.key] : undefined;
    const base = breakdown?.base;
    const baseDetails = base?.billing_details;
    return (
        <div className="space-y-7 [&_.text-navy]:text-foreground [&_.text-muted-ink]:text-muted-foreground [&_.bg-paper-muted]:bg-muted">
            {base && (
                <section className="flex flex-col gap-3" aria-label={m.prices.basePrice}>
                    <h3 className="text-muted-foreground m-0 text-xs font-semibold">{m.prices.basePrice}</h3>
                    {baseDetails?.mode === 'media' ||
                    baseDetails?.mode === 'video_token' ||
                    baseDetails?.mode === 'component_token' ? (
                        <div className="rounded-xl border bg-muted/35 p-3">
                            <CatalogMediaPriceDetails details={baseDetails} en={en} />
                        </div>
                    ) : base.per_image_cny != null ? (
                        <div className="rounded-xl border bg-muted/35 p-3 font-mono font-bold">
                            {`¥${formatTieredPrice(base.per_image_cny)}`}{' '}
                            <span className="text-muted-foreground text-xs font-normal">
                                / {tariff.type === 'image-gen' ? m.prices.perImage : m.prices.perRequest}
                            </span>
                        </div>
                    ) : (
                        <BaseTokenCards price={base} m={m} />
                    )}
                </section>
            )}
            {breakdown?.dynamic && baseDetails && (
                <section className="flex flex-col gap-4" aria-label={m.prices.dynamicPricing}>
                    <div className="flex items-start gap-2">
                        <span className="bg-warning/15 text-warning inline-grid size-6 shrink-0 place-items-center rounded-full">
                            <Tag size={13} aria-hidden="true" />
                        </span>
                        <div>
                            <h3 className="m-0 text-sm font-semibold">{m.prices.dynamicPricing}</h3>
                            <p className="text-muted-foreground m-0 text-xs">{m.prices.dynamicHint}</p>
                        </div>
                    </div>
                    <h4 className="m-0 text-sm font-semibold">{m.prices.tieredTable}</h4>
                    {baseDetails.mode === 'tiered_token' ? (
                        <>
                            <TokenPriceTable details={baseDetails} m={m} en={en} />
                            <p className="text-muted-foreground m-0 text-xs">{m.prices.perMillionTokens}</p>
                        </>
                    ) : (
                        <CatalogMediaPriceDetails details={baseDetails} en={en} />
                    )}
                </section>
            )}
            <section className="flex flex-col gap-3" aria-label={m.prices.groupPricing}>
                <h3 className="text-muted-foreground m-0 text-xs font-semibold">{m.prices.groupPricing}</h3>
                {tiers.length === 0 && <p className="text-muted-foreground text-sm">{m.prices.noTierQuote}</p>}
                {tiers.map((tier) => {
                    const price = tariff.pricesByTier[tier.key];
                    const groupBreakdown = tariff.breakdownByTier?.[tier.key];
                    // A multiplier shown here must apply to the base displayed above.
                    const groupMultiplier =
                        base && groupBreakdown && JSON.stringify(base) === JSON.stringify(groupBreakdown.base)
                            ? groupBreakdown.groupMultiplier
                            : undefined;
                    const details = price?.billing_details;
                    return (
                        <section
                            key={tier.key}
                            aria-label={m.prices.tierAria(tier.label)}
                            className="overflow-hidden rounded-xl border"
                        >
                            <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/35 px-3 py-2.5">
                                <h4 className="text-success m-0 min-w-0 text-sm font-semibold break-words">
                                    {tier.label}
                                </h4>
                                {groupMultiplier !== undefined && !price?.customer_pricing && (
                                    <span
                                        className="text-muted-foreground font-mono text-xs"
                                        title={m.prices.publicGroupMultiplier}
                                    >
                                        {formatTieredPrice(groupMultiplier)}x
                                    </span>
                                )}
                            </div>
                            {details?.mode === 'tiered_token' && price?.per_image_cny == null ? (
                                <>
                                    {price?.customer_pricing && (
                                        <div className="px-3 pt-2">
                                            <PriceProvenanceNote price={price} />
                                        </div>
                                    )}
                                    <TokenPriceTable details={details} m={m} en={en} />
                                    {!price?.customer_pricing && (
                                        <div className="empty:hidden px-3">
                                            <PriceProvenanceNote price={price ?? null} />
                                        </div>
                                    )}
                                    <p className="text-muted-foreground m-0 px-3 py-2 text-xs">
                                        {m.prices.perMillionTokens}
                                    </p>
                                </>
                            ) : (
                                <div className="p-3">
                                    {!price ? (
                                        <p className="text-muted-foreground m-0 text-sm">{m.prices.unpriced}</p>
                                    ) : details && details.mode !== 'tiered_token' ? (
                                        <>
                                            {price.customer_pricing && <PriceProvenanceNote price={price} />}
                                            <CatalogMediaPriceDetails details={details} en={en} />
                                            {!price.customer_pricing && <PriceProvenanceNote price={price} />}
                                        </>
                                    ) : (
                                        <ModelTierPrices price={price} type={tariff.type} />
                                    )}
                                </div>
                            )}
                        </section>
                    );
                })}
            </section>
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
