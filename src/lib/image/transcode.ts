/**
 * 出图转码 / 预览缩放(sharp,libvips native;Next 默认已把 sharp 列为 server external,Alpine 镜像用
 * @img/sharp-linuxmusl-x64 预编译包,lockfile 早已随 next 带着)。
 *
 * 2026-09-19 第 5 批:此前 jpeg 走 jimp(纯 JS,无 webp 编码器 → webp 请求只能交付 png 并诚实回显 png),
 * 官方 output_format=webp 真返 webp 字节。改用 sharp 后 jpeg / webp 都真交付;同时提供缩放预览给伪流式的
 * partial_image 事件。全部"失败回退原图、永不抛"。
 */
import type Sharp from 'sharp';

/** 惰性加载 sharp:native 二进制缺失(镜像/平台不匹配)时不能拖垮整个 route 模块 —— 加载失败只
 *  warn 一次,转码回退原图、预览回退完整图,请求照常成功。 */
let sharpPromise: Promise<typeof Sharp | null> | null = null;
function loadSharp(): Promise<typeof Sharp | null> {
    if (!sharpPromise) {
        sharpPromise = import('sharp')
            .then((m) => m.default)
            .catch((e: unknown) => {
                console.warn(
                    '[image-transcode] sharp unavailable, transcode/preview disabled:',
                    e instanceof Error ? e.message : e,
                );
                return null;
            });
    }
    return sharpPromise;
}

export type ImageFormat = 'png' | 'jpeg' | 'webp';
export type TranscodeTarget = 'jpeg' | 'webp';

/** 首字节魔数判格式;读不出 → ''。 */
export function sniffImageBytes(buf: Buffer): ImageFormat | '' {
    if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
    if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP')
        return 'webp';
    return '';
}

/** 客户 output_format 字符串 → 转码目标;png / 空 / 未知 → null(不转)。jpg 视为 jpeg。 */
export function transcodeTargetOf(outputFormat: string | undefined | null): TranscodeTarget | null {
    const s = (outputFormat ?? '').trim().toLowerCase();
    if (s === 'jpeg' || s === 'jpg') return 'jpeg';
    if (s === 'webp') return 'webp';
    return null;
}

/** OpenAI output_compression(0-100)→ 编码质量;缺省 / 非法 → 90;0 钳到 1。 */
export function encodeQuality(compression: number | string | undefined | null, fallback = 90): number {
    const c = typeof compression === 'number' ? compression : Number(String(compression ?? '').trim());
    if (Number.isFinite(c) && c >= 0 && c <= 100 && String(compression ?? '').trim() !== '')
        return Math.max(1, Math.round(c));
    return fallback;
}

/** base64 图 → 目标格式 base64。已经是目标格式 → 原样返回(避免代理层 + 适配器层双重重编码);
 *  失败 → 原样返回并 warn。重编码不保留 PNG 辅助块 / EXIF(C2PA 顺带丢弃)。 */
export async function transcodeB64(b64: string, target: TranscodeTarget, quality = 90): Promise<string> {
    try {
        const buf = Buffer.from(b64, 'base64');
        if (sniffImageBytes(buf) === target) return b64;
        const sharp = await loadSharp();
        if (!sharp) return b64;
        const out =
            target === 'jpeg'
                ? await sharp(buf).jpeg({ quality, mozjpeg: false }).toBuffer()
                : await sharp(buf).webp({ quality }).toBuffer();
        return out.toString('base64');
    } catch (e) {
        console.warn(`[image-transcode] →${target} failed, keeping original:`, e instanceof Error ? e.message : e);
        return b64;
    }
}

/** 按线性比例缩小(0 < scale < 1),编码成指定格式;失败 → null。给伪流式 partial_image 预览用。 */
export async function previewB64(
    b64: string,
    scale: number,
    format: ImageFormat,
    quality = 80,
): Promise<string | null> {
    try {
        const buf = Buffer.from(b64, 'base64');
        const sharp = await loadSharp();
        if (!sharp) return null;
        const meta = await sharp(buf).metadata();
        if (!meta.width || !meta.height) return null;
        const w = Math.max(16, Math.round(meta.width * scale));
        let pipe = sharp(buf).resize({ width: w });
        pipe = format === 'jpeg' ? pipe.jpeg({ quality }) : format === 'webp' ? pipe.webp({ quality }) : pipe.png();
        return (await pipe.toBuffer()).toString('base64');
    } catch (e) {
        console.warn('[image-transcode] preview failed:', e instanceof Error ? e.message : e);
        return null;
    }
}
