/**
 * gpt-image-2.6 GIF(官方 `output_format: "gif"`)的适配器规则,2026-11-06 对照官方文档 + 两家上游实测。
 *
 * 官方示例是 512×512,但两家上游都卡 gpt-image 的最低像素(655,360):we-token 直接 400,ztyunjuan 静默放大
 * (512×512 → 816×816、512×768 → 672×992)。所以低于下限的尺寸按同比放大发上游,收图后用 sharp 缩回客户要的尺寸。
 * size=auto / 缺省按官方示例取 512×512:ztyunjuan 的 auto 走 1024²,任何帧数都放不进拼图(`No supported sheet fits`)。
 *
 * 帧数 / 帧时长 / 压缩的规则与上游原文一致(ztyunjuan 透出的官方错误):frame_count 2-16、frame_duration_ms ≥ 20、
 * GIF 不收 output_compression。提前拦截省一次 25s 的上游往返。流式 GIF 官方不支持,在代理层拦(适配器看不到 stream)。
 * 改图出 GIF:两家上游带任一帧参数都出不了图(ztyunjuan 恒 503 `Unknown internal error`,we-token 408 限流 / 超时;
 * 2026-11-06 与 11-08 multipart / JSON 复测一致),不带才出图(9 帧 200ms)。官方改图端点支持这两个参数(11-07 官 key 实测),
 * 所以改图请求不把帧参数发上游,收图后本地改:frame_duration_ms 改写每帧时长(与官方一致);frame_count 2-9 从 9 帧里
 * 均匀抽帧(动作相同、节奏更粗;官方是直接生成 N 帧);10-16 上游给不出,400 说明上限,不复制帧凑数。
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
const GIF_DEFAULT_FRAME_COUNT = 9;
const GIF_DEFAULT_FRAME_DURATION_MS = 200;
/** 改图出 GIF 本地抽帧的上限 = 上游默认帧数。 */
export const EDITS_GIF_MAX_FRAME_COUNT = GIF_DEFAULT_FRAME_COUNT;

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
    if (extras.frame_count !== undefined) {
        const err = intError(extras.frame_count, 'frame_count');
        if (err) return err;
        const v = Number(extras.frame_count);
        if (v < MIN_FRAME_COUNT || v > MAX_FRAME_COUNT)
            return {
                detail: `Invalid 'frame_count' for GIF output. Received ${v}. Use an integer from ${MIN_FRAME_COUNT} to ${MAX_FRAME_COUNT}, or omit 'frame_count' to use ${GIF_DEFAULT_FRAME_COUNT}.`,
                param: 'frame_count',
                code: 'invalid_value',
            };
        if (isEdits && v > EDITS_GIF_MAX_FRAME_COUNT)
            return {
                detail: `Invalid 'frame_count' for GIF output from image edits. Received ${v}. Use an integer from ${MIN_FRAME_COUNT} to ${EDITS_GIF_MAX_FRAME_COUNT}, or omit 'frame_count' to use ${GIF_DEFAULT_FRAME_COUNT}.`,
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

/** 计费帧数按请求值,不传取默认 9;官方实际交付的帧数偶尔比请求多,不影响计费。 */
export function gifFrameCount(extras: Record<string, string>): number {
    return extras.frame_count === undefined ? GIF_DEFAULT_FRAME_COUNT : Number(extras.frame_count);
}

/** 官方把 GIF 帧排进一张拼图出图,按拼图尺寸计 token。2026-11-07 官 key 全帧数实测:2-8 帧 4×2、9 帧 3×3、
 *  10-12 帧 4×3、13-16 帧 4×4,行列方向取拼图更接近正方形的一种(768×512 的 2 帧是 1536×2048,不是 3072×1024)。 */
export function gifSheetDims(w: number, h: number, frames: number): { w: number; h: number } {
    const [a, b] = frames <= 8 ? [4, 2] : frames === 9 ? [3, 3] : frames <= 12 ? [4, 3] : [4, 4];
    const wide = { w: w * a, h: h * b };
    const tall = { w: w * b, h: h * a };
    const aspect = (d: { w: number; h: number }) => Math.max(d.w, d.h) / Math.min(d.w, d.h);
    return aspect(wide) <= aspect(tall) ? wide : tall;
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

export interface GifRetime {
    /** 目标帧数;null = 不抽帧。 */
    frames: number | null;
    /** 每帧毫秒;null = 官方默认 200。 */
    durationMs: number | null;
}

/** 改图出 GIF:帧参数从发上游的字段里拿掉(上游带了出不了图),交给 retimeGifB64 本地处理。没传帧参数 → retime 为 null。 */
export function takeEditsGifFrameParams(extras: Record<string, string>): {
    upstreamExtras: Record<string, string>;
    retime: GifRetime | null;
} {
    const fc = extras.frame_count;
    const fd = extras.frame_duration_ms;
    if (fc === undefined && fd === undefined) return { upstreamExtras: extras, retime: null };
    const upstreamExtras = { ...extras };
    for (const k of GIF_ONLY_EXTRAS) delete upstreamExtras[k];
    return {
        upstreamExtras,
        retime: { frames: fc === undefined ? null : Number(fc), durationMs: fd === undefined ? null : Number(fd) },
    };
}

/** 从 total 帧里均匀取 n 帧(按循环等分,不重复首尾):9 取 3 → 0、3、6。 */
export function pickFrameIndices(total: number, n: number): number[] {
    if (n >= total) return Array.from({ length: total }, (_, i) => i);
    return Array.from({ length: n }, (_, i) => Math.floor((i * total) / n));
}

/** 动图按 retime 抽帧 + 改每帧时长。不是动图 / sharp 不可用 / 失败 → 原样返回(打 warn),永不抛。 */
export async function retimeGifB64(b64: string, retime: GifRetime): Promise<string> {
    const buf = Buffer.from(b64, 'base64');
    if (!isGifBytes(buf)) return b64;
    const sharp = await loadSharp();
    if (!sharp) return b64;
    try {
        const meta = await sharp(buf, { animated: true }).metadata();
        const pages = meta.pages ?? 1;
        const w = meta.width ?? 0;
        const ph = meta.pageHeight ?? meta.height ?? 0;
        if (pages < 2 || !w || !ph) return b64;
        const idx = pickFrameIndices(pages, retime.frames ?? pages);
        const delay = retime.durationMs ?? GIF_DEFAULT_FRAME_DURATION_MS;
        // 合成后的整帧(处理掉 disposal / 局部矩形),再按选中的帧重编码
        const { data } = await sharp(buf, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const frameBytes = w * ph * 4;
        const frames = Buffer.concat(idx.map((i) => data.subarray(i * frameBytes, (i + 1) * frameBytes)));
        const out = await sharp(frames, { raw: { width: w, height: ph * idx.length, channels: 4, pageHeight: ph } })
            .gif({ delay: idx.map(() => delay), loop: meta.loop ?? 0 })
            .toBuffer();
        return out.toString('base64');
    } catch (e) {
        console.warn('[image-adapter25] gif retime failed', e instanceof Error ? e.message : e);
        return b64;
    }
}
