import { z } from 'zod';
import type { TieredPricingDetails } from '@/lib/admin/pricing-publish-types';
import {
    parseTieredPricingDetails,
    scalePricingAmount,
    scaleTieredPricingDetails,
    formatTieredPrice,
} from './tiered-pricing-details';

const rate = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const resolution = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\w.-]+$/);
const discount = z
    .object({
        start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
        timezone: z.literal('Asia/Shanghai'),
        multiplier: rate.max(1),
    })
    .strict();
const mediaSchema = z
    .object({
        version: z.literal(1),
        mode: z.literal('media'),
        unit: z.enum(['cny_per_image', 'cny_per_request', 'cny_per_second']),
        default_price: rate.nullable(),
        resolution_prices: z.record(resolution, rate),
        scheduled_discount: discount.optional(),
    })
    .strict()
    .refine((value) => value.default_price !== null || Object.keys(value.resolution_prices).length > 0);
const componentSchema = z
    .object({
        version: z.literal(1),
        mode: z.literal('component_token'),
        unit: z.literal('cny_per_million_tokens'),
        rates: z
            .object({
                input: rate,
                output: rate,
                cache_read: rate.nullable(),
                image_input: rate,
                image_cache_read: rate.nullable(),
            })
            .strict(),
    })
    .strict();

export type MediaPricingDetails = z.infer<typeof mediaSchema>;
export type ComponentTokenPricingDetails = z.infer<typeof componentSchema>;
export type CatalogBillingDetails = TieredPricingDetails | MediaPricingDetails | ComponentTokenPricingDetails;

/** Validate every mode before exposing it. Unknown non-null metadata never falls back to a scalar quote. */
export function parseCatalogBillingDetails(raw: unknown): CatalogBillingDetails | null {
    if (raw == null) return null;
    const mode = typeof raw === 'object' && 'mode' in raw ? raw.mode : null;
    if (mode === 'tiered_token') return parseTieredPricingDetails(raw);
    if (mode === 'media') return mediaSchema.parse(raw);
    if (mode === 'component_token') return componentSchema.parse(raw);
    throw new Error('Invalid catalog billing details');
}

export function scaleCatalogBillingDetails(raw: CatalogBillingDetails, scale: number): CatalogBillingDetails {
    const details = parseCatalogBillingDetails(raw)!;
    if (details.mode === 'tiered_token') return scaleTieredPricingDetails(details, scale);
    if (details.mode === 'component_token') {
        for (const key of Object.keys(details.rates) as Array<keyof typeof details.rates>) {
            const value = details.rates[key];
            if (value !== null) details.rates[key] = scalePricingAmount(value, scale);
        }
    } else {
        if (details.default_price !== null) details.default_price = scalePricingAmount(details.default_price, scale);
        for (const [key, value] of Object.entries(details.resolution_prices))
            details.resolution_prices[key] = scalePricingAmount(value, scale);
    }
    return details;
}

export function catalogDetailLines(
    details: Exclude<CatalogBillingDetails, TieredPricingDetails>,
    en = false,
): string[] {
    if (details.mode === 'component_token') {
        const labels = {
            input: en ? 'Text input' : '文本输入',
            output: en ? 'Output' : '输出',
            cache_read: en ? 'Text cache read' : '文本缓存读取',
            image_input: en ? 'Image input' : '图片输入',
            image_cache_read: en ? 'Image cache read' : '图片缓存读取',
        };
        return Object.entries(details.rates).flatMap(([key, value]) =>
            value === null
                ? []
                : [
                      `${labels[key as keyof typeof labels]} ¥${formatTieredPrice(value)} / ${en ? 'million tokens' : '百万 token'}`,
                  ],
        );
    }
    const unit =
        details.unit === 'cny_per_image'
            ? en
                ? 'image'
                : '张'
            : details.unit === 'cny_per_second'
              ? en
                  ? 'second'
                  : '秒'
              : en
                ? 'request'
                : '次';
    const price = (value: number) => `¥${formatTieredPrice(value)} / ${unit}`;
    const lines = [
        ...(details.default_price === null ? [] : [`${en ? 'Default' : '默认'}：${price(details.default_price)}`]),
        ...Object.entries(details.resolution_prices).map(([key, value]) => `${key}：${price(value)}`),
    ];
    if (details.scheduled_discount) {
        const d = details.scheduled_discount;
        lines.push(
            en
                ? `Daily ${d.start}–${d.end} (Asia/Shanghai): above rates × ${d.multiplier}`
                : `每日 ${d.start}–${d.end}（北京时间）：以上价格 × ${d.multiplier}`,
        );
    }
    return lines;
}
