/**
 * Simple pricing core (docs/PRICING-SIMPLIFY.md). Pure and I/O-free.
 *
 * One formula:  customer ¥ = base price × USD_TO_CNY_RATE × GroupRatio[tier group].
 * The base price is new-api's own unit, held once per upstream model:
 *   token    → ModelRatio / CompletionRatio / CacheRatio / CreateCacheRatio
 *   tiered   → billing_setting.billing_mode = tiered_expr + billing_setting.billing_expr
 *   per_call → ModelPrice
 * Portal never keeps a second copy of the truth; CatalogPrice rows are display
 * snapshots derived from these options.
 */
import { z } from 'zod';
import { QUOTA_PER_USD, USD_TO_CNY_RATE } from '@/lib/newapi/quota-units';
import {
    buildTieredPricingExpression,
    parseTieredPricingExpression,
    type TieredPricingBuildTier,
} from './pricing-tiered-expression';
import type { TieredPricingDetails } from './pricing-publish-types';

/** ¥ per 1 unit of base price (tiered coefficients and ModelPrice). Production = 1. */
export const BASE_FX = USD_TO_CNY_RATE;
/** ModelRatio = input base $/1M ÷ this. Production (500k quota per $) = 2. */
export const RATIO_UNIT = 1_000_000 / QUOTA_PER_USD;

export const EXPR_KEY = 'billing_setting.billing_expr';
export const MODE_KEY = 'billing_setting.billing_mode';
export const GROUP_SETTING_KEY = 'group_ratio_setting.group_ratio';

export type SimpleOptionKey =
    | 'ModelRatio'
    | 'CompletionRatio'
    | 'ModelPrice'
    | 'CacheRatio'
    | 'CreateCacheRatio'
    | typeof MODE_KEY
    | typeof EXPR_KEY
    | 'GroupRatio'
    | typeof GROUP_SETTING_KEY;

export interface TokenBasePrice {
    mode: 'token';
    input: number;
    output: number;
    cache_read: number | null;
    cache_write: number | null;
}
export interface TieredBasePrice {
    mode: 'tiered';
    tiers: TieredPricingBuildTier[];
}
export interface PerCallBasePrice {
    mode: 'per_call';
    price: number;
}
export type BasePrice = TokenBasePrice | TieredBasePrice | PerCallBasePrice;

export class SimplePricingError extends Error {
    constructor(
        public code: string,
        message: string,
        public status = 409,
    ) {
        super(message);
        this.name = 'SimplePricingError';
    }
}

const amount = z.number().finite().nonnegative().max(1_000_000);
const optionalAmount = amount.nullable();
const tierSchema = z
    .object({
        max_input_tokens: z.number().int().positive().max(100_000_000).nullable(),
        max_inclusive: z.boolean(),
        rates: z
            .object({
                input: amount,
                output: amount,
                cache_read: optionalAmount,
                cache_write: optionalAmount,
                cache_write_1h: optionalAmount,
            })
            .strict(),
    })
    .strict();

export const basePriceSchema: z.ZodType<BasePrice> = z.discriminatedUnion('mode', [
    z
        .object({
            mode: z.literal('token'),
            input: amount.positive('输入价须大于 0。'),
            output: amount,
            cache_read: optionalAmount,
            cache_write: optionalAmount,
        })
        .strict(),
    z.object({ mode: z.literal('tiered'), tiers: z.array(tierSchema).min(1).max(8) }).strict(),
    z.object({ mode: z.literal('per_call'), price: amount.positive('按次价须大于 0。') }).strict(),
]);

// ── helpers ──

export function round(value: number, places = 12): number {
    return Number(value.toFixed(places));
}

export function sameNumber(a: number, b: number): boolean {
    if (a === b) return true;
    return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-9;
}

function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Option dictionaries arrive as JSON strings or objects; absence is allowed only when `optional`. */
export function optionDict(options: Record<string, unknown>, key: string, optional = false): Record<string, unknown> {
    if (!Object.hasOwn(options, key)) {
        if (optional) return {};
        throw new SimplePricingError('pricing_options_invalid', `未读到 new-api 的 ${key} 配置。`, 503);
    }
    let parsed = options[key];
    if (typeof parsed === 'string') {
        if (!parsed.trim() && optional) return {};
        try {
            parsed = JSON.parse(parsed);
        } catch {
            parsed = null;
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new SimplePricingError('pricing_options_invalid', `new-api 的 ${key} 配置格式无效。`, 503);
    return { ...(parsed as Record<string, unknown>) };
}

function completionMeta(options: Record<string, unknown>, name: string): { ratio: number; locked: boolean } | null {
    const meta = optionDict(options, 'CompletionRatioMeta', true)[name];
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const { ratio, locked } = meta as { ratio?: unknown; locked?: unknown };
    return finiteNumber(ratio) ? { ratio, locked: locked === true } : null;
}

// ── read ──

/** The base price new-api actually bills for `name`, or null when unpriced. */
export function readBasePrice(options: Record<string, unknown>, name: string): BasePrice | null {
    const modes = optionDict(options, MODE_KEY, true);
    if (modes[name] === 'tiered_expr') {
        const expression = optionDict(options, EXPR_KEY, true)[name];
        if (typeof expression !== 'string') return null;
        const parsed = parseTieredPricingExpression(expression);
        return {
            mode: 'tiered',
            tiers: parsed.tiers.map((tier) => ({
                max_input_tokens: tier.max_input_tokens,
                max_inclusive: tier.max_inclusive,
                rates: { ...tier.rates },
            })),
        };
    }
    const price = optionDict(options, 'ModelPrice')[name];
    if (finiteNumber(price)) return { mode: 'per_call', price };
    const ratio = optionDict(options, 'ModelRatio')[name];
    if (!finiteNumber(ratio)) return null;
    const input = round(ratio * RATIO_UNIT);
    const completion = completionMeta(options, name)?.ratio ?? optionDict(options, 'CompletionRatio')[name];
    const cache = optionDict(options, 'CacheRatio', true)[name];
    const create = optionDict(options, 'CreateCacheRatio', true)[name];
    return {
        mode: 'token',
        input,
        output: round(input * (finiteNumber(completion) ? completion : 1)),
        cache_read: finiteNumber(cache) ? round(input * cache) : null,
        cache_write: finiteNumber(create) ? round(input * create) : null,
    };
}

const MODEL_KEYS: SimpleOptionKey[] = [
    'ModelRatio',
    'CompletionRatio',
    'CacheRatio',
    'CreateCacheRatio',
    'ModelPrice',
    EXPR_KEY,
    MODE_KEY,
];

/** Stable view of every option entry that prices `name`; used as the optimistic-lock token. */
export function modelOptionState(options: Record<string, unknown>, name: string): string {
    return JSON.stringify(
        MODEL_KEYS.map((key) => {
            const dict = optionDict(
                options,
                key,
                key !== 'ModelRatio' && key !== 'CompletionRatio' && key !== 'ModelPrice',
            );
            return [key, Object.hasOwn(dict, name) ? dict[name] : null];
        }),
    );
}

// ── write plans ──

export interface OptionWrite {
    key: SimpleOptionKey;
    /** Complete next dictionary; only `entry` differs from what was read. */
    value: Record<string, unknown>;
    entry: string;
    /** Target value of `entry`; undefined means the entry is removed. */
    target: unknown;
}

function setEntry(
    options: Record<string, unknown>,
    key: SimpleOptionKey,
    name: string,
    target: unknown,
    optional = true,
): OptionWrite | null {
    const dict = optionDict(options, key, optional);
    const present = Object.hasOwn(dict, name);
    if (target === undefined) {
        if (!present) return null;
        delete dict[name];
    } else {
        const current = dict[name];
        if (
            present &&
            (current === target ||
                (typeof current === 'number' && typeof target === 'number' && sameNumber(current, target)))
        )
            return null;
        dict[name] = target;
    }
    return { key, value: dict, entry: name, target };
}

/**
 * Minimal, ordered option writes that make new-api bill `base` for `name`.
 * Order keeps every intermediate state billable: new pricing keys are written
 * before the mode switch; obsolete keys are removed after it.
 */
export function planModelWrites(options: Record<string, unknown>, name: string, base: BasePrice): OptionWrite[] {
    const parsed = basePriceSchema.parse(base);
    const early: Array<OptionWrite | null> = [];
    const late: Array<OptionWrite | null> = [];
    const modes = optionDict(options, MODE_KEY, true);
    if (parsed.mode === 'token') {
        const completion = round(parsed.output / parsed.input);
        const meta = completionMeta(options, name);
        if (meta?.locked && !sameNumber(meta.ratio, completion))
            throw new SimplePricingError(
                'pricing_completion_locked',
                `new-api 锁定了「${name}」的输出倍率为 ${meta.ratio},输出价只能是输入价的 ${meta.ratio} 倍;如需其他输出价请改用阶梯形态。`,
            );
        early.push(
            setEntry(options, 'ModelRatio', name, round(parsed.input / RATIO_UNIT), false),
            setEntry(options, 'CompletionRatio', name, completion, false),
            setEntry(
                options,
                'CacheRatio',
                name,
                parsed.cache_read === null ? undefined : round(parsed.cache_read / parsed.input),
            ),
            setEntry(
                options,
                'CreateCacheRatio',
                name,
                parsed.cache_write === null ? undefined : round(parsed.cache_write / parsed.input),
            ),
        );
        late.push(
            setEntry(options, 'ModelPrice', name, undefined, false),
            setEntry(options, MODE_KEY, name, undefined),
            setEntry(options, EXPR_KEY, name, undefined),
        );
    } else if (parsed.mode === 'tiered') {
        if (!Object.hasOwn(options, MODE_KEY) || !Object.hasOwn(options, EXPR_KEY))
            throw new SimplePricingError('pricing_tiered_unsupported', '当前 new-api 版本不支持阶梯计费。');
        const expression = buildTieredPricingExpression(parsed.tiers);
        const ratios = optionDict(options, 'ModelRatio');
        // new-api still wants a ratio for the model to be listed; it never bills it in tiered mode.
        if (!finiteNumber(ratios[name])) {
            const first = parsed.tiers[0].rates;
            early.push(setEntry(options, 'ModelRatio', name, round(first.input / RATIO_UNIT), false));
            if (first.input > 0)
                early.push(setEntry(options, 'CompletionRatio', name, round(first.output / first.input), false));
        }
        early.push(setEntry(options, EXPR_KEY, name, expression), setEntry(options, MODE_KEY, name, 'tiered_expr'));
        late.push(setEntry(options, 'ModelPrice', name, undefined, false));
    } else {
        early.push(setEntry(options, 'ModelPrice', name, parsed.price, false));
        if (modes[name] !== undefined) early.push(setEntry(options, MODE_KEY, name, undefined));
        late.push(setEntry(options, EXPR_KEY, name, undefined));
    }
    return [...early, ...late].filter((write): write is OptionWrite => write !== null);
}

/** GroupRatio (+ group_ratio_setting when new-api keeps a copy there). */
export function planGroupRatioWrites(options: Record<string, unknown>, group: string, ratio: number): OptionWrite[] {
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1000)
        throw new SimplePricingError('pricing_ratio_invalid', '档次倍率须为 0 到 1000 之间的正数。', 400);
    const target = round(ratio, 6);
    const writes = [setEntry(options, 'GroupRatio', group, target, false)];
    if (Object.hasOwn(optionDict(options, GROUP_SETTING_KEY, true), group))
        writes.push(setEntry(options, GROUP_SETTING_KEY, group, target));
    return writes.filter((write): write is OptionWrite => write !== null);
}

/** Keys whose readback does not hold the planned entry. */
export function unverifiedWrites(readback: Record<string, unknown>, writes: OptionWrite[]): string[] {
    return writes
        .filter((write) => {
            const dict = optionDict(readback, write.key, true);
            if (write.target === undefined) return Object.hasOwn(dict, write.entry);
            const actual = dict[write.entry];
            if (typeof write.target === 'number')
                return typeof actual !== 'number' || !sameNumber(actual, write.target);
            return actual !== write.target;
        })
        .map((write) => write.key);
}

export function groupRatioOf(options: Record<string, unknown>, group: string): number | null {
    const ratio = optionDict(options, 'GroupRatio')[group];
    return finiteNumber(ratio) && ratio > 0 ? ratio : null;
}

// ── customer prices (CatalogPrice snapshot shape) ──

export interface CatalogAmounts {
    input_cny_per_1m: number | null;
    output_cny_per_1m: number | null;
    per_image_cny: number | null;
    billing_details: TieredPricingDetails | null;
}

function cny(value: number, groupRatio: number): number {
    return round(value * BASE_FX * groupRatio);
}

export function customerPrice(base: BasePrice, groupRatio: number): CatalogAmounts {
    if (base.mode === 'per_call')
        return {
            input_cny_per_1m: null,
            output_cny_per_1m: null,
            per_image_cny: round(cny(base.price, groupRatio), 4),
            billing_details: null,
        };
    const tiers =
        base.mode === 'token'
            ? [
                  {
                      max_input_tokens: null,
                      max_inclusive: false,
                      rates: {
                          input: base.input,
                          output: base.output,
                          cache_read: base.cache_read,
                          cache_write: base.cache_write,
                          cache_write_1h: null,
                      },
                  },
              ]
            : base.tiers;
    const first = tiers[0].rates;
    const hasCache = tiers.some((tier) => tier.rates.cache_read !== null || tier.rates.cache_write !== null);
    const details: TieredPricingDetails | null =
        base.mode === 'tiered' || hasCache
            ? {
                  version: 1,
                  mode: 'tiered_token',
                  unit: 'cny_per_million_tokens',
                  semantics: 'whole_request',
                  tiers: tiers.map((tier, index) => {
                      const prior = index > 0 ? tiers[index - 1] : null;
                      const optional = (value: number | null) => (value === null ? null : cny(value, groupRatio));
                      return {
                          name: base.mode === 'token' ? 'uniform' : index === 0 ? 'base' : `tier_${index + 1}`,
                          min_input_tokens: prior?.max_input_tokens ?? null,
                          max_input_tokens: tier.max_input_tokens,
                          min_inclusive: prior ? !prior.max_inclusive : false,
                          max_inclusive: tier.max_input_tokens === null ? false : tier.max_inclusive,
                          rates: {
                              input: cny(tier.rates.input, groupRatio),
                              output: cny(tier.rates.output, groupRatio),
                              cache_read: optional(tier.rates.cache_read),
                              cache_write: optional(tier.rates.cache_write),
                              cache_write_1h: optional(tier.rates.cache_write_1h),
                          },
                      };
                  }),
              }
            : null;
    return {
        input_cny_per_1m: round(cny(first.input, groupRatio), 4),
        output_cny_per_1m: round(cny(first.output, groupRatio), 4),
        per_image_cny: null,
        billing_details: details,
    };
}

function sameScalar(a: number | null, b: number | null): boolean {
    if (a === null || b === null) return a === b;
    return Math.abs(a - b) < 0.00005 + 1e-9;
}

/**
 * Does the displayed catalog row match what new-api bills? Multi-tier details
 * must match; single-tier cache details are compared only when the row has them.
 */
export function catalogMatches(catalog: CatalogAmounts, expected: CatalogAmounts): boolean {
    if (
        !sameScalar(catalog.input_cny_per_1m, expected.input_cny_per_1m) ||
        !sameScalar(catalog.output_cny_per_1m, expected.output_cny_per_1m) ||
        !sameScalar(catalog.per_image_cny, expected.per_image_cny)
    )
        return false;
    const want = expected.billing_details;
    const have = catalog.billing_details;
    // Scalars already cover a single uniform rate; details only matter for real tiers or cache prices.
    const needsDetails = (details: TieredPricingDetails | null) =>
        !!details &&
        (details.tiers.length > 1 ||
            details.tiers.some((tier) => tier.rates.cache_read !== null || tier.rates.cache_write !== null));
    if (!want || !have) return !needsDetails(want) && !needsDetails(have);
    if (want.tiers.length !== have.tiers.length) return false;
    return want.tiers.every((tier, index) => {
        const other = have.tiers[index];
        return (
            tier.max_input_tokens === other.max_input_tokens &&
            tier.max_inclusive === other.max_inclusive &&
            (['input', 'output', 'cache_read', 'cache_write', 'cache_write_1h'] as const).every((key) => {
                const a = tier.rates[key];
                const b = other.rates[key];
                return a === null || b === null ? a === b : sameNumber(a, b);
            })
        );
    });
}
