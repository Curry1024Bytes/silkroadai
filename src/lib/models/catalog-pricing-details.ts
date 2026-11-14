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
import { TIME_TOKEN_TIMEZONE } from '@/lib/admin/pricing-time-token-expression';

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

const timeRates = z
    .object({
        input: rate,
        output: rate,
        cache_read: rate.nullable(),
        cache_write: rate.nullable(),
        cache_write_1h: rate.nullable(),
        cache_write_12h: rate.nullable().optional(),
    })
    .strict();
const timeTier = z.object({ name: z.string().min(1).max(64), rates: timeRates }).strict();
const isoInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const timeWindow = z
    .object({
        weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
        start_hour: z.number().int().min(0).max(23),
        end_hour: z.number().int().min(1).max(24),
    })
    .strict()
    .refine((value) => value.start_hour < value.end_hour, { message: 'Empty hour window' })
    .refine((value) => new Set(value.weekdays).size === value.weekdays.length, { message: 'Duplicate weekdays' });

/**
 * Peak/off-peak token pricing read from a new-api time-conditioned expression. `window` is billed during
 * `schedule` (Asia/Shanghai, end hour exclusive), `otherwise` at every other hour; `exceptions` are date
 * ranges whose weekly schedule differs (e.g. a public holiday billed entirely as `otherwise`).
 */
const timeTokenSchema = z
    .object({
        version: z.literal(1),
        mode: z.literal('time_token'),
        unit: z.literal('cny_per_million_tokens'),
        timezone: z.literal(TIME_TOKEN_TIMEZONE),
        window: timeTier,
        otherwise: timeTier,
        schedule: z.array(timeWindow).max(168),
        exceptions: z
            .array(
                z
                    .object({ from: isoInstant.nullable(), until: isoInstant, schedule: z.array(timeWindow).max(168) })
                    .strict(),
            )
            .max(32),
        scheduled_discount: discount.optional(),
    })
    .strict();

export type MediaPricingDetails = z.infer<typeof mediaSchema>;
export type ComponentTokenPricingDetails = z.infer<typeof componentSchema>;
export type VideoTokenPricingDetails = z.infer<typeof videoTokenSchema>;
export type TimeTokenPricingDetails = z.infer<typeof timeTokenSchema>;
export type CatalogBillingDetails =
    | TieredPricingDetails
    | MediaPricingDetails
    | ComponentTokenPricingDetails
    | VideoTokenPricingDetails
    | TimeTokenPricingDetails;

const SEEDANCE_25_SLUG = 'doubao-seedance-2-5-260628';

/** Hide unsupported customer-facing price cells without changing stored billing metadata. */
export function sanitizeCatalogDisplayDetails(
    modelSlug: string,
    details: CatalogBillingDetails | null,
): CatalogBillingDetails | null {
    if (modelSlug !== SEEDANCE_25_SLUG || details?.mode !== 'video_token') return details;
    const cells = details.cells.filter((cell) => cell.resolution !== '4k');
    if (cells.length === details.cells.length) return details;
    return { ...details, cells };
}

/** Validate every mode before exposing it. Unknown non-null metadata never falls back to a scalar quote. */
export function parseCatalogBillingDetails(raw: unknown): CatalogBillingDetails | null {
    if (raw == null) return null;
    const mode = typeof raw === 'object' && 'mode' in raw ? raw.mode : null;
    if (mode === 'tiered_token') return parseTieredPricingDetails(raw);
    if (mode === 'media') return mediaSchema.parse(raw);
    if (mode === 'component_token') return componentSchema.parse(raw);
    if (mode === 'video_token') return videoTokenSchema.parse(raw);
    if (mode === 'time_token') return timeTokenSchema.parse(raw);
    throw new Error('Invalid catalog billing details');
}

/** The tier a one-line quote shows for peak/off-peak pricing: the dearer one, so a summary never undersells. */
export function timeTokenSummaryTier(details: TimeTokenPricingDetails): {
    rates: TimeTokenPricingDetails['window']['rates'];
    peak: boolean;
} {
    const windowIsPeak = details.window.rates.input >= details.otherwise.rates.input;
    return windowIsPeak ? { rates: details.window.rates, peak: true } : { rates: details.otherwise.rates, peak: false };
}

/** Rates that stand for a token-priced row in scalar columns (first length tier, or the dearer time tier). */
export function primaryTokenRates(details: CatalogBillingDetails | null) {
    if (details?.mode === 'tiered_token') return details.tiers[0].rates;
    if (details?.mode === 'time_token') return timeTokenSummaryTier(details).rates;
    return null;
}

/** The cell a one-line summary shows: 720p without reference video, else the first listed. */
export function videoTokenSummaryCell(details: VideoTokenPricingDetails): VideoTokenPricingDetails['cells'][number] {
    return details.cells.find((cell) => cell.resolution === '720p' && cell.video_input === 'none') ?? details.cells[0];
}

/** Human-readable notes for new-api request-rule multipliers retained on a catalog row. */
export function catalogRequestMultiplierLines(
    details: Pick<TieredPricingDetails, 'request_multipliers'>,
    en = false,
): string[] {
    return (details.request_multipliers ?? []).map((rule) =>
        en
            ? `When ${rule.path} = ${rule.equals}: ×${formatTieredPrice(rule.multiplier)}`
            : `当 ${rule.path} = ${rule.equals} 时：价格 ×${formatTieredPrice(rule.multiplier)}`,
    );
}

export function scaleCatalogBillingDetails(raw: CatalogBillingDetails, scale: number): CatalogBillingDetails {
    const details = parseCatalogBillingDetails(raw)!;
    if (details.mode === 'tiered_token') return scaleTieredPricingDetails(details, scale);
    if (details.mode === 'video_token') {
        for (const cell of details.cells) cell.price = scalePricingAmount(cell.price, scale);
        return details;
    }
    if (details.mode === 'time_token') {
        for (const tier of [details.window, details.otherwise])
            for (const key of Object.keys(tier.rates) as Array<keyof typeof tier.rates>) {
                const value = tier.rates[key];
                if (value != null) tier.rates[key] = scalePricingAmount(value, scale);
            }
        return details;
    }
    if (details.mode === 'component_token') {
        for (const key of Object.keys(details.rates) as Array<keyof typeof details.rates>) {
            const value = details.rates[key];
            if (value != null) details.rates[key] = scalePricingAmount(value, scale);
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

const WEEKDAY_NAMES = {
    zh: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
    en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
};

function weekdaysLabel(days: number[], en: boolean): string {
    const sorted = [...days].sort((a, b) => a - b);
    const names = WEEKDAY_NAMES[en ? 'en' : 'zh'];
    if (sorted.length === 7) return en ? 'Every day' : '每天';
    const contiguous = sorted.every((day, i) => i === 0 || day === sorted[i - 1] + 1);
    if (contiguous && sorted.length > 2)
        return `${names[sorted[0] - 1]}${en ? '–' : '至'}${names[sorted[sorted.length - 1] - 1]}`;
    return sorted.map((day) => names[day - 1]).join(en ? ', ' : '、');
}

const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

/** "周一至周五 09:00–12:00、14:00–18:00" — one entry per distinct weekday set, in schedule order. */
export function timeTokenScheduleLabel(schedule: TimeTokenPricingDetails['schedule'], en = false): string {
    const groups = new Map<string, { days: number[]; ranges: string[] }>();
    for (const window of schedule) {
        const key = [...window.weekdays].sort((a, b) => a - b).join(',');
        const group = groups.get(key) ?? { days: window.weekdays, ranges: [] };
        group.ranges.push(`${hourLabel(window.start_hour)}–${hourLabel(window.end_hour)}`);
        groups.set(key, group);
    }
    return [...groups.values()]
        .map((group) => `${weekdaysLabel(group.days, en)} ${group.ranges.join(en ? ', ' : '、')}`)
        .join(en ? '; ' : '；');
}

/** Beijing calendar date of an instant; an exclusive end at local midnight shows the last included day. */
function beijingDate(iso: string, exclusiveEnd: boolean): string {
    const at = new Date(Date.parse(iso) - (exclusiveEnd ? 1 : 0));
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_TOKEN_TIMEZONE }).format(at);
}

function exceptionLine(
    exception: TimeTokenPricingDetails['exceptions'][number],
    labels: { window: string; otherwise: string },
    en: boolean,
): string {
    const until = beijingDate(exception.until, true);
    const range = exception.from
        ? `${beijingDate(exception.from, false)}${en ? ' to ' : ' 至 '}${until}`
        : en
          ? `Through ${until}`
          : `${until} 及以前`;
    if (!exception.schedule.length)
        return en ? `${range}: billed at ${labels.otherwise} rates all day` : `${range}：全天按${labels.otherwise}计价`;
    return en
        ? `${range}: ${labels.window} ${timeTokenScheduleLabel(exception.schedule, true)}`
        : `${range}：${labels.window}为 ${timeTokenScheduleLabel(exception.schedule)}`;
}

function timeTokenLines(details: TimeTokenPricingDetails, en: boolean, now: number): string[] {
    const peakIsWindow = timeTokenSummaryTier(details).peak;
    const labels = {
        window: peakIsWindow ? (en ? 'Peak hours' : '高峰时段') : en ? 'Off-peak hours' : '优惠时段',
        otherwise: peakIsWindow ? (en ? 'Off-peak hours' : '非高峰时段') : en ? 'Other hours' : '其他时段',
    };
    const unit = en ? 'million tokens' : '百万 token';
    const rates = (r: TimeTokenPricingDetails['window']['rates']) =>
        [
            `${en ? 'Input' : '输入'} ¥${formatTieredPrice(r.input)}`,
            ...(r.cache_read === null ? [] : [`${en ? 'Cache read' : '缓存读取'} ¥${formatTieredPrice(r.cache_read)}`]),
            ...(r.cache_write === null
                ? []
                : [`${en ? 'Cache write' : '缓存写入'} ¥${formatTieredPrice(r.cache_write)}`]),
            ...(r.cache_write_1h === null
                ? []
                : [`${en ? 'Cache write / 1 hour' : '缓存写入 1 小时'} ¥${formatTieredPrice(r.cache_write_1h)}`]),
            ...(r.cache_write_12h == null
                ? []
                : [`${en ? 'Cache write / 12 hours' : '缓存写入 12 小时'} ¥${formatTieredPrice(r.cache_write_12h)}`]),
            `${en ? 'Output' : '输出'} ¥${formatTieredPrice(r.output)}`,
        ].join(en ? ', ' : '，');
    const schedule = details.schedule.length
        ? timeTokenScheduleLabel(details.schedule, en)
        : en
          ? 'none in the regular week'
          : '常规每周无此时段';
    return [
        en
            ? `${labels.window} (Beijing time, ${schedule}): ${rates(details.window.rates)} / ${unit}`
            : `${labels.window}（北京时间 ${schedule}）：${rates(details.window.rates)} / ${unit}`,
        en
            ? `${labels.otherwise}: ${rates(details.otherwise.rates)} / ${unit}`
            : `${labels.otherwise}：${rates(details.otherwise.rates)} / ${unit}`,
        // A date range that has already ended no longer changes any charge.
        ...details.exceptions
            .filter((exception) => Date.parse(exception.until) > now)
            .map((exception) => exceptionLine(exception, labels, en)),
        ...(details.scheduled_discount ? catalogScheduledDiscountLines(details.scheduled_discount, en) : []),
    ];
}

export function catalogDetailLines(
    details: Exclude<CatalogBillingDetails, TieredPricingDetails>,
    en = false,
    now = Date.now(),
): string[] {
    if (details.mode === 'time_token') return timeTokenLines(details, en, now);
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
