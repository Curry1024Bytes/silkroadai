/**
 * gpt-image /images/edits 的 `mask`(蒙版)入参校验 —— portal 代理与 2.5 适配器共用。
 *
 * 2026-11-02 客户(OAI image 大客户专属)官方兼容测试反馈:`mask: {}`、`mask: { file_id: 123 }`、
 * `mask: { image_url: "" }` 等非法蒙版一律 200 出图并计费 —— 解析层只认「非空字符串」引用,
 * 其余形态解不出引用就被当成「没传 mask」静默丢弃,上游整图重绘。官方对这些一律 400。
 * 尺寸与输入图不一致的蒙版上游会 400,但该文案不在适配器终态白名单 → failover → 客户看到 503
 * 「overloaded」。这里把形态 + 尺寸都前置成 400,不打上游、不扣费。
 */

export interface MaskShapeError {
    message: string;
    code: 'invalid_type' | 'invalid_value';
}

/** 官方类型错文案用的「got X」描述。 */
function describeType(v: unknown): string {
    if (Array.isArray(v)) return 'an array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'an integer' : 'a number';
    if (typeof v === 'boolean') return 'a boolean';
    if (typeof v === 'string') return 'a string';
    return 'an object';
}

const typeError = (field: string, expected: string, v: unknown): MaskShapeError => ({
    message: `Invalid type for '${field}': expected ${expected}, but got ${describeType(v)} instead.`,
    code: 'invalid_type',
});

/** 字符串引用字段:必须是非空字符串。 */
function stringRefError(field: string, v: unknown): MaskShapeError | null {
    if (typeof v !== 'string') return typeError(field, 'a string', v);
    if (!v.trim()) return { message: `Invalid '${field}': expected a non-empty string.`, code: 'invalid_value' };
    return null;
}

const isSet = (v: unknown) => v !== undefined && v !== null;

/** JSON body 的 `mask` 字段形态 → 错误或 null(合法 / 未传)。
 *  合法:官方 `{ image_url }` / `{ file_id }`(恰好一个,非空字符串);兼容自家扩展的 URL / data URL 字符串、
 *  chat 风格 `{ image_url: { url } }` 与 `{ url }`。`undefined` / `null` / 空串 = 没传。 */
export function jsonMaskShapeError(mask: unknown): MaskShapeError | null {
    if (mask === undefined || mask === null) return null;
    if (typeof mask === 'string') return null; // 自家扩展:URL / data URL 字符串(空串 = 没传)
    if (typeof mask !== 'object' || Array.isArray(mask)) return typeError('mask', 'an object', mask);
    const o = mask as Record<string, unknown>;
    const present = ['image_url', 'file_id', 'url'].filter((k) => isSet(o[k]));
    if (present.length !== 1)
        return { message: "Invalid 'mask': provide exactly one of image_url or file_id.", code: 'invalid_value' };
    const key = present[0];
    const v = o[key];
    if (key === 'image_url' && v && typeof v === 'object' && !Array.isArray(v))
        return stringRefError('mask.image_url.url', (v as Record<string, unknown>).url); // chat 风格兼容
    return stringRefError(`mask.${key}`, v);
}

/** multipart 的 `mask` 部件 → 错误或 null。必须是非空文件;空字符串 = 没传(表单库常发空字段)。 */
export function multipartMaskShapeError(v: unknown): MaskShapeError | null {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v.trim() ? typeError('mask', 'a file', v) : null;
    if (v instanceof Blob && v.size === 0) return { message: "Invalid 'mask': file is empty.", code: 'invalid_value' };
    return null;
}

type Dims = { w: number; h: number } | null;

/** 蒙版与(第一张)输入图尺寸必须一致(官方约束,上游也会拒)。任一尺寸读不出 → 不判(交上游)。 */
export function maskDimensionError(mask: Dims, image: Dims): string | null {
    if (!mask || !image) return null;
    if (mask.w === image.w && mask.h === image.h) return null;
    return `Invalid mask image: mask must have the same dimensions as the image (${image.w}x${image.h}), got ${mask.w}x${mask.h}.`;
}
