/**
 * gpt-image 响应 `background` 按【返回图实际像素】回显 —— portal 代理与 2.5 适配器共用。
 *
 * 2026-11-02 客户反馈:2.5 flare / sunburst 的 edits 响应声明 `background: "opaque"`,返回的 PNG 却约 1/3
 * 像素 alpha=0。此前两层都按【请求值】回显(缺省补 opaque),只有请求 transparent 才校验 alpha。
 * 现在:
 *  - 请求显式 `opaque` 而图里有透明像素 → 白底压平,兑现 opaque 契约(重编码会丢图内元数据,含 C2PA);
 *  - 请求 auto / 缺省 → 如实回显(有透明像素就是 transparent);
 *  - 请求 transparent → 不动(透明校验在适配器做)。
 * 全部「失败回退原图、永不抛」。
 */
import { loadSharp, sniffImageBytes } from './transcode';

export type OutputBackground = 'opaque' | 'transparent';

/** PNG 在第一个 IDAT 之前有没有 tRNS 块(调色板 / 灰度 / RGB 图的透明声明)。 */
function pngHasTrns(buf: Buffer): boolean {
    let off = 8;
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        if (type === 'tRNS') return true;
        if (type === 'IDAT' || type === 'IEND') return false;
        off += 12 + len;
    }
    return false;
}

/** 图里有没有不完全不透明(alpha<255)的像素。读不出 → null。
 *  快路:JPEG / 无 alpha 通道且无 tRNS 的 PNG 不解码(绝大多数 opaque 出图是 RGB PNG);只有带 alpha 的才全图统计。 */
export async function hasTransparentPixels(buf: Buffer): Promise<boolean | null> {
    const fmt = sniffImageBytes(buf);
    if (fmt === 'jpeg') return false;
    if (fmt === 'png') {
        if (buf.length < 26 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
        const colorType = buf[25];
        if (colorType !== 4 && colorType !== 6 && !pngHasTrns(buf)) return false;
    } else if (fmt !== 'webp') {
        return null;
    }
    try {
        const sharp = await loadSharp();
        if (!sharp) return null;
        if (fmt === 'webp' && !(await sharp(buf).metadata()).hasAlpha) return false;
        return !(await sharp(buf).stats()).isOpaque;
    } catch (e) {
        console.warn('[image-opacity] alpha scan failed:', e instanceof Error ? e.message : e);
        return null;
    }
}

/** 白底压平去 alpha,保持原格式(png / webp);失败 → null。 */
export async function flattenToOpaque(buf: Buffer): Promise<Buffer | null> {
    try {
        const sharp = await loadSharp();
        if (!sharp) return null;
        const pipe = sharp(buf).flatten({ background: '#ffffff' });
        return sniffImageBytes(buf) === 'webp'
            ? await pipe.webp({ quality: 95 }).toBuffer()
            : await pipe.png().toBuffer();
    } catch (e) {
        console.warn('[image-opacity] flatten failed:', e instanceof Error ? e.message : e);
        return null;
    }
}

/** 一张出图 + 请求 background → 交付的图 + 该回显的 background。 */
export async function resolveOutputBackground(
    b64: string,
    requested: string,
): Promise<{ b64: string; background: OutputBackground }> {
    const want = requested.trim().toLowerCase();
    if (want === 'transparent') return { b64, background: 'transparent' };
    const buf = Buffer.from(b64, 'base64');
    // 动图不走像素判定:sharp 只读首帧,压平会把 GIF 变成单帧静图。
    if (buf.toString('latin1', 0, 4) === 'GIF8') return { b64, background: 'opaque' };
    if ((await hasTransparentPixels(buf)) !== true) return { b64, background: 'opaque' };
    if (want === 'opaque') {
        const flat = await flattenToOpaque(buf);
        if (flat) {
            console.warn('[image-opacity] opaque requested but output had transparent pixels → flattened');
            return { b64: flat.toString('base64'), background: 'opaque' };
        }
    }
    return { b64, background: 'transparent' };
}
