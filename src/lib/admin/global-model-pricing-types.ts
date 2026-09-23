import { z } from 'zod';

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
    })
    .strict()
    .superRefine((value, ctx) => {
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
