import { z } from 'zod';
import type { TieredPricingDetails } from '@/lib/admin/pricing-publish-types';

const rate = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const boundary = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable();
const detailsSchema = z
    .object({
        version: z.literal(1),
        mode: z.literal('tiered_token'),
        unit: z.literal('cny_per_million_tokens'),
        semantics: z.literal('whole_request'),
        tiers: z
            .array(
                z
                    .object({
                        name: z.string().min(1).max(64),
                        min_input_tokens: boundary,
                        max_input_tokens: boundary,
                        min_inclusive: z.boolean(),
                        max_inclusive: z.boolean(),
                        rates: z
                            .object({
                                input: rate,
                                output: rate,
                                cache_read: rate.nullable(),
                                cache_write: rate.nullable(),
                                cache_write_1h: rate.nullable(),
                            })
                            .strict(),
                    })
                    .strict(),
            )
            .min(1)
            .max(32),
    })
    .strict()
    .superRefine((value, context) => {
        const invalid = () => context.addIssue({ code: 'custom', message: 'Invalid tiered pricing intervals' });
        const names = new Set<string>();
        for (const [index, tier] of value.tiers.entries()) {
            if (names.has(tier.name)) invalid();
            names.add(tier.name);
            if (
                (index === 0) !== (tier.min_input_tokens === null) ||
                (index === value.tiers.length - 1) !== (tier.max_input_tokens === null)
            )
                invalid();
            if (
                (tier.min_input_tokens === null && tier.min_inclusive) ||
                (tier.max_input_tokens === null && tier.max_inclusive)
            )
                invalid();
            if (tier.min_input_tokens !== null && tier.max_input_tokens !== null) {
                const first = tier.min_input_tokens + (tier.min_inclusive ? 0 : 1);
                const last = tier.max_input_tokens - (tier.max_inclusive ? 0 : 1);
                if (first > last) invalid();
            }
            if (index > 0) {
                const prior = value.tiers[index - 1];
                if (tier.min_input_tokens !== prior.max_input_tokens || tier.min_inclusive === prior.max_inclusive)
                    invalid();
                for (const key of ['cache_read', 'cache_write', 'cache_write_1h'] as const)
                    if ((tier.rates[key] === null) !== (value.tiers[0].rates[key] === null)) invalid();
            }
        }
    });

/** Absence is a legacy scalar price; malformed non-null metadata must fail closed. */
export function parseTieredPricingDetails(raw: unknown): TieredPricingDetails | null {
    if (raw === null || raw === undefined) return null;
    const parsed = detailsSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Invalid tiered pricing details');
    return parsed.data;
}

/** Apply a customer's effective/public multiplier to every tier and cache rate. */
export function scaleTieredPricingDetails(
    details: TieredPricingDetails,
    multiplierScale: number,
): TieredPricingDetails {
    const result = parseTieredPricingDetails(details)!;
    for (const tier of result.tiers) {
        for (const key of ['input', 'output', 'cache_read', 'cache_write', 'cache_write_1h'] as const) {
            const value = tier.rates[key];
            if (value === null) continue;
            tier.rates[key] = scalePricingAmount(value, multiplierScale);
        }
    }
    return result;
}

/** Shared by scalar and tiered customer quotes so a dedicated ratio replaces the public ratio. */
export function scalePricingAmount(value: number, multiplierScale: number): number {
    if (!Number.isFinite(multiplierScale) || multiplierScale < 0) throw new Error('Invalid pricing multiplier');
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid pricing amount');
    const scaled = Number((value * multiplierScale).toFixed(12));
    if (
        !Number.isFinite(scaled) ||
        scaled > Number.MAX_SAFE_INTEGER ||
        (value > 0 && multiplierScale > 0 && scaled === 0)
    )
        throw new Error('Unrepresentable pricing multiplier');
    return scaled;
}

/** Exact persisted cache quotes can require more than the legacy four decimals. */
export function formatTieredPrice(value: number): string {
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid pricing amount');
    const rounded = Number(value.toFixed(12));
    if (value > 0 && rounded === 0) throw new Error('Unrepresentable pricing amount');
    return value.toFixed(12).replace(/\.?0+$/, '');
}

export function tieredPricingConditionLabel(tier: TieredPricingDetails['tiers'][number], en = false): string {
    const number = (value: number) => value.toLocaleString(en ? 'en-US' : 'zh-CN');
    const input = en ? 'Full input tokens' : '完整输入 token';
    if (tier.min_input_tokens === null && tier.max_input_tokens === null)
        return en ? 'Any input length' : '不限输入长度';
    if (tier.min_input_tokens === null)
        return `${input} ${tier.max_inclusive ? '≤' : '<'} ${number(tier.max_input_tokens!)}`;
    if (tier.max_input_tokens === null)
        return `${input} ${tier.min_inclusive ? '≥' : '>'} ${number(tier.min_input_tokens)}`;
    return `${number(tier.min_input_tokens)} ${tier.min_inclusive ? '≤' : '<'} ${input} ${tier.max_inclusive ? '≤' : '<'} ${number(tier.max_input_tokens)}`;
}
