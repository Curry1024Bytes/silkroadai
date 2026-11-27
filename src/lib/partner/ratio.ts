import { z } from 'zod';

/** 倍率存 Decimal(12,6)：先按 6 位小数取整，再校验在 (0, 100] 内。 */
export const ratioSchema = z
    .number()
    .finite()
    .transform((value) => Math.round(value * 1e6) / 1e6)
    .refine((value) => value > 0 && value <= 100, { message: '倍率须大于 0 且不超过 100' });
