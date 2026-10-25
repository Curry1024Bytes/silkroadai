import type { PricingModel } from '@newapi/features/pricing/types';
import { catalogPriceSummary, catalogSummaryTier } from './catalog-price-summary';
import { formatTieredPrice } from './tiered-pricing-details';

/** Shift the exact decimal representation, preserving tiny nonzero /1K cache quotes. */
export function formatPlazaTokenAmount(amount: number, unit: 'M' | 'K'): string {
    const original = formatTieredPrice(amount);
    if (unit === 'M' || amount === 0) return original;
    const [whole, fraction = ''] = original.split('.');
    const digits = whole + fraction;
    const split = whole.length - 3;
    const shifted = split > 0 ? `${digits.slice(0, split)}.${digits.slice(split)}` : `0.${'0'.repeat(-split)}${digits}`;
    return shifted.replace(/0+$/, '').replace(/\.$/, '');
}

/** A selected group must be an exact membership. Missing quotes stay missing. */
export function plazaQuote(model: PricingModel, selectedGroup?: string) {
    const tariff = model.portal;
    if (!tariff) return null;
    const tier =
        selectedGroup && selectedGroup !== 'all'
            ? tariff.tiers.find((row) => row.key === selectedGroup && Object.hasOwn(tariff.pricesByTier, row.key))
            : catalogSummaryTier(tariff.tiers, tariff.pricesByTier);
    const price = tier ? tariff.pricesByTier[tier.key] : null;
    return {
        tier,
        price,
        summary: catalogPriceSummary(price ?? null, tariff.type),
    };
}

export function plazaGroupLabel(model: PricingModel, group: string): string {
    return model.portal?.tiers.find((tier) => tier.key === group)?.label ?? group;
}

export function plazaBillingKind(model: PricingModel, selectedGroup?: string): 'token' | 'request' | 'task' {
    const price = plazaQuote(model, selectedGroup)?.price;
    if (price?.billing_details?.mode === 'media') {
        return price.billing_details.unit === 'cny_per_second' ? 'task' : 'request';
    }
    if (price?.per_image_cny != null) return 'request';
    return 'token';
}

/** Compare like billing units; an absent quote always sorts after known prices. */
export function comparePlazaPrices(a: PricingModel, b: PricingModel, group: string | undefined, descending = false) {
    const x = plazaQuote(a, group)?.summary;
    const y = plazaQuote(b, group)?.summary;
    if (!x || !y) return x ? -1 : y ? 1 : a.model_name.localeCompare(b.model_name);
    const unitOrder = x.unit.localeCompare(y.unit, 'zh-CN');
    if (unitOrder) return unitOrder;
    const difference = x.rates[0].amount - y.rates[0].amount;
    return (descending ? -difference : difference) || a.model_name.localeCompare(b.model_name);
}
