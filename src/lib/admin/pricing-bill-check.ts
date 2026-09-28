/**
 * Billing check (计费核对) — pure and client-safe.
 *
 * Recomputes one request's charge the way new-api does (service/text_quota.go,
 * service/tiered_settle.go), from a model's base price in official $:
 *   official $ × 售价率(GroupRatio) = what the customer is charged
 *   official $ × 进货率(purchase rate) = what the upstream should charge us
 * Units come from the server view: the browser cannot read the prod env
 * (quota-units falls back to 7.2 there), so nothing here imports those constants.
 */
import type { BasePrice } from './pricing-simple-core';
import type { TieredPricingBuildTier } from './pricing-tiered-expression';

export interface BillUnits {
    /** ¥ per unit of base price; production = 1. */
    base_fx: number;
    /** new-api QuotaPerUnit; production = 500000. */
    quota_per_usd: number;
}

export interface BillUsage {
    /** prompt_tokens as new-api logs it. */
    prompt: number;
    completion: number;
    cache_read: number;
    /** Cache write (5-minute, or the undivided total for OpenAI-style usage). */
    cache_write: number;
    /** Anthropic 1-hour cache write; billed at cache_write × 1.6. */
    cache_write_1h: number;
    /**
     * Anthropic usage: prompt excludes cache tokens. OpenAI usage: prompt includes
     * them and new-api subtracts cache read/write before pricing the rest.
     */
    anthropic: boolean;
}

/** new-api's fixed 1h/5m cache-write price ratio (relay/helper/price.go). */
export const CACHE_WRITE_1H_MULTIPLIER = 6 / 3.75;
/** new-api defaults when a model has no CacheRatio / CreateCacheRatio entry. */
export const DEFAULT_CACHE_READ_RATIO = 1;
export const DEFAULT_CACHE_WRITE_RATIO = 1.25;

export interface BillLine {
    key: 'input' | 'output' | 'cache_read' | 'cache_write' | 'cache_write_1h' | 'per_call';
    tokens: number;
    /** Official $ per 1M tokens, or per call. */
    price: number;
    usd: number;
}

export interface BillEstimate {
    mode: BasePrice['mode'];
    /** Tiered only: 0-based tier that priced the whole request. */
    tier: number | null;
    lines: BillLine[];
    /** Official $ before any ratio. */
    official_usd: number;
    /** new-api quota the customer should be charged. */
    quota: number;
    customer_cny: number;
    /** Expected upstream cost in ¥; null when no purchase rate is set. */
    upstream_cny: number | null;
}

const PER_MILLION = 1_000_000;

function tokens(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function line(key: BillLine['key'], count: number, price: number): BillLine {
    return { key, tokens: count, price, usd: (count * price) / PER_MILLION };
}

function tokenLines(
    base: { input: number; output: number; cache_read: number | null; cache_write: number | null },
    usage: BillUsage,
): BillLine[] {
    const cacheRead = base.cache_read ?? base.input * DEFAULT_CACHE_READ_RATIO;
    const cacheWrite = base.cache_write ?? base.input * DEFAULT_CACHE_WRITE_RATIO;
    const cr = tokens(usage.cache_read);
    const cc = tokens(usage.cache_write);
    const cc1h = tokens(usage.cache_write_1h);
    // OpenAI usage has no 1h split in new-api; every cache write is one bucket.
    const write5m = usage.anthropic ? cc : cc + cc1h;
    const write1h = usage.anthropic ? cc1h : 0;
    const input = usage.anthropic ? tokens(usage.prompt) : Math.max(tokens(usage.prompt) - cr - write5m, 0);
    return [
        line('input', input, base.input),
        line('output', tokens(usage.completion), base.output),
        line('cache_read', cr, cacheRead),
        line('cache_write', write5m, cacheWrite),
        line('cache_write_1h', write1h, cacheWrite * CACHE_WRITE_1H_MULTIPLIER),
    ].filter((row) => row.tokens > 0);
}

/** Tier that prices the request: the first whose upper bound holds the full input length. */
export function pickTier(tiers: TieredPricingBuildTier[], inputLength: number): number {
    const index = tiers.findIndex(
        (tier) =>
            tier.max_input_tokens === null ||
            (tier.max_inclusive ? inputLength <= tier.max_input_tokens : inputLength < tier.max_input_tokens),
    );
    return index === -1 ? tiers.length - 1 : index;
}

function tieredLines(tiers: TieredPricingBuildTier[], usage: BillUsage): { tier: number; lines: BillLine[] } {
    let p = tokens(usage.prompt);
    const c = tokens(usage.completion);
    const cr = tokens(usage.cache_read);
    let cc = tokens(usage.cache_write);
    let cc1h = tokens(usage.cache_write_1h);
    if (!usage.anthropic) {
        // new-api only splits 5m/1h for Anthropic usage.
        cc += cc1h;
        cc1h = 0;
    }
    // A cache variable used by any tier changes normalization for every tier.
    const uses = (key: 'cache_read' | 'cache_write' | 'cache_write_1h') =>
        tiers.some((tier) => tier.rates[key] !== null);
    // Claude usage: prompt is already text-only, so only the tier length adds cache.
    const length = usage.anthropic ? p + cr + cc + cc1h : p;
    if (!usage.anthropic) {
        if (uses('cache_read')) p -= cr;
        if (uses('cache_write')) p -= cc;
        if (uses('cache_write_1h')) p -= cc1h;
    }
    const tier = pickTier(tiers, length);
    const rates = tiers[tier].rates;
    const lines = [
        line('input', Math.max(p, 0), rates.input),
        line('output', c, rates.output),
        ...(uses('cache_read') ? [line('cache_read', cr, rates.cache_read ?? 0)] : []),
        ...(uses('cache_write') ? [line('cache_write', cc, rates.cache_write ?? 0)] : []),
        ...(uses('cache_write_1h') ? [line('cache_write_1h', cc1h, rates.cache_write_1h ?? 0)] : []),
    ].filter((row) => row.tokens > 0);
    return { tier, lines };
}

export function estimateBill(
    base: BasePrice,
    usage: BillUsage,
    groupRatio: number,
    purchaseRate: number | null,
    units: BillUnits,
): BillEstimate {
    let lines: BillLine[];
    let tier: number | null = null;
    if (base.mode === 'per_call') lines = [{ key: 'per_call', tokens: 1, price: base.price, usd: base.price }];
    else if (base.mode === 'token') lines = tokenLines(base, usage);
    else ({ tier, lines } = tieredLines(base.tiers, usage));
    const officialUsd = lines.reduce((sum, row) => sum + row.usd, 0);
    const raw = officialUsd * units.quota_per_usd * groupRatio;
    // new-api charges at least 1 quota for a non-zero ratio.
    const quota = raw > 0 ? Math.max(Math.round(raw), 1) : 0;
    return {
        mode: base.mode,
        tier,
        lines,
        official_usd: officialUsd,
        quota,
        customer_cny: (quota / units.quota_per_usd) * units.base_fx,
        // 进货率 is in the same unit as the sell rate (¥ per official $1 at base_fx).
        upstream_cny: purchaseRate === null ? null : officialUsd * units.base_fx * purchaseRate,
    };
}

/** Customer side matches when within new-api's rounding (1 quota) or 0.1%. */
export function quotaMatches(expected: number, actual: number): boolean {
    return Math.abs(expected - actual) <= Math.max(1, Math.abs(actual) * 0.001);
}

/** Hand-typed ¥ amounts are rounded by the console that showed them; `tolerance` is relative. */
export function cnyMatches(expected: number, actual: number, tolerance = 0.02): boolean {
    return Math.abs(expected - actual) <= Math.max(0.0001, Math.abs(actual) * tolerance);
}

/** 利润倍数 and 毛利 from a buy rate and a sell rate (both ¥ per official $1). */
export function margin(purchaseRate: number | null, sellRate: number | null) {
    if (purchaseRate === null || sellRate === null || purchaseRate <= 0 || sellRate <= 0) return null;
    return { multiple: sellRate / purchaseRate, gross: 1 - purchaseRate / sellRate };
}

/** 进货率 from an upstream quote: channel ratio ÷ upstream credits per ¥1. */
export function purchaseRateFromQuote(creditsPerCny: number, channelRatio: number): number | null {
    if (!Number.isFinite(creditsPerCny) || !Number.isFinite(channelRatio) || creditsPerCny <= 0 || channelRatio <= 0)
        return null;
    return channelRatio / creditsPerCny;
}

// ── new-api log → check inputs ──

export interface LoggedBill {
    request_id: string;
    created_at: number;
    model: string;
    /** new-api group the request billed under. */
    group: string;
    channel: number;
    quota: number;
    usage: BillUsage;
    /** Ratios new-api recorded for this request (null when absent). */
    recorded: {
        model_ratio: number | null;
        completion_ratio: number | null;
        cache_ratio: number | null;
        cache_creation_ratio: number | null;
        group_ratio: number | null;
        /** Customer-specific ratio new-api applied instead of the group ratio. */
        user_group_ratio: number | null;
        model_price: number | null;
        tiered: boolean;
    };
}

function numberField(other: Record<string, unknown>, key: string): number | null {
    const value = other[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseLoggedBill(log: {
    request_id: string;
    created_at: number;
    model_name: string;
    group: string;
    channel: number;
    quota: number;
    prompt_tokens: number;
    completion_tokens: number;
    other: string;
}): LoggedBill {
    let other: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(log.other || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) other = parsed as Record<string, unknown>;
    } catch {
        other = {};
    }
    const field = (key: string) => numberField(other, key) ?? 0;
    const split5m = field('cache_creation_tokens_5m');
    const split1h = field('cache_creation_tokens_1h');
    const total = field('cache_creation_tokens');
    const split = split5m > 0 || split1h > 0;
    const price = numberField(other, 'model_price');
    const userRatio = numberField(other, 'user_group_ratio');
    return {
        request_id: log.request_id,
        created_at: log.created_at,
        model: log.model_name,
        group: log.group,
        channel: log.channel,
        quota: log.quota,
        usage: {
            prompt: log.prompt_tokens,
            completion: log.completion_tokens,
            cache_read: field('cache_tokens'),
            // Unsplit remainder is billed at the 5m price, like new-api does.
            cache_write: split ? split5m + Math.max(total - split5m - split1h, 0) : total,
            cache_write_1h: split1h,
            anthropic: other.usage_semantic === 'anthropic',
        },
        recorded: {
            model_ratio: numberField(other, 'model_ratio'),
            completion_ratio: numberField(other, 'completion_ratio'),
            cache_ratio: numberField(other, 'cache_ratio'),
            cache_creation_ratio: numberField(other, 'cache_creation_ratio'),
            group_ratio: numberField(other, 'group_ratio'),
            user_group_ratio: userRatio !== null && userRatio > 0 ? userRatio : null,
            model_price: price !== null && price >= 0 ? price : null,
            tiered: other.billing_mode === 'tiered_expr',
        },
    };
}
