import { z } from 'zod';

/**
 * Immutable quote captured from the official reference catalog at preview
 * time.  The USD values and the converted CNY values are both retained so a
 * queued publication can be audited without re-fetching LiteLLM or reading a
 * later exchange-rate environment value.
 */
export interface OfficialPriceQuoteSnapshot {
    upstream_model: string;
    provider: string | null;
    source: string;
    source_label: string;
    fetched_at: string;
    input_usd_per_1m: number;
    output_usd_per_1m: number;
    cache_read_usd_per_1m: number | null;
    cache_write_5m_usd_per_1m: number | null;
    cache_write_1h_usd_per_1m: number | null;
    usd_to_cny_rate: number;
    input_cny_per_1m: number;
    output_cny_per_1m: number;
    cache_read_cny_per_1m: number | null;
    cache_write_5m_cny_per_1m: number | null;
    cache_write_1h_cny_per_1m: number | null;
}

/** Backwards-compatible local name used by the global pricing input. */
export type GlobalModelOfficialQuote = OfficialPriceQuoteSnapshot;

const quoteAmount = z.number().finite().nonnegative().max(99_999_999.999999);
const quotePositive = z.number().finite().positive().max(99_999_999.999999);

export const officialPriceQuoteSnapshotSchema = z
    .object({
        upstream_model: z.string().trim().min(1).max(200),
        provider: z.string().trim().max(120).nullable(),
        source: z.string().trim().min(1).max(120),
        source_label: z.string().trim().min(1).max(200),
        fetched_at: z.string().datetime({ offset: true }),
        input_usd_per_1m: quotePositive,
        output_usd_per_1m: quotePositive,
        cache_read_usd_per_1m: quoteAmount.nullable(),
        cache_write_5m_usd_per_1m: quoteAmount.nullable(),
        cache_write_1h_usd_per_1m: quoteAmount.nullable(),
        usd_to_cny_rate: quotePositive,
        input_cny_per_1m: quotePositive,
        output_cny_per_1m: quotePositive,
        cache_read_cny_per_1m: quoteAmount.nullable(),
        cache_write_5m_cny_per_1m: quoteAmount.nullable(),
        cache_write_1h_cny_per_1m: quoteAmount.nullable(),
    })
    .strict()
    .superRefine((quote, ctx) => {
        const pairs: Array<[usd: number | null, cny: number | null, label: string]> = [
            [quote.input_usd_per_1m, quote.input_cny_per_1m, '输入'],
            [quote.output_usd_per_1m, quote.output_cny_per_1m, '输出'],
            [quote.cache_read_usd_per_1m, quote.cache_read_cny_per_1m, '缓存读取'],
            [quote.cache_write_5m_usd_per_1m, quote.cache_write_5m_cny_per_1m, '缓存写入'],
            [quote.cache_write_1h_usd_per_1m, quote.cache_write_1h_cny_per_1m, '缓存写入/1小时'],
        ];
        for (const [usd, cny, label] of pairs) {
            if (usd === null || cny === null) {
                if (usd !== cny)
                    ctx.addIssue({
                        code: 'custom',
                        path: [label],
                        message: `${label} USD/CNY 报价必须同时存在或同时为空。`,
                    });
                continue;
            }
            const expected = usd * quote.usd_to_cny_rate;
            // Keep enough precision for cache rates while allowing JSON decimal
            // normalization from a client round trip.
            if (Math.abs(expected - cny) > Math.max(1e-10, Math.abs(expected) * 1e-10))
                ctx.addIssue({ code: 'custom', path: [label], message: `${label} CNY 换算结果与汇率快照不一致。` });
        }
    });

export const globalModelOfficialQuoteSchema = officialPriceQuoteSnapshotSchema;

const baseAmount = z
    .number()
    .finite()
    .nonnegative()
    .max(99_999_999.9999)
    .refine((value) => Math.abs(value - Number(value.toFixed(4))) < 1e-9, '最多四位小数');

const baseCacheAmount = z
    .number()
    .finite()
    .nonnegative()
    .max(99_999_999.9999)
    .refine((value) => value === Number(value.toFixed(12)), '缓存价最多十二位小数');

/** Official model price at GroupRatio = 1. It is independent of any Portal tier. */
export interface GlobalModelBaseInput {
    model_id: string;
    base_input_cny_per_1m: number | null;
    base_output_cny_per_1m: number | null;
    base_per_image_cny: number | null;
    base_cache_read_cny_per_1m?: number;
    base_cache_write_cny_per_1m?: number;
    base_cache_write_1h_cny_per_1m?: number;
    /** Set for the query-backed official-price workflow; omitted by legacy manual input. */
    official_quote?: GlobalModelOfficialQuote;
}

export const globalModelBaseInputSchema = z
    .object({
        model_id: z.string().uuid(),
        base_input_cny_per_1m: baseAmount.nullable().default(null),
        base_output_cny_per_1m: baseAmount.nullable().default(null),
        base_per_image_cny: baseAmount.nullable().default(null),
        base_cache_read_cny_per_1m: baseCacheAmount.optional(),
        base_cache_write_cny_per_1m: baseCacheAmount.optional(),
        base_cache_write_1h_cny_per_1m: baseCacheAmount.optional(),
        official_quote: globalModelOfficialQuoteSchema.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
        if (value.official_quote) {
            if (
                value.base_input_cny_per_1m !== null ||
                value.base_output_cny_per_1m !== null ||
                value.base_per_image_cny !== null ||
                value.base_cache_read_cny_per_1m !== undefined ||
                value.base_cache_write_cny_per_1m !== undefined ||
                value.base_cache_write_1h_cny_per_1m !== undefined
            ) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['official_quote'],
                    message: '官方查询报价不能与手填基础价混用。',
                });
            }
            return;
        }
        const token = value.base_input_cny_per_1m !== null || value.base_output_cny_per_1m !== null;
        const request = value.base_per_image_cny !== null;
        if (
            token === request ||
            (token && (value.base_input_cny_per_1m === null || value.base_output_cny_per_1m === null))
        )
            ctx.addIssue({ code: 'custom', message: '请输入完整的官方输入/输出基础价，或单独填写按次基础价。' });
        if (
            request &&
            (value.base_cache_read_cny_per_1m !== undefined ||
                value.base_cache_write_cny_per_1m !== undefined ||
                value.base_cache_write_1h_cny_per_1m !== undefined)
        )
            ctx.addIssue({ code: 'custom', message: '按次模型不能填写缓存基础价。' });
    });

export interface GlobalModelPriceInfo {
    id: string;
    slug: string;
    display_name: string;
    modality: string;
    upstream_model: string;
    billing_mode: 'standard' | 'tiered_expr' | 'request';
    base_input_cny_per_1m: number | null;
    base_output_cny_per_1m: number | null;
    base_per_image_cny: number | null;
    base_cache_read_cny_per_1m: number | null;
    base_cache_write_cny_per_1m: number | null;
    base_cache_write_1h_cny_per_1m: number | null;
}
