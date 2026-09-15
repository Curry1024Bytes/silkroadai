import { z } from 'zod';
import type {
    PricingCostCalculation,
    PricingCostConfig,
    PricingCostLine,
    PricingCostSample,
} from './pricing-cost-types';

// Pure purchasing-cost arithmetic. It has no new-api group ratio, database access,
// or side effects: the resulting retail amounts are already final CNY prices.
export const PRICING_COST_MAX_RETAIL = 99_999_999.9999;
const MAX_SAFE_VALUE = Number.MAX_SAFE_INTEGER;
const nonNegative = z.number().finite().min(0).max(MAX_SAFE_VALUE);
const positive = z.number().finite().positive().max(MAX_SAFE_VALUE);
const tokenKeys = ['input', 'output', 'cache_read', 'cache_write'] as const;
const tokenLabels: Record<(typeof tokenKeys)[number], string> = {
    input: '输入',
    output: '输出',
    cache_read: '缓存读取',
    cache_write: '缓存写入',
};

/** Exact rational arithmetic avoids binary floating point changing money at a rounding boundary. */
interface Rational {
    n: bigint;
    d: bigint;
}
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TEN = BigInt(10);
function fraction(n: bigint, d: bigint): Rational {
    let a = n < ZERO ? -n : n;
    let b = d;
    while (b !== ZERO) [a, b] = [b, a % b];
    const divisor = a === ZERO ? ONE : a;
    return { n: n / divisor, d: d / divisor };
}
function decimal(value: number): Rational {
    const [coefficient, exponentText = '0'] = String(value).toLowerCase().split('e');
    const [whole, decimals = ''] = coefficient.split('.');
    const exponent = Number(exponentText) - decimals.length;
    const numerator = BigInt(whole + decimals);
    return exponent >= 0
        ? fraction(numerator * TEN ** BigInt(exponent), ONE)
        : fraction(numerator, TEN ** BigInt(-exponent));
}
function multiply(a: Rational, b: Rational): Rational {
    return fraction(a.n * b.n, a.d * b.d);
}
function divide(a: Rational, b: Rational): Rational {
    return fraction(a.n * b.d, a.d * b.n);
}
function add(a: Rational, b: Rational): Rational {
    return fraction(a.n * b.d + b.n * a.d, a.d * b.d);
}
function subtract(a: Rational, b: Rational): Rational {
    return fraction(a.n * b.d - b.n * a.d, a.d * b.d);
}
function compare(a: Rational, b: Rational): number {
    const difference = a.n * b.d - b.n * a.d;
    return difference < ZERO ? -1 : difference > ZERO ? 1 : 0;
}
function round(value: Rational, precision: number): number {
    const scale = TEN ** BigInt(precision);
    const negative = value.n < ZERO;
    const numerator = (negative ? -value.n : value.n) * scale;
    const rounded = (numerator * BigInt(2) + value.d) / (value.d * BigInt(2));
    return Number(negative ? -rounded : rounded) / 10 ** precision;
}
function asNumber(value: Rational): number {
    // Decimal-string conversion rounds only once when returning a JS number.
    // Multiplying an approximate mantissa by 10^-1 would turn exact 0.3 back
    // into 0.30000000000000004, including a billed duration at a step boundary.
    const numerator = value.n < ZERO ? -value.n : value.n;
    const whole = numerator / value.d;
    let remainder = numerator % value.d;
    let decimals = '';
    for (let digit = 0; remainder !== ZERO && digit < 340; digit++) {
        remainder *= TEN;
        decimals += String(remainder / value.d);
        remainder %= value.d;
    }
    return Number(`${value.n < ZERO ? '-' : ''}${whole}.${decimals || '0'}`);
}
function costMultiplier(config: PricingCostConfig): Rational {
    return divide(
        decimal(config.upstream_multiplier),
        decimal(config.currency === 'credits' ? config.credits_per_cny : 1),
    );
}
function markupMultiplier(config: PricingCostConfig): Rational {
    return add(decimal(1), divide(decimal(config.markup_percent), decimal(100)));
}
function rawCostAndRetail(config: PricingCostConfig, price: number): { cost: Rational; retail: Rational } {
    const cost = multiply(decimal(price), costMultiplier(config));
    return { cost, retail: multiply(cost, markupMultiplier(config)) };
}

const configShape = z
    .object({
        version: z.literal(1),
        basis: z.enum(['token', 'image', 'video']),
        currency: z.enum(['cny', 'credits']),
        credits_per_cny: positive,
        upstream_multiplier: positive,
        markup_percent: nonNegative,
        source_note: z.string().trim().max(500),
        token_rates: z
            .object({
                input: nonNegative.nullable(),
                output: nonNegative.nullable(),
                cache_read: nonNegative.nullable(),
                cache_write: nonNegative.nullable(),
            })
            .strict(),
        variants: z
            .array(
                z
                    .object({
                        key: z
                            .string()
                            .max(64)
                            .regex(/^[a-z0-9][a-z0-9_-]*$/),
                        label: z.string().trim().min(1).max(120),
                        resolution: z.string().trim().min(1).max(64),
                        audio: z.enum(['any', 'silent', 'audio']),
                        reference_video: z.enum(['any', 'without', 'with']),
                        price: nonNegative,
                        minimum_units: positive,
                        step_units: positive,
                    })
                    .strict(),
            )
            .max(100),
    })
    .strict();

export const pricingCostConfigSchema = configShape.superRefine((config, ctx) => {
    const issue = (path: Array<string | number>, message: string) => ctx.addIssue({ code: 'custom', path, message });
    if (config.currency === 'cny' && config.credits_per_cny !== 1) {
        issue(['credits_per_cny'], '人民币报价的兑换比例须为 1，避免重复折算。');
    }
    if (config.basis === 'token') {
        if (config.variants.length > 0) issue(['variants'], 'Token 计费不能同时填写图片或视频规格。');
        for (const key of ['input', 'output'] as const) {
            if (config.token_rates[key] === null)
                issue(['token_rates', key], '请填写明确的价格，不能将缺失价格当作免费。');
        }
    } else {
        if (config.variants.length === 0) issue(['variants'], '请至少填写一个计费规格。');
        for (const key of tokenKeys) {
            if (config.token_rates[key] !== null)
                issue(['token_rates', key], '按张或按秒计费不能同时填写 Token 单价。');
        }
    }
    const keys = new Set<string>();
    const specifications = new Set<string>();
    config.variants.forEach((variant, index) => {
        if (keys.has(variant.key)) issue(['variants', index, 'key'], '规格标识不能重复。');
        keys.add(variant.key);
        const specification = JSON.stringify([
            variant.resolution.toLowerCase(),
            variant.audio,
            variant.reference_video,
        ]);
        if (specifications.has(specification))
            issue(['variants', index, 'resolution'], '相同分辨率、声音和参考视频条件的规格不能重复。');
        specifications.add(specification);
        if (config.basis === 'image') {
            for (const field of ['minimum_units', 'step_units'] as const) {
                if (!Number.isSafeInteger(variant[field]))
                    issue(['variants', index, field], '图片的最低张数和递增张数必须是正整数。');
            }
            if (variant.audio !== 'any') issue(['variants', index, 'audio'], '图片规格不支持视频声音条件。');
            if (variant.reference_video !== 'any')
                issue(['variants', index, 'reference_video'], '图片规格不支持参考视频条件。');
        }
    });
    const prices =
        config.basis === 'token'
            ? tokenKeys.flatMap((key) =>
                  config.token_rates[key] === null
                      ? []
                      : [{ price: config.token_rates[key], path: ['token_rates', key] }],
              )
            : config.variants.map((variant, index) => ({ price: variant.price, path: ['variants', index, 'price'] }));
    // Zod may continue refinements after range failures. Never divide by an
    // invalid exchange rate or feed a nonfinite value into exact arithmetic.
    if (
        !Number.isFinite(config.upstream_multiplier) ||
        config.upstream_multiplier <= 0 ||
        !Number.isFinite(config.credits_per_cny) ||
        config.credits_per_cny <= 0 ||
        !Number.isFinite(config.markup_percent) ||
        config.markup_percent < 0
    )
        return;
    for (const { price, path } of prices) {
        if (!Number.isFinite(price) || price < 0) continue;
        const { cost, retail } = rawCostAndRetail(config, price);
        if (cost.n > ZERO && round(cost, 6) === 0)
            issue(path, '实际成本小于当前支持的 6 位小数精度，请使用更合适的计费单位。');
        if (retail.n > ZERO && round(retail, 4) === 0)
            issue(path, '售价小于当前支持的 4 位小数精度，不能保存成免费价格。');
        if (compare(retail, decimal(PRICING_COST_MAX_RETAIL)) > 0)
            issue(path, '售价超过支持范围（最高 ¥99,999,999.9999）。');
    }
});

/** Validates the entire draft before producing any line; absent cache rates are omitted. */
export function calculateCostPricing(input: PricingCostConfig): PricingCostCalculation {
    const config = pricingCostConfigSchema.parse(input);
    const makeLine = (key: string, label: string, unit: PricingCostLine['unit'], price: number): PricingCostLine => {
        const raw = rawCostAndRetail(config, price);
        const cost = round(raw.cost, 6);
        const retail = round(raw.retail, 4);
        const profit = round(subtract(decimal(retail), decimal(cost)), 6);
        return {
            key,
            label,
            unit,
            cost,
            retail,
            profit,
            margin_percent: retail > 0 ? round(divide(multiply(decimal(profit), decimal(100)), decimal(retail)), 4) : 0,
        };
    };
    const lines =
        config.basis === 'token'
            ? tokenKeys.flatMap((key) => {
                  const price = config.token_rates[key];
                  return price === null ? [] : [makeLine(key, tokenLabels[key], 'million_tokens', price)];
              })
            : config.variants.map((variant) =>
                  makeLine(variant.key, variant.label, config.basis === 'image' ? 'image' : 'second', variant.price),
              );
    return { lines, multiplier: asNumber(markupMultiplier(config)) };
}

/**
 * Trial only: token units are counts, images are whole counts, and video units are
 * seconds. For a nonzero request, charge the minimum plus whole incremental steps.
 * This does not assert that an upstream or billing backend supports those rules.
 */
export function calculateCostSample(input: PricingCostConfig, key: string, units: number): PricingCostSample {
    const config = pricingCostConfigSchema.parse(input);
    const calculation = calculateCostPricing(config);
    const line = calculation.lines.find((item) => item.key === key);
    if (!line) throw new Error('未找到该计费项的明确价格，不能按免费试算。');
    const requestedUnits = nonNegative.parse(units);
    if (config.basis !== 'video' && !Number.isSafeInteger(requestedUnits))
        throw new Error('Token 数和图片张数必须是非负整数。');
    let billed = decimal(requestedUnits);
    if (config.basis !== 'token' && requestedUnits > 0) {
        const variant = config.variants.find((item) => item.key === key)!;
        const minimum = decimal(variant.minimum_units);
        const excess = subtract(billed, minimum);
        if (excess.n <= ZERO) billed = minimum;
        else {
            const steps = divide(excess, decimal(variant.step_units));
            const count = (steps.n + steps.d - ONE) / steps.d;
            billed = add(minimum, multiply({ n: count, d: ONE }, decimal(variant.step_units)));
        }
    }
    if (compare(billed, decimal(MAX_SAFE_VALUE)) > 0) throw new Error('计费用量超出可安全计算的范围。');
    const priceUnits = config.basis === 'token' ? divide(billed, decimal(1_000_000)) : billed;
    const cost = asNumber(multiply(decimal(line.cost), priceUnits));
    const retail = asNumber(multiply(decimal(line.retail), priceUnits));
    const profit = asNumber(multiply(subtract(decimal(line.retail), decimal(line.cost)), priceUnits));
    if (![cost, retail, profit].every(Number.isFinite)) throw new Error('试算金额超出可安全计算的范围。');
    if (billed.n > ZERO && ((line.cost > 0 && cost === 0) || (line.retail > 0 && retail === 0))) {
        throw new Error('试算金额小于可安全计算的精度，不能显示为免费。');
    }
    return {
        line,
        requested_units: requestedUnits,
        billed_units: asNumber(billed),
        cost,
        retail,
        profit,
        margin_percent: retail > 0 ? line.margin_percent : 0,
    };
}
