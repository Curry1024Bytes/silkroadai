/**
 * 参考图入上游前的格式归一(2026-10-09,智象未来 seedance-2-5 conformance 报告 A12-FMT-BMP / A12-FMT-HEIF)。
 *
 * 两个「官方声明支持、上游实际拒收」的格式,平台在转存 R2 前就把字节修到上游认得的形态:
 *
 *  1. BMP —— 上游用 ImageMagick 识别格式:40 字节 BITMAPINFOHEADER(市面绝大多数 .bmp)识别名是 `BMP3`
 *     (本机 `magick identify -format %m` 复现),而上游白名单按字面比 `bmp` →
 *     `Unsupported image format: bmp3. Allowed formats: jpeg, png, webp, gif, tiff, bmp, heic, heif`(自相矛盾)。
 *     修:dep-free 解 BMP 像素 → sharp 编 PNG。sharp 预编译 libvips 不带 BMP loader(实测
 *     `Input buffer contains unsupported image format`),所以像素自己解,只借 sharp 编码。
 *
 *  2. HEIF —— ftyp `major_brand` 不是已注册品牌(报告 fixture 是把 heic 的 brand 字节改成字面 `heif`;
 *     libheif 对这种文件 `MIME type: unknown`,上游随即 `Unsupported media format. get image info`),
 *     但 `compatible_brands` 里明确列了 heic / heix / mif1 ……
 *     修:把 major_brand 改写成 compatible_brands 里第一个已注册的 HEIF 品牌 —— 文件本就声明兼容该品牌,
 *     ISOBMFF 允许 major_brand 取任一兼容品牌,像素一字不动。sharp 预编译不带 HEVC 解码
 *     (`Support for this compression format has not been built in`),无法转 PNG,只能改头。
 *
 * 全部按字节嗅探(不信 data URL / Content-Type 自报的 mime);认不出 / 解不了 → 原样返回,永不抛。
 */
import { loadSharp } from './transcode';

export type ReferenceNormalization = 'bmp->png' | 'heif-brand' | null;

export interface NormalizedReference {
    buf: Buffer;
    mime: string;
    /** 做了哪种改写;null = 原样(含「只校正 mime 字符串」的情况)。 */
    changed: ReferenceNormalization;
}

// ── BMP ─────────────────────────────────────────────────────────────────────

/** 像素上限(50M px ≈ 200MB RGBA),防恶意头部把进程撑爆;超过 → 不转,交上游自己拒。 */
const BMP_MAX_PIXELS = 50_000_000;
const BMP_MAX_SIDE = 16_384;

export interface DecodedBmp {
    width: number;
    height: number;
    channels: 3 | 4;
    /** 自顶向下、交错 RGB(A) 字节。 */
    data: Buffer;
}

export function isBmp(buf: Buffer): boolean {
    return buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d;
}

/** 位掩码 → 8-bit 通道值(掩码 0 → 0)。 */
function maskExtract(v: number, m: number): number {
    if (!m) return 0;
    let shift = 0;
    while (((m >>> shift) & 1) === 0 && shift < 32) shift++;
    let bits = 0;
    for (let i = shift; i < 32 && ((m >>> i) & 1) === 1; i++) bits++;
    const val = (v & m) >>> shift;
    if (bits >= 8) return val >>> (bits - 8);
    return Math.round((val * 255) / ((1 << bits) - 1));
}

/**
 * dep-free BMP 解码:BITMAPCOREHEADER(12)/ BITMAPINFOHEADER(40)/ V2-V5(52/56/108/124);
 * 1/4/8-bit 调色板、16/24/32-bit BI_RGB、16/32-bit BI_BITFIELDS / BI_ALPHABITFIELDS;自顶向下负高。
 * RLE 压缩 / 嵌入 JPEG-PNG / 头部越界 / 像素越界 → null(不猜,交上游)。
 */
export function decodeBmp(buf: Buffer): DecodedBmp | null {
    if (!isBmp(buf)) return null;
    const offBits = buf.readUInt32LE(10);
    const dib = buf.readUInt32LE(14);
    let width: number;
    let heightRaw: number;
    let bpp: number;
    let compression = 0;
    let clrUsed = 0;
    let paletteEntry: 3 | 4;
    if (dib === 12) {
        width = buf.readUInt16LE(18);
        heightRaw = buf.readInt16LE(20);
        bpp = buf.readUInt16LE(24);
        paletteEntry = 3;
    } else if (dib >= 40 && buf.length >= 14 + 40) {
        width = buf.readInt32LE(18);
        heightRaw = buf.readInt32LE(22);
        bpp = buf.readUInt16LE(28);
        compression = buf.readUInt32LE(30);
        clrUsed = buf.readUInt32LE(46);
        paletteEntry = 4;
    } else {
        return null;
    }
    if (14 + dib > buf.length) return null;
    const topDown = heightRaw < 0;
    const height = Math.abs(heightRaw);
    if (width <= 0 || height <= 0 || width > BMP_MAX_SIDE || height > BMP_MAX_SIDE) return null;
    if (width * height > BMP_MAX_PIXELS) return null;
    if (![1, 4, 8, 16, 24, 32].includes(bpp)) return null;
    // 0 = BI_RGB;3 = BI_BITFIELDS;6 = BI_ALPHABITFIELDS。1/2(RLE)、4/5(嵌入 JPEG/PNG)不解。
    if (compression !== 0 && compression !== 3 && compression !== 6) return null;
    if ((compression === 3 || compression === 6) && bpp !== 16 && bpp !== 32) return null;

    // 位掩码:V2+ 头内置于 offset 54(R/G/B)+ 66(A,V3+);40 字节头 + BITFIELDS 时紧跟头部。
    let rMask = 0;
    let gMask = 0;
    let bMask = 0;
    let aMask = 0;
    if (compression === 3 || compression === 6) {
        const maskOff = 54; // 两种布局下掩码都从 54 开始(14 + 40)
        const nMasks = compression === 6 || dib >= 56 ? 4 : 3;
        if (maskOff + nMasks * 4 > buf.length) return null;
        rMask = buf.readUInt32LE(maskOff);
        gMask = buf.readUInt32LE(maskOff + 4);
        bMask = buf.readUInt32LE(maskOff + 8);
        aMask = nMasks === 4 ? buf.readUInt32LE(maskOff + 12) : 0;
    }
    if (!rMask && !gMask && !bMask) {
        if (bpp === 16) {
            rMask = 0x7c00;
            gMask = 0x03e0;
            bMask = 0x001f;
        } else if (bpp === 32) {
            rMask = 0x00ff0000;
            gMask = 0x0000ff00;
            bMask = 0x000000ff;
        }
    }

    // 调色板
    let palette: Buffer | null = null;
    if (bpp <= 8) {
        const count = clrUsed > 0 ? clrUsed : 1 << bpp;
        if (count > 256) return null;
        let palOff = 14 + dib;
        if (dib === 40 && compression === 3) palOff += 12;
        if (palOff + count * paletteEntry > buf.length) return null;
        palette = buf.subarray(palOff, palOff + count * paletteEntry);
    }

    const stride = Math.floor((bpp * width + 31) / 32) * 4;
    if (offBits < 14 + dib || offBits + stride * height > buf.length) return null;

    const channels: 3 | 4 = aMask ? 4 : 3;
    const out = Buffer.alloc(width * height * channels);
    let o = 0;
    for (let y = 0; y < height; y++) {
        const srcRow = topDown ? y : height - 1 - y;
        const row = offBits + srcRow * stride;
        for (let x = 0; x < width; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 255;
            if (palette) {
                let idx: number;
                if (bpp === 8) idx = buf[row + x];
                else if (bpp === 4) idx = (buf[row + (x >> 1)] >> (x & 1 ? 0 : 4)) & 0x0f;
                else idx = (buf[row + (x >> 3)] >> (7 - (x & 7))) & 0x01;
                const p = Math.min(idx, palette.length / paletteEntry - 1) * paletteEntry;
                b = palette[p];
                g = palette[p + 1];
                r = palette[p + 2];
            } else if (bpp === 24) {
                const p = row + x * 3;
                b = buf[p];
                g = buf[p + 1];
                r = buf[p + 2];
            } else {
                const v = bpp === 16 ? buf.readUInt16LE(row + x * 2) : buf.readUInt32LE(row + x * 4);
                r = maskExtract(v, rMask);
                g = maskExtract(v, gMask);
                b = maskExtract(v, bMask);
                if (aMask) a = maskExtract(v, aMask);
            }
            out[o++] = r;
            out[o++] = g;
            out[o++] = b;
            if (channels === 4) out[o++] = a;
        }
    }
    return { width, height, channels, data: out };
}

/** BMP 字节 → PNG 字节;解不了 / sharp 不可用 → null。 */
export async function bmpToPng(buf: Buffer): Promise<{ png: Buffer; width: number; height: number } | null> {
    const dec = decodeBmp(buf);
    if (!dec) return null;
    const sharp = await loadSharp();
    if (!sharp) return null;
    const png = await sharp(dec.data, {
        raw: { width: dec.width, height: dec.height, channels: dec.channels },
    })
        .png()
        .toBuffer();
    return { png, width: dec.width, height: dec.height };
}

// ── HEIF ────────────────────────────────────────────────────────────────────

/** 已注册的 HEIF 静态图品牌,按「上游 / libheif 最稳妥认得」的顺序择一回写。 */
const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'] as const;
const HEIC_FAMILY = new Set<string>(['heic', 'heix', 'hevc', 'hevx']);
const FTYP_MAX_SIZE = 4096;

export interface HeifBrandInfo {
    major: string;
    compatible: string[];
}

/** 读 ISOBMFF ftyp 盒;不是 ftyp 开头 / 盒子异常 → null。 */
export function readFtyp(buf: Buffer): HeifBrandInfo | null {
    if (buf.length < 16 || buf.toString('latin1', 4, 8) !== 'ftyp') return null;
    const size = buf.readUInt32BE(0);
    if (size < 16 || size > buf.length || size > FTYP_MAX_SIZE) return null;
    const compatible: string[] = [];
    for (let off = 16; off + 4 <= size; off += 4) compatible.push(buf.toString('latin1', off, off + 4));
    return { major: buf.toString('latin1', 8, 12), compatible };
}

function heifMime(brand: string): string {
    return HEIC_FAMILY.has(brand) ? 'image/heic' : 'image/heif';
}

/**
 * major_brand 未注册但 compatible_brands 含已注册 HEIF 品牌 → 回写 major_brand(拷贝,不改入参)。
 * 返回 null = 不是 HEIF 家族文件(含 mp4/mov 视频:它们的 compatible 不含上面任何品牌)。
 */
export function normalizeHeifBrand(buf: Buffer): { buf: Buffer; mime: string; rewritten: string | null } | null {
    const ftyp = readFtyp(buf);
    if (!ftyp) return null;
    if ((HEIF_BRANDS as readonly string[]).includes(ftyp.major)) {
        return { buf, mime: heifMime(ftyp.major), rewritten: null };
    }
    const pick = HEIF_BRANDS.find((b) => ftyp.compatible.includes(b));
    if (!pick) return null;
    const out = Buffer.from(buf);
    out.write(pick, 8, 4, 'latin1');
    return { buf: out, mime: heifMime(pick), rewritten: pick };
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/**
 * 参考图字节归一。`mime` 是调用方手上的自报值(data URL 前缀 / 上游 Content-Type),只在嗅探不命中时原样带回。
 * 永不抛:任何异常 → 原样返回 + warn。
 */
export async function normalizeReferenceImage(buf: Buffer, mime: string): Promise<NormalizedReference> {
    try {
        if (isBmp(buf)) {
            const r = await bmpToPng(buf);
            if (r) {
                console.log('[ref-image-normalize] bmp→png', {
                    bytesIn: buf.length,
                    bytesOut: r.png.length,
                    w: r.width,
                    h: r.height,
                });
                return { buf: r.png, mime: 'image/png', changed: 'bmp->png' };
            }
            console.warn('[ref-image-normalize] bmp 解不了(RLE/越界/sharp 缺失),原样交上游', {
                bytes: buf.length,
            });
            return { buf, mime, changed: null };
        }
        const h = normalizeHeifBrand(buf);
        if (h) {
            if (h.rewritten) {
                console.log('[ref-image-normalize] heif major_brand 回写', {
                    from: readFtyp(buf)?.major,
                    to: h.rewritten,
                    mime: h.mime,
                });
                return { buf: h.buf, mime: h.mime, changed: 'heif-brand' };
            }
            return { buf, mime: h.mime, changed: null };
        }
    } catch (e) {
        console.warn('[ref-image-normalize] failed, keeping original:', e instanceof Error ? e.message : e);
    }
    return { buf, mime, changed: null };
}
