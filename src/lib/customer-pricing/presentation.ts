import 'server-only';
import { prisma } from '@/lib/db';
import { customerPrice, readBasePrice } from '@/lib/admin/pricing-simple-core';
import type { TierPricing } from '@/lib/models/machine-catalog';
import { loadOfficialContext } from './context';
import { compileOfficialRatio, CustomerPricingError, exactOfficialAmounts, selectOfficialRule } from './math';

type Amounts = ReturnType<typeof customerPrice>;

/** Replace each billed rate with its exact contracted amount, keyed like `flattenBase` cells. */
function withExactAmounts(actual: Amounts, exact: Map<string, number>): Amounts {
    const pick = (key: string): number => {
        const value = exact.get(key);
        if (value === undefined)
            throw new CustomerPricingError('customer_price_missing', '该模型实际价格无法核对。');
        return value;
    };
    const details = actual.billing_details;
    if (details?.mode === 'video_token')
        return {
            ...actual,
            billing_details: {
                ...details,
                cells: details.cells.map((c) => ({
                    ...c,
                    price: pick(`${c.resolution}·${c.video_input}`),
                })),
            },
        };
    if (actual.per_image_cny !== null) return { ...actual, per_image_cny: pick('call') };
    const result = { ...actual };
    if (actual.input_cny_per_1m !== null) result.input_cny_per_1m = pick('0:input');
    if (actual.output_cny_per_1m !== null) result.output_cny_per_1m = pick('0:output');
    if (details?.mode === 'tiered_token')
        result.billing_details = {
            ...details,
            tiers: details.tiers.map((tier, index) => ({
                ...tier,
                rates: Object.fromEntries(
                    Object.entries(tier.rates).map(([key, value]) => [
                        key,
                        value == null ? value : pick(`${index}:${key}`),
                    ]),
                ) as typeof tier.rates,
            })),
        };
    return result;
}

export async function summarizeCustomerOfficialTiers(
    userId: string,
): Promise<Map<string, { multiplier: number | null; model_overrides: number }>> {
    const rules = await prisma.customerOfficialPriceRule.findMany({ where: { user_id: userId } });
    if (!rules.length) return new Map();
    const context = await loadOfficialContext(userId);
    verifiedQuotes(context);
    const result = new Map<string, { multiplier: number | null; model_overrides: number }>();
    for (const rule of context.rules) {
        if (!context.bindings.some((b) => b.tier_key === rule.tier_key && b.status === 'active'))
            throw new CustomerPricingError('unverified_customer_price', '客户专属价格正在核验，请稍后刷新。');
        const summary = result.get(rule.tier_key) ?? { multiplier: null, model_overrides: 0 };
        if (rule.model_id === null) summary.multiplier = Number(rule.official_multiplier);
        else summary.model_overrides += 1;
        result.set(rule.tier_key, summary);
    }
    return result;
}

/** Actual verified native prices, never a public-price fallback for an unverified personal quote. */
export async function loadCustomerOfficialQuotes(userId: string): Promise<Map<string, TierPricing>> {
    const count = await prisma.customerOfficialPriceRule.count({ where: { user_id: userId } });
    if (!count) return new Map();
    const context = await loadOfficialContext(userId);
    return verifiedQuotes(context);
}

function verifiedQuotes(context: Awaited<ReturnType<typeof loadOfficialContext>>): Map<string, TierPricing> {
    const result = new Map<string, TierPricing>();
    for (const tier of context.tiers) {
        for (const model of tier.models) {
            const rule = selectOfficialRule(context.rules, tier.key, model.model_id);
            if (!rule) continue;
            if (tier.binding_status !== 'active')
                throw new CustomerPricingError('unverified_customer_price', '客户价格尚未核验完成。');
            const expected = compileOfficialRatio(model, rule.official_multiplier);
            if (Math.abs(expected - model.current_ratio) > 1e-12 + Math.abs(expected) * 1e-12)
                throw new CustomerPricingError('customer_price_drift', '实际扣费倍率与客户专属价格不一致。');
            const base = readBasePrice(context.options, model.model_name);
            if (!base) throw new CustomerPricingError('customer_price_missing', '该模型实际价格无法核对。');
            const actual = withExactAmounts(
                customerPrice(base, model.current_ratio),
                exactOfficialAmounts(model, rule.official_multiplier, model.current_ratio),
            );
            result.set(`${model.model_name}\u0000${tier.key}`, {
                input_cny_per_1m: actual.input_cny_per_1m,
                output_cny_per_1m: actual.output_cny_per_1m,
                per_image_cny: actual.per_image_cny,
                ...(actual.billing_details ? { billing_details: actual.billing_details } : {}),
                customer_pricing: {
                    basis: 'official',
                    multiplier: rule.official_multiplier,
                    scope: rule.model_id ? 'model' : 'tier',
                    public_official_multiplier: model.public_official_multiplier,
                    official_multiplier: rule.official_multiplier,
                },
            });
        }
    }
    return result;
}
