/**
 * Official-price discount quotes for video-token models (pure, client-safe).
 *
 * Customer ¥ per 1M tokens = coefficient × fx × group ratio, where fx is
 * USD_TO_CNY_RATE (production 1) and the group ratio is the tier's live
 * GroupRatio. Each coefficient = official × sell discount ÷ (fx × group ratio),
 * rounded UP to two decimals, so customers never pay below the target.
 * Arithmetic is exact (bigint rationals); only the outputs become JS numbers.
 */
import type { PricingCostConfig } from './pricing-cost-types';
import {
    VIDEO_TOKEN_COMBOS,
    VIDEO_TOKEN_MAX_PRICE,
    videoTokenInputLabel,
    videoTokenKey,
    type VideoTokenInput,
    type VideoTokenResolution,
} from './pricing-video-token-expression';

export interface VideoQuoteOfficialCell {
    resolution: VideoTokenResolution;
    video_input: VideoTokenInput;
    /** Official ¥ per 1M tokens. */
    price: number;
}

export interface VideoQuoteInput {
    official: VideoQuoteOfficialCell[];
    /** What we pay as a fraction of official, e.g. 0.7 = 7折. */
    buy_discount: number;
    /** What customers pay as a fraction of official. */
    sell_discount: number;
}

export interface VideoQuoteCell {
    resolution: VideoTokenResolution;
    video_input: VideoTokenInput;
    official: number;
    /** Our cost, ¥ per 1M tokens. */
    cost: number;
    /** official × sell discount. */
    target: number;
    /** new-api coefficient, two decimals, rounded up. */
    coefficient: number;
    /** What customers are billed: coefficient × fx × group ratio. */
    actual: number;
    /** (actual − cost) ÷ actual. */
    margin: number;
}

export class VideoQuoteError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VideoQuoteError';
    }
}

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TEN = BigInt(10);
const HUNDRED = BigInt(100);

interface Rational {
    n: bigint;
    d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
    let x = a < ZERO ? -a : a;
    let y = b;
    while (y !== ZERO) [x, y] = [y, x % y];
    return x === ZERO ? ONE : x;
}

function reduce(n: bigint, d: bigint): Rational {
    const g = gcd(n, d);
    return { n: n / g, d: d / g };
}

function exact(value: number, label: string): Rational {
    const text = String(value);
    if (!Number.isFinite(value) || value < 0 || !/^\d+(?:\.\d+)?$/.test(text))
        throw new VideoQuoteError(`${label}不是有效的数字。`);
    const [whole, digits = ''] = text.split('.');
    return reduce(BigInt(whole + digits), TEN ** BigInt(digits.length));
}

const multiply = (a: Rational, b: Rational) => reduce(a.n * b.n, a.d * b.d);
const divide = (a: Rational, b: Rational) => reduce(a.n * b.d, a.d * b.n);
const subtract = (a: Rational, b: Rational) => reduce(a.n * b.d - b.n * a.d, a.d * b.d);

/** Round half up to `places` decimals; inputs here are never negative. */
function toNumber(value: Rational, places = 6): number {
    const scale = TEN ** BigInt(places);
    return Number((value.n * scale * BigInt(2) + value.d) / (value.d * BigInt(2))) / Number(scale);
}

function checkDiscount(value: number, label: string): Rational {
    if (!Number.isFinite(value) || value <= 0 || value > 2) throw new VideoQuoteError(`${label}须大于 0 且不超过 2。`);
    return exact(value, label);
}

/** Compute every cell. `fx` and `groupRatio` come from the server's live configuration. */
export function computeVideoQuote(input: VideoQuoteInput, fx: number, groupRatio: number): VideoQuoteCell[] {
    const buy = checkDiscount(input.buy_discount, '进货折扣');
    const sell = checkDiscount(input.sell_discount, '售卖折扣');
    if (input.sell_discount < input.buy_discount) throw new VideoQuoteError('售卖折扣低于进货折扣，每单都会亏损。');
    if (!(fx > 0) || !(groupRatio > 0)) throw new VideoQuoteError('档次倍率或换算比例无效。');
    const unit = multiply(exact(fx, '换算比例'), exact(groupRatio, '档次倍率'));
    const prices = new Map(input.official.map((cell) => [videoTokenKey(cell), cell.price]));
    if (input.official.length !== VIDEO_TOKEN_COMBOS.length || prices.size !== VIDEO_TOKEN_COMBOS.length)
        throw new VideoQuoteError('须填写全部 8 档的官方价。');
    return VIDEO_TOKEN_COMBOS.map((combo) => {
        const label = `${combo.resolution} ${videoTokenInputLabel(combo.video_input)}`;
        const price = prices.get(videoTokenKey(combo));
        if (price === undefined || !(price > 0) || price > VIDEO_TOKEN_MAX_PRICE)
            throw new VideoQuoteError(`请填写 ${label} 的官方价（大于 0）。`);
        const official = exact(price, `${label} 官方价`);
        const cost = multiply(official, buy);
        const target = multiply(official, sell);
        const raw = divide(target, unit);
        const cents = (raw.n * HUNDRED + raw.d - ONE) / raw.d;
        if (cents <= ZERO || Number(cents) / 100 > VIDEO_TOKEN_MAX_PRICE)
            throw new VideoQuoteError(`${label} 的计费系数超出范围。`);
        const coefficient = reduce(cents, HUNDRED);
        const actual = multiply(coefficient, unit);
        return {
            ...combo,
            official: price,
            cost: toNumber(cost),
            target: toNumber(target),
            coefficient: Number(cents) / 100,
            actual: toNumber(actual),
            margin: toNumber(divide(subtract(actual, cost), actual)),
        };
    });
}

/** Stored as a Portal cost rule: official prices, buy discount and sell discount. */
export function videoQuoteCostConfig(input: VideoQuoteInput): PricingCostConfig {
    const prices = new Map(input.official.map((cell) => [videoTokenKey(cell), cell.price]));
    return {
        version: 1,
        basis: 'video',
        video_unit: 'million_tokens',
        currency: 'cny',
        credits_per_cny: 1,
        upstream_multiplier: input.buy_discount,
        retail_multiplier: input.sell_discount,
        markup_percent: 0,
        source_note: '官方价 × 折扣（视频 token 报价）',
        token_rates: { input: null, output: null, cache_read: null, cache_write: null },
        variants: VIDEO_TOKEN_COMBOS.map((combo) => ({
            key: `${combo.resolution}-${combo.video_input}`,
            label: `${combo.resolution} · ${videoTokenInputLabel(combo.video_input)}`,
            resolution: combo.resolution,
            audio: 'any' as const,
            reference_video: combo.video_input === 'video' ? ('with' as const) : ('without' as const),
            price: prices.get(videoTokenKey(combo)) ?? Number.NaN,
            minimum_units: 1,
            step_units: 1,
        })),
    };
}

/** The quote a stored cost rule holds, or null when it is not a complete video-token quote. */
export function videoQuoteFromCostConfig(config: PricingCostConfig): VideoQuoteInput | null {
    if (config.basis !== 'video' || config.video_unit !== 'million_tokens' || config.retail_multiplier === undefined)
        return null;
    const official: VideoQuoteOfficialCell[] = [];
    for (const combo of VIDEO_TOKEN_COMBOS) {
        const wanted = combo.video_input === 'video' ? 'with' : 'without';
        const matches = config.variants.filter(
            (variant) => variant.resolution === combo.resolution && variant.reference_video === wanted,
        );
        if (matches.length !== 1) return null;
        official.push({ ...combo, price: matches[0].price });
    }
    if (config.variants.length !== official.length) return null;
    return { official, buy_discount: config.upstream_multiplier, sell_discount: config.retail_multiplier };
}
