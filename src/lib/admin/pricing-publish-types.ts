/**
 * Catalog price shapes shared by the pricing page, the catalog readers and the
 * public pricing views. All monetary values are CNY numbers, never Decimal
 * strings.
 *
 * This file used to carry the V1–V7 publication contracts too; those went with
 * that chain on 2026-11-08 (docs/2026-11-08-拆除签名发布链路.md). Only the
 * tiered-token shape and its scheduled discount are still in use, so the name
 * is now historical.
 */
export interface ScheduledDiscountWindowDetails {
    start: string;
    end: string;
    timezone: 'Asia/Shanghai';
    multiplier: number;
    weekdays?: number[];
    priority?: number;
}

export interface ScheduledDiscountDetails {
    /** Legacy single-window representation retained for existing catalog rows. */
    start?: string;
    end?: string;
    timezone?: 'Asia/Shanghai';
    multiplier?: number;
    windows?: ScheduledDiscountWindowDetails[];
}

export interface TieredPricingDetails {
    version: 1;
    mode: 'tiered_token';
    unit: 'cny_per_million_tokens';
    semantics: 'whole_request';
    tiers: Array<{
        name: string;
        min_input_tokens: number | null;
        max_input_tokens: number | null;
        min_inclusive: boolean;
        max_inclusive: boolean;
        rates: {
            input: number;
            output: number;
            cache_read: number | null;
            cache_write: number | null;
            cache_write_1h: number | null;
        };
    }>;
    scheduled_discount?: ScheduledDiscountDetails;
}
