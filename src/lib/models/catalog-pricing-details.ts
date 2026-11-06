import { z } from 'zod';
import type { TieredPricingDetails } from '@/lib/admin/pricing-publish-types';
import {
    parseTieredPricingDetails,
    scalePricingAmount,
    scaleTieredPricingDetails,
    formatTieredPrice,
} from './tiered-pricing-details';
import {
    VIDEO_TOKEN_COMBOS,
    VIDEO_TOKEN_INPUTS,
    VIDEO_TOKEN_RESOLUTIONS,
    videoTokenInputLabel,
    videoTokenKey,
} from '@/lib/admin/pricing-video-token-expression';

const rate = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const resolution = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\w.-]+$/);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const weekdays = z
    .array(z.number().int().min(1).max(7))
    .max(7)
    .superRefine((values, context) => {
        if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: 'Duplicate weekdays' });
    });
const discountWindow = z
    .object({
        start: clock,
        end: clock,
        timezone: z.literal('Asia/Shanghai'),
        multiplier: rate.max(1),
        weekdays: weekdays.optional(),
        priority: z.number().int().finite().optional(),
    })
    .strict()
    .refine((value) => value.start !== value.end, { message: 'Discount window cannot be empty' });
const discount = z
    .object({
        start: clock.optional(),
        end: clock.optional(),
        timezone: z.literal('Asia/Shanghai').optional(),
        multiplier: rate.max(1).optional(),
        windows: z.array(discountWindow).min(1).max(64).optional(),
    })
    .strict()
    .superRefine((value, context) => {
        const legacy = value.start !== undefined || value.end !== undefined || value.multiplier !== undefined;
        if (legacy && (value.start === undefined || value.end === undefined || value.multiplier === undefined))
            context.addIssue({ code: 'custom', message: 'Incomplete legacy discount window' });
        if (legacy && value.timezone === undefined)
            context.addIssue({ code: 'custom', message: 'Legacy discount timezone is required' });
        if (!legacy && !value.windows?.length)
            context.addIssue({ code: 'custom', message: 'Discount windows are required' });
    });
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
        scheduled_discount: discount.optional(),
    })
    .strict();

/** Video billed per 1M upstream tokens at a price chosen by output resolution and reference video. */
const videoTokenSchema = z
    .object({
        version: z.literal(1),
        mode: z.literal('video_token'),
        unit: z.literal('cny_per_million_tokens'),
        cells: z
            .array(
                z
                    .object({
                        resolution: z.enum(VIDEO_TOKEN_RESOLUTIONS),
                        video_input: z.enum(VIDEO_TOKEN_INPUTS),
                        price: rate,
                    })
                    .strict(),
            )
            .min(1)
            .max(VIDEO_TOKEN_COMBOS.length),
        scheduled_discount: discount.optional(),
    })
    .strict()
    .superRefine((value, context) => {
        const keys = value.cells.map(videoTokenKey);
        if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', message: 'Duplicate video cell' });
        const order = VIDEO_TOKEN_COMBOS.map(videoTokenKey);
        if (keys.some((key, index) => index > 0 && order.indexOf(key) < order.indexOf(keys[index - 1])))
            context.addIssue({ code: 'custom', message: 'Video cells out of order' });
    });

export type MediaPricingDetails = z.infer<typeof mediaSchema>;
export type ComponentTokenPricingDetails = z.infer<typeof componentSchema>;
export type VideoTokenPricingDetails = z.infer<typeof videoTokenSchema>;
export type CatalogBillingDetails =
    TieredPricingDetails | MediaPricingDetails | ComponentTokenPricingDetails | VideoTokenPricingDetails;

/** Validate every mode before exposing it. Unknown non-null metadata never falls back to a scalar quote. */
export function parseCatalogBillingDetails(raw: unknown): CatalogBillingDetails | null {
    if (raw == null) return null;
    const mode = typeof raw === 'object' && 'mode' in raw ? raw.mode : null;
    if (mode === 'tiered_token') return parseTieredPricingDetails(raw);
    if (mode === 'media') return mediaSchema.parse(raw);
    if (mode === 'component_token') return componentSchema.parse(raw);
    if (mode === 'video_token') return videoTokenSchema.parse(raw);
    throw new Error('Invalid catalog billing details');
}

/** The cell a one-line summary shows: 720p without reference video, else the first listed. */
export function videoTokenSummaryCell(details: VideoTokenPricingDetails): VideoTokenPricingDetails['cells'][number] {
    return details.cells.find((cell) => cell.resolution === '720p' && cell.video_input === 'none') ?? details.cells[0];
}

export function scaleCatalogBillingDetails(raw: CatalogBillingDetails, scale: number): CatalogBillingDetails {
    const details = parseCatalogBillingDetails(raw)!;
    if (details.mode === 'tiered_token') return scaleTieredPricingDetails(details, scale);
    if (details.mode === 'video_token') {
        for (const cell of details.cells) cell.price = scalePricingAmount(cell.price, scale);
        return details;
    }
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

export function catalogScheduledDiscountLines(value: NonNullable<z.infer<typeof discount>>, en = false): string[] {
    const windows = value.windows ?? [
        {
            start: value.start!,
            end: value.end!,
            timezone: value.timezone!,
            multiplier: value.multiplier!,
        },
    ];
    return windows.map((window) => {
        const days = window.weekdays?.length
            ? ` ${window.weekdays
                  .map((day) =>
                      en
                          ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][day - 1]
                          : ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][day - 1],
                  )
                  .join(en ? ', ' : '、')}`
            : '';
        const priority =
            window.priority === undefined ? '' : en ? ` priority ${window.priority}` : ` 优先级 ${window.priority}`;
        return en
            ? `Scheduled ${window.start}–${window.end} (Asia/Shanghai)${days}${priority}: rates × ${window.multiplier}`
            : `分时 ${window.start}–${window.end}（北京时间）${days}${priority}：以上价格 × ${window.multiplier}`;
    });
}

export function catalogDetailLines(
    details: Exclude<CatalogBillingDetails, TieredPricingDetails>,
    en = false,
): string[] {
    if (details.mode === 'video_token')
        return [
            ...details.cells.map(
                (cell) =>
                    `${cell.resolution} · ${videoTokenInputLabel(cell.video_input, en)} ¥${formatTieredPrice(cell.price)} / ${en ? 'million tokens' : '百万 token'}`,
            ),
            ...(details.scheduled_discount ? catalogScheduledDiscountLines(details.scheduled_discount, en) : []),
        ];
    if (details.mode === 'component_token') {
        const labels = {
            input: en ? 'Text input' : '文本输入',
            output: en ? 'Output' : '输出',
            cache_read: en ? 'Text cache read' : '文本缓存读取',
            image_input: en ? 'Image input' : '图片输入',
            image_cache_read: en ? 'Image cache read' : '图片缓存读取',
        };
        return [
            ...Object.entries(details.rates).flatMap(([key, value]) =>
                value === null
                    ? []
                    : [
                          `${labels[key as keyof typeof labels]} ¥${formatTieredPrice(value)} / ${en ? 'million tokens' : '百万 token'}`,
                      ],
            ),
            ...(details.scheduled_discount ? catalogScheduledDiscountLines(details.scheduled_discount, en) : []),
        ];
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
    if (details.scheduled_discount) lines.push(...catalogScheduledDiscountLines(details.scheduled_discount, en));
    return lines;
}
