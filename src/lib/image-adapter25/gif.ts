/**
 * gpt-image-2.6 GIF(官方 `output_format: "gif"`)的适配器规则,2026-11-06 对照官方文档 + 两家上游实测。
 *
 * 官方示例是 512×512,但两家上游都卡 gpt-image 的最低像素(655,360):we-token 直接 400,ztyunjuan 静默放大
 * (512×512 → 816×816、512×768 → 672×992)。所以低于下限的尺寸按同比放大发上游,收图后用 sharp 缩回客户要的尺寸。
 * size=auto / 缺省按官方示例取 512×512:ztyunjuan 的 auto 走 1024²,任何帧数都放不进拼图(`No supported sheet fits`)。
 *
 * 帧数 / 帧时长 / 压缩的规则与上游原文一致(ztyunjuan 透出的官方错误):frame_count 2-16、frame_duration_ms ≥ 20、
 * GIF 不收 output_compression。提前拦截省一次 25s 的上游往返。流式 GIF 官方不支持,在代理层拦(适配器看不到 stream)。
 * 改图出 GIF 只能用默认帧参数:ztyunjuan 带任一帧参数恒回 503 `Unknown internal error`(multipart / JSON 各 2-9 帧实测),不带才出图。
 */
import { loadSharp } from '@/lib/image/transcode';

const GPT_IMAGE_MIN_PIXELS = 655_360;
const SIZE_STEP = 16;
const MIN_FRAME_COUNT = 2;
const MAX_FRAME_COUNT = 16;
const MIN_FRAME_DURATION_MS = 20;
const COMPLEXITY_VALUES = ['low', 'medium', 'high'];

/** 只对 2.6 透传的字段:其余上游不认,留着可能被拒。 */
export const GPT_IMAGE_26_EXTRAS = ['frame_count', 'frame_duration_ms', 'complexity'] as const;
const GIF_ONLY_EXTRAS = ['frame_count', 'frame_duration_ms'] as const;

export const GIF_DEFAULT_DIMS = { w: 512, h: 512 };

export interface Gpt26ParamError {
    detail: string;
    param: string;
    code: string;
}

function isGifBytes(buf: Buffer): boolean {
    return buf.length >= 10 && buf.toString('latin1', 0, 4) === 'GIF8';
}

/** GIF 逻辑屏尺寸(文件头 6-9 字节,小端),不是 GIF → null。 */
export function gifDimensions(buf: Buffer): { w: number; h: number } | null {
    if (!isGifBytes(buf)) return null;
    const w = buf.readUInt16LE(6);
    const h = buf.readUInt16LE(8);
    return w > 0 && h > 0 ? { w, h } : null;
}

export function requestedOutputFormat(extras: Record<string, string>): string {
    return (extras.output_format ?? '').trim().toLowerCase();
}

/** 只留 2.6 / GIF 该有的字段:非 2.6 模型全删,非 GIF 请求删帧参数。 */
export function pruneGpt26Extras(extras: Record<string, string>, isGpt26: boolean): Record<string, string> {
    const out = { ...extras };
    const drop = isGpt26 ? (requestedOutputFormat(extras) === 'gif' ? [] : GIF_ONLY_EXTRAS) : GPT_IMAGE_26_EXTRAS;
    for (const k of drop) delete out[k];
    return out;
}

function intError(raw: string, param: string): Gpt26ParamError | null {
    if (/^\d+$/.test(raw.trim())) return null;
    return {
        detail: `Invalid type for '${param}': expected an integer.`,
        param,
        code: 'invalid_type',
    };
}

/** 2.6 入参校验,都是换渠道也过不去的确定性错误。适配器这两家上游出不了 svg,立即拒,不空跑 failover
 *  (官 key 分组不走适配器,SVG 可用)。 */
export function gpt26ParamError(
    extras: Record<string, string>,
    hasMask: boolean,
    isEdits = false,
): Gpt26ParamError | null {
    const format = requestedOutputFormat(extras);
    if (format === 'svg')
        return {
            detail: "Invalid value: 'svg'. Supported values are: 'png', 'jpeg', 'webp', and 'gif'.",
            param: 'output_format',
            code: 'invalid_value',
        };
    const complexity = (extras.complexity ?? '').trim().toLowerCase();
    if (complexity && !COMPLEXITY_VALUES.includes(complexity))
        return {
            detail: `Invalid value: '${extras.complexity}'. Supported values are: 'low', 'medium', and 'high'.`,
            param: 'complexity',
            code: 'invalid_value',
        };
    if (format !== 'gif') return null;
    if (isEdits) {
        const param = GIF_ONLY_EXTRAS.find((k) => extras[k] !== undefined);
        if (param)
            return {
                detail: `'${param}' is not supported for GIF output from image edits.`,
                param,
                code: 'invalid_value',
            };
    }
    if (extras.frame_count !== undefined) {
        const err = intError(extras.frame_count, 'frame_count');
        if (err) return err;
        const v = Number(extras.frame_count);
        if (v < MIN_FRAME_COUNT || v > MAX_FRAME_COUNT)
            return {
                detail: `Invalid 'frame_count' for GIF output. Received ${v}. Use an integer from ${MIN_FRAME_COUNT} to ${MAX_FRAME_COUNT}, or omit 'frame_count' to use 9.`,
                param: 'frame_count',
                code: 'invalid_value',
            };
    }
    if (extras.frame_duration_ms !== undefined) {
        const err = intError(extras.frame_duration_ms, 'frame_duration_ms');
        if (err) return err;
        const v = Number(extras.frame_duration_ms);
        if (v < MIN_FRAME_DURATION_MS)
            return {
                detail: `Invalid 'frame_duration_ms': integer below minimum value. Expected a value >= ${MIN_FRAME_DURATION_MS}, but got ${v} instead.`,
                param: 'frame_duration_ms',
                code: 'integer_below_min_value',
            };
    }
    if (extras.output_compression !== undefined)
        return {
            detail: "'output_compression' is not supported for GIF output.",
            param: 'output_compression',
            code: 'invalid_value',
        };
    if ((extras.background ?? '').trim().toLowerCase() === 'transparent')
        return {
            detail: "Transparent background requires output_format 'png' or 'webp'.",
            param: 'background',
            code: 'invalid_value',
        };
    if (hasMask) return { detail: 'Masks are not supported for GIF output.', param: 'mask', code: 'invalid_value' };
    return null;
}

/** 发给上游的尺寸:不低于最低像素的原样;低于的同比放大并对齐 16 倍数(与 ztyunjuan 的放大结果一致)。 */
export function gifUpstreamDims(target: { w: number; h: number }): { w: number; h: number } {
    if (target.w * target.h >= GPT_IMAGE_MIN_PIXELS) return target;
    const scale = Math.sqrt(GPT_IMAGE_MIN_PIXELS / (target.w * target.h));
    let w = Math.ceil((target.w * scale) / SIZE_STEP) * SIZE_STEP;
    let h = Math.ceil((target.h * scale) / SIZE_STEP) * SIZE_STEP;
    while (w * h < GPT_IMAGE_MIN_PIXELS) {
        if (w <= h) w += SIZE_STEP;
        else h += SIZE_STEP;
    }
    return { w, h };
}

/** 动图缩到目标尺寸,保留帧数和帧时长。已是目标尺寸 / 不是 GIF → 原样;失败回退原图(按实际尺寸计费),永不抛。 */
export async function resizeGifB64(b64: string, target: { w: number; h: number }): Promise<string> {
    const buf = Buffer.from(b64, 'base64');
    const dims = gifDimensions(buf);
    if (!dims || (dims.w === target.w && dims.h === target.h)) return b64;
    const sharp = await loadSharp();
    if (!sharp) return b64;
    try {
        const out = await sharp(buf, { animated: true }).resize(target.w, target.h, { fit: 'fill' }).gif().toBuffer();
        return out.toString('base64');
    } catch (e) {
        console.warn('[image-adapter25] gif resize failed', e instanceof Error ? e.message : e);
        return b64;
    }
}
