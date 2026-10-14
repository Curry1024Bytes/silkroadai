import type { BrowserTier } from './catalog-browser-types';
import type { TierPricing } from './machine-catalog';
import type { TypeName } from './categorize';
import { isUniformPricingDetails, tieredPricingConditionLabel } from './tiered-pricing-details';

export interface CatalogPriceSummary {
    unit: string;
    rates: { label: string; amount: number }[];
    condition: string | null;
    note: string | null;
}

/** Prefer the configured default membership, never a synthetic minimum across groups. */
export function catalogSummaryTier(tiers: BrowserTier[], prices: Record<string, TierPricing | null>) {
    const members = tiers.filter((tier) => Object.hasOwn(prices, tier.key));
    return members.find((tier) => tier.isDefault) ?? members[0];
}

/** Summarize one exact tariff; conditions and units stay attached to the displayed rates. */
export function catalogPriceSummary(price: TierPricing | null, type: TypeName): CatalogPriceSummary | null {
    if (!price) return null;
    const details = price.billing_details;
    if (details?.mode === 'media') {
        const unit = { cny_per_image: '元 / 张', cny_per_request: '元 / 次', cny_per_second: '元 / 秒' }[details.unit];
        // Pick a named specification, not the cheapest amount. A default is not a price for every resolution.
        const specification = Object.keys(details.resolution_prices).sort((a, b) =>
            a.localeCompare(b, 'en', { numeric: true }),
        )[0];
        const useDefault = details.default_price !== null;
        const amount = useDefault ? details.default_price : details.resolution_prices[specification];
        if (amount == null) return null;
        return {
            unit,
            rates: [{ label: '价格', amount }],
            condition: `${details.scheduled_discount ? '常规价 · ' : ''}${useDefault ? '默认规格' : specification}`,
            note: details.scheduled_discount
                ? '分时优惠与完整规格见详情'
                : Object.keys(details.resolution_prices).length > (useDefault ? 0 : 1)
                  ? '更多规格价格见详情'
                  : null,
        };
    }
    if (details?.mode === 'component_token') {
        return {
            unit: '元 / 百万 token',
            rates: [
                { label: '文本输入', amount: details.rates.input },
                { label: '输出', amount: details.rates.output },
            ],
            condition: '图片输入另计，完整价格见详情',
            note: null,
        };
    }
    if (details?.mode === 'tiered_token') {
        const first = details.tiers[0];
        return {
            unit: '元 / 百万 token',
            rates: [
                { label: '输入', amount: first.rates.input },
                { label: '输出', amount: first.rates.output },
            ],
            condition: isUniformPricingDetails(details) ? null : tieredPricingConditionLabel(first),
            note: isUniformPricingDetails(details) ? null : '其他输入长度价格见详情',
        };
    }
    if (price.per_image_cny !== null) {
        return {
            unit: type === 'image-gen' ? '元 / 张' : '元 / 次',
            rates: [{ label: '价格', amount: price.per_image_cny }],
            condition: null,
            note:
                price.input_cny_per_1m !== null || price.output_cny_per_1m !== null
                    ? '另含 token 计费，完整价格见详情'
                    : null,
        };
    }
    const rates = [
        { label: '输入', amount: price.input_cny_per_1m },
        { label: '输出', amount: price.output_cny_per_1m },
    ].filter((row): row is { label: string; amount: number } => row.amount !== null);
    return rates.length ? { unit: '元 / 百万 token', rates, condition: null, note: null } : null;
}
