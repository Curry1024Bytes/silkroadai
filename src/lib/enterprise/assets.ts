/**
 * P3 素材库核心(门户自有存储,对标火山方舟契约)。
 *
 * operator 确认(2026-07-19):上游对直传 URL 全权限,素材归属与上游无关 ——
 * 素材字节存我们 R2(公网直链),隔离 = user_id 行级归属。本文件是两套对客
 * 表面的共享核心:① 火山形 Action API(/api?Action=…,sk-ent 鉴权)② dashboard
 * cookie 端点(/api/enterprise/assets*)。生成引用:resolveAssetRefs 把请求体里的
 * asset-…/group-… 换成 R2 URL(group 仅限数组字段,展开为成员 URL 序列)。
 */
import 'server-only';
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { uploadImage, deleteImage } from '@/lib/r2/client';

/** 配额(env 可调):素材数 / 总字节 / 单文件字节。 */
export function assetLimits() {
    return {
        // 2026-07-24 企业客户扩容(原 500/5GB/100MB 不够用;R2 存储便宜,先放宽,
        // 火山官方素材库政策对齐留 operator 调研后再定)
        maxAssets: Number(process.env.ENTERPRISE_MAX_ASSETS || 5000),
        maxTotalBytes: Number(process.env.ENTERPRISE_MAX_ASSET_BYTES || 200 * 1024 * 1024 * 1024),
        maxFileBytes: Number(process.env.ENTERPRISE_MAX_ASSET_FILE_BYTES || 500 * 1024 * 1024),
    };
}

export class AssetError extends Error {
    constructor(
        public code: string,
        message: string,
        public status: number = 400,
    ) {
        super(message);
        this.name = 'AssetError';
    }
}

const EXT_BY_MIME: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/tiff': 'tif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/mp4': 'm4a',
};

export type AssetType = 'image' | 'video' | 'audio';

// ── 火山官方媒体校验(2026-08-06;#331 首版 → 本次全量对齐官方规则表)──
// 官方规则(727 文档「媒体校验规则」):
//   图片 JPEG/PNG/WEBP/BMP/TIFF/GIF;<30MB;宽高比 (0.4,2.5);宽高均 (300,6000)px
//   视频 MP4/MOV;≤50MB;时长 [2,15]s;宽高比 [0.4,2.5];宽高均 [300,6000]px;
//        总像素 [409600,2086876];帧率 [24,60]FPS
//   音频 MP3/WAV;≤15MB;时长 [2,15]s
// 多条错误按官方语义用 \n 逐条列出(客户脚本按行解析)。单点挂在 storeAsset ——
// Action API 与控制台上传同享。解析不出的维度(如 MP3 时长)跳过,不误杀。

const IMAGE_MAX_BYTES = 30 * 1024 * 1024;
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const AUDIO_MAX_BYTES = 15 * 1024 * 1024;
const MIN_PX = 300;
const MAX_PX = 6000;
const MIN_RATIO = 0.4;
const MAX_RATIO = 2.5;
const MIN_DUR = 2;
const MAX_DUR = 15;
const VIDEO_MIN_TOTAL_PX = 409600;
const VIDEO_MAX_TOTAL_PX = 2086876;
const MIN_FPS = 24;
const MAX_FPS = 60;
/** 官方允许的 mime(按类型);key 已归一小写去参数。 */
const ALLOWED_MIME: Record<AssetType, string[]> = {
    image: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/bmp', 'image/tiff', 'image/gif'],
    video: ['video/mp4', 'video/quicktime'],
    audio: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave'],
};

/** 从图片字节头读宽高(dep-free:PNG / JPEG / WebP / GIF)。认不出 → null。 */
export function readImageDims(buf: Buffer): { w: number; h: number } | null {
    // PNG:8 字节签名 + IHDR,宽高大端在 offset 16/20
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf.toString('latin1', 12, 16) === 'IHDR') {
        return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // JPEG:扫 SOF0/SOF2 段
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        let off = 2;
        while (off + 9 < buf.length) {
            if (buf[off] !== 0xff) {
                off++;
                continue;
            }
            const marker = buf[off + 1];
            if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
                off += 2;
                continue;
            }
            const len = buf.readUInt16BE(off + 2);
            if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
                return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
            }
            off += 2 + len;
        }
        return null;
    }
    // GIF:6 字节签名 + LSD 宽高小端
    if (buf.length >= 10 && (buf.toString('latin1', 0, 6) === 'GIF87a' || buf.toString('latin1', 0, 6) === 'GIF89a')) {
        return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    // WebP:RIFF + VP8 / VP8L / VP8X
    if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
        const chunk = buf.toString('latin1', 12, 16);
        if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
            return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
        }
        if (chunk === 'VP8L' && buf[20] === 0x2f) {
            const b = buf.readUInt32LE(21);
            return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
        }
        if (chunk === 'VP8X') {
            return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
        }
    }
    // BMP:'BM' + DIB header(BITMAPINFOHEADER 起宽高为 int32 小端 @18/22)
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
        const w = buf.readInt32LE(18);
        const h = Math.abs(buf.readInt32LE(22)); // 负高 = 自顶向下
        if (w > 0 && h > 0) return { w, h };
        return null;
    }
    // TIFF:II*\0(小端)/ MM\0*(大端)→ IFD 里找 tag 256(宽) / 257(高)
    if (buf.length >= 8) {
        const le = buf.toString('latin1', 0, 4) === 'II\u002a\u0000';
        const be = buf.toString('latin1', 0, 4) === 'MM\u0000\u002a';
        if (le || be) {
            const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
            const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
            try {
                const ifd = u32(4);
                if (ifd + 2 > buf.length) return null;
                const n = u16(ifd);
                let w = 0;
                let h = 0;
                for (let i = 0; i < n; i++) {
                    const e = ifd + 2 + i * 12;
                    if (e + 12 > buf.length) break;
                    const tag = u16(e);
                    const type = u16(e + 2);
                    // SHORT(3)取低 16 位,LONG(4)取 32 位;值内联在 offset 8 处
                    const val = type === 3 ? u16(e + 8) : u32(e + 8);
                    if (tag === 256) w = val;
                    else if (tag === 257) h = val;
                }
                if (w > 0 && h > 0) return { w, h };
            } catch {
                return null;
            }
        }
    }
    return null;
}

/** MP4/MOV 顶层 box 扫描器(共享给时长 / 维度 / 帧率解析)。 */
function findBox(buf: Buffer, start: number, end: number, want: string): { start: number; end: number } | null {
    let off = start;
    while (off + 8 <= end) {
        let size = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        let header = 8;
        if (size === 1) {
            if (off + 16 > end) return null;
            const big = buf.readBigUInt64BE(off + 8);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
            size = Number(big);
            header = 16;
        } else if (size === 0) {
            size = end - off;
        }
        if (size < header || off + size > end) return null;
        if (type === want) return { start: off + header, end: off + size };
        off += size;
    }
    return null;
}

/** 视频宽高(moov→trak→tkhd 的 width/height,16.16 定点)+ 帧率(stts:样本数/时长)。
 *  多 trak 时取第一个有非零宽高的(视频轨)。认不出的维度返 null,调用方跳过该项校验。 */
export function readVideoMeta(buf: Buffer): { w?: number; h?: number; fps?: number } {
    const out: { w?: number; h?: number; fps?: number } = {};
    try {
        const moov = findBox(buf, 0, buf.length, 'moov');
        if (!moov) return out;
        // 逐个 trak 找视频轨
        let off = moov.start;
        while (off + 8 <= moov.end) {
            const trak = findBox(buf, off, moov.end, 'trak');
            if (!trak) break;
            const tkhd = findBox(buf, trak.start, trak.end, 'tkhd');
            if (tkhd) {
                // v0: 后 8 字节 = width/height(16.16);v1 同结构但前面多 12 字节
                const tail = tkhd.end - 8;
                if (tail > tkhd.start) {
                    const w = buf.readUInt32BE(tail) / 65536;
                    const h = buf.readUInt32BE(tail + 4) / 65536;
                    if (w >= 1 && h >= 1) {
                        out.w = Math.round(w);
                        out.h = Math.round(h);
                        // 同轨取帧率:mdia→minf→stbl→stts(样本总数 / 总时长)+ mdhd timescale
                        const mdia = findBox(buf, trak.start, trak.end, 'mdia');
                        const mdhd = mdia && findBox(buf, mdia.start, mdia.end, 'mdhd');
                        const minf = mdia && findBox(buf, mdia.start, mdia.end, 'minf');
                        const stbl = minf && findBox(buf, minf.start, minf.end, 'stbl');
                        const stts = stbl && findBox(buf, stbl.start, stbl.end, 'stts');
                        if (mdhd && stts) {
                            const mv = buf[mdhd.start];
                            const timescale =
                                mv === 1 ? buf.readUInt32BE(mdhd.start + 20) : buf.readUInt32BE(mdhd.start + 12);
                            const entries = buf.readUInt32BE(stts.start + 4);
                            let samples = 0;
                            let ticks = 0;
                            for (let i = 0; i < entries; i++) {
                                const e = stts.start + 8 + i * 8;
                                if (e + 8 > stts.end) break;
                                const count = buf.readUInt32BE(e);
                                const delta = buf.readUInt32BE(e + 4);
                                samples += count;
                                ticks += count * delta;
                            }
                            if (timescale > 0 && ticks > 0 && samples > 0) {
                                out.fps = (samples * timescale) / ticks;
                            }
                        }
                        break; // 视频轨已拿到
                    }
                }
            }
            off = trak.end;
        }
    } catch {
        /* best-effort */
    }
    return out;
}

/** WAV 时长(RIFF/fmt 采样率 + data 块大小)。非 WAV / 认不出 → null(MP3 不解析)。 */
export function readWavDurationSec(buf: Buffer): number | null {
    try {
        if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
            return null;
        }
        let off = 12;
        let byteRate = 0;
        let dataLen = 0;
        while (off + 8 <= buf.length) {
            const id = buf.toString('latin1', off, off + 4);
            const size = buf.readUInt32LE(off + 4);
            if (id === 'fmt ' && off + 16 <= buf.length) byteRate = buf.readUInt32LE(off + 16);
            else if (id === 'data') {
                // 声明长度超出实际字节 = 文件不全 → 判不出时长(返 null 跳过),
                // 不按截断长度算(会把完整文件误判成过短而误杀)
                if (size > buf.length - off - 8) return null;
                dataLen = size;
                break;
            }
            off += 8 + size + (size % 2);
        }
        return byteRate > 0 && dataLen > 0 ? dataLen / byteRate : null;
    } catch {
        return null;
    }
}

/** 从 MP4/MOV 字节读时长秒(顶层扫 box 找 moov→mvhd;best-effort,认不出 → null)。 */
export function readMp4DurationSec(buf: Buffer): number | null {
    function scan(start: number, end: number, want: string): { start: number; end: number } | null {
        let off = start;
        while (off + 8 <= end) {
            let size = buf.readUInt32BE(off);
            const type = buf.toString('latin1', off + 4, off + 8);
            let header = 8;
            if (size === 1) {
                if (off + 16 > end) return null;
                const big = buf.readBigUInt64BE(off + 8);
                if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
                size = Number(big);
                header = 16;
            } else if (size === 0) {
                size = end - off;
            }
            if (size < header || off + size > end) return null;
            if (type === want) return { start: off + header, end: off + size };
            off += size;
        }
        return null;
    }
    try {
        const moov = scan(0, buf.length, 'moov');
        if (!moov) return null;
        const mvhd = scan(moov.start, moov.end, 'mvhd');
        if (!mvhd) return null;
        const version = buf[mvhd.start];
        if (version === 1) {
            const timescale = buf.readUInt32BE(mvhd.start + 20);
            const duration = Number(buf.readBigUInt64BE(mvhd.start + 24));
            return timescale > 0 ? duration / timescale : null;
        }
        const timescale = buf.readUInt32BE(mvhd.start + 12);
        const duration = buf.readUInt32BE(mvhd.start + 16);
        return timescale > 0 ? duration / timescale : null;
    } catch {
        return null;
    }
}

/** 上传时按火山官方规则校验媒体;不合格 → AssetError('InvalidParameter')。
 *  多条错误按官方语义用 \n 逐条列出(客户脚本按行解析);解析不出的维度跳过(不误杀)。 */
export function validateAssetMedia(assetType: AssetType, bytes: Buffer, mime: string): void {
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
    const errs: string[] = [];
    const m = mime.toLowerCase().split(';')[0].trim();
    if (!ALLOWED_MIME[assetType].includes(m)) {
        const label = { image: 'JPEG/PNG/WEBP/BMP/TIFF/GIF', video: 'MP4/MOV', audio: 'MP3/WAV' }[assetType];
        errs.push(`${assetType} 仅支持 ${label}(火山官方要求),实际 ${mime}`);
    }

    if (assetType === 'image') {
        if (bytes.length >= IMAGE_MAX_BYTES) errs.push(`图片需小于 30MB(火山官方要求),实际 ${mb(bytes.length)}`);
        const dims = readImageDims(bytes);
        if (!dims) {
            errs.push('无法解析图片尺寸(文件需完整且为 JPEG/PNG/WEBP/BMP/TIFF/GIF)');
        } else {
            const { w, h } = dims;
            if (w <= MIN_PX || h <= MIN_PX || w >= MAX_PX || h >= MAX_PX) {
                errs.push(`图片宽高需在 ${MIN_PX}-${MAX_PX}px(火山官方要求),实际 ${w}×${h}`);
            }
            const ratio = w / h;
            if (ratio <= MIN_RATIO || ratio >= MAX_RATIO) {
                errs.push(`图片宽高比需在 ${MIN_RATIO}-${MAX_RATIO}(火山官方要求),实际 ${ratio.toFixed(2)}(${w}×${h})`);
            }
        }
    } else if (assetType === 'video') {
        if (bytes.length > VIDEO_MAX_BYTES) errs.push(`视频不超过 50MB(火山官方要求),实际 ${mb(bytes.length)}`);
        const dur = readMp4DurationSec(bytes);
        if (dur != null && (dur < MIN_DUR || dur > MAX_DUR)) {
            errs.push(`视频时长需 ${MIN_DUR}-${MAX_DUR} 秒(火山官方要求),实际 ${dur.toFixed(1)} 秒`);
        }
        const meta = readVideoMeta(bytes);
        if (meta.w && meta.h) {
            const { w, h } = meta;
            if (w < MIN_PX || h < MIN_PX || w > MAX_PX || h > MAX_PX) {
                errs.push(`视频宽高需在 ${MIN_PX}-${MAX_PX}px(火山官方要求),实际 ${w}×${h}`);
            }
            const ratio = w / h;
            if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
                errs.push(`视频宽高比需在 ${MIN_RATIO}-${MAX_RATIO}(火山官方要求),实际 ${ratio.toFixed(2)}`);
            }
            const total = w * h;
            if (total < VIDEO_MIN_TOTAL_PX || total > VIDEO_MAX_TOTAL_PX) {
                errs.push(
                    `视频总像素需在 ${VIDEO_MIN_TOTAL_PX}-${VIDEO_MAX_TOTAL_PX}(火山官方要求),实际 ${total}(${w}×${h})`,
                );
            }
        }
        if (meta.fps != null && (meta.fps < MIN_FPS - 0.5 || meta.fps > MAX_FPS + 0.5)) {
            errs.push(`视频帧率需在 ${MIN_FPS}-${MAX_FPS} FPS(火山官方要求),实际 ${meta.fps.toFixed(1)}`);
        }
    } else {
        if (bytes.length > AUDIO_MAX_BYTES) errs.push(`音频不超过 15MB(火山官方要求),实际 ${mb(bytes.length)}`);
        const dur = readWavDurationSec(bytes); // MP3 时长不解析(无解码依赖),跳过
        if (dur != null && (dur < MIN_DUR || dur > MAX_DUR)) {
            errs.push(`音频时长需 ${MIN_DUR}-${MAX_DUR} 秒(火山官方要求),实际 ${dur.toFixed(1)} 秒`);
        }
    }

    if (errs.length) throw new AssetError('InvalidParameter', errs.join('\n'));
}

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

/** 火山风格 id:asset-YYYYMMDDHHMMSS-xxxxxx(UTC 时间戳 + 随机尾,可排序)。 */
export function newAssetId(prefix: 'asset' | 'group'): string {
    const d = new Date();
    const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    return `${prefix}-${ts}-${randomBytes(3).toString('hex')}`;
}

/** SSRF 基础守门(镜像 W9 D2 语义):协议白名单 + 私网/环回字面量拒。 */
export function assertSafeExternalUrl(raw: string): URL {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new AssetError('InvalidParameter', 'URL 不是合法的 http(s) 地址');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new AssetError('InvalidParameter', 'URL 仅支持 http/https');
    }
    const host = u.hostname.toLowerCase();
    const privatePatterns = [
        /^localhost$/,
        /^127\./,
        /^10\./,
        /^192\.168\./,
        /^172\.(1[6-9]|2\d|3[01])\./,
        /^169\.254\./,
        /^0\./,
        /^\[?::1\]?$/,
        /^\[?fc/,
        /^\[?fe80/,
    ];
    if (privatePatterns.some((p) => p.test(host))) {
        throw new AssetError('InvalidParameter', 'URL 指向内网地址,已拒绝');
    }
    return u;
}

/** 配额检查(创建前;bytes 已知时一并查总量)。 */
export async function assertAssetQuota(userId: string, newBytes: number): Promise<void> {
    const limits = assetLimits();
    if (newBytes > limits.maxFileBytes) {
        throw new AssetError('QuotaExceeded', `单文件超出上限(${Math.round(limits.maxFileBytes / 1024 / 1024)}MB)`);
    }
    const [count, agg] = await Promise.all([
        prisma.enterpriseAsset.count({ where: { user_id: userId } }),
        prisma.enterpriseAsset.aggregate({ where: { user_id: userId }, _sum: { bytes: true } }),
    ]);
    if (count >= limits.maxAssets) {
        throw new AssetError('QuotaExceeded', `素材数量已达上限(${limits.maxAssets})`);
    }
    if ((agg._sum.bytes ?? 0) + newBytes > limits.maxTotalBytes) {
        throw new AssetError('QuotaExceeded', '素材总容量已达上限');
    }
}

export interface StoreAssetInput {
    userId: string;
    assetType: AssetType;
    name: string;
    description?: string | null;
    groupId?: string | null;
    bytes: Buffer;
    mime: string;
    sourceUrl?: string | null;
}

/** 字节 → R2 + 落库(两套表面共用)。groupId 传入时校验归属。 */
export async function storeAsset(input: StoreAssetInput) {
    validateAssetMedia(input.assetType, input.bytes, input.mime);
    if (input.groupId) {
        const g = await prisma.enterpriseAssetGroup.findFirst({
            where: { id: input.groupId, user_id: input.userId },
            select: { id: true },
        });
        if (!g) throw new AssetError('GroupNotFound', `素材组不存在: ${input.groupId}`, 404);
    }
    await assertAssetQuota(input.userId, input.bytes.length);
    const id = newAssetId('asset');
    const ext = EXT_BY_MIME[input.mime.toLowerCase().split(';')[0]] ?? 'bin';
    const key = `enterprise-assets/${input.userId}/${id}.${ext}`;
    const publicUrl = await uploadImage(key, input.bytes, input.mime);
    return prisma.enterpriseAsset.create({
        data: {
            id,
            user_id: input.userId,
            group_id: input.groupId ?? null,
            asset_type: input.assetType,
            name: input.name,
            description: input.description ?? null,
            r2_key: key,
            public_url: publicUrl,
            mime: input.mime,
            bytes: input.bytes.length,
            source_url: input.sourceUrl ?? null,
        },
    });
}

const FETCH_TIMEOUT_MS = 30_000;

/** CreateAsset 的 URL 抓取:SSRF 守门 + 超时 + 大小上限。返回字节 + mime。 */
export async function fetchAssetFromUrl(
    rawUrl: string,
    assetType: AssetType,
): Promise<{ bytes: Buffer; mime: string }> {
    assertSafeExternalUrl(rawUrl);
    const limits = assetLimits();
    let res: Response;
    try {
        res = await fetch(rawUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    } catch (e) {
        throw new AssetError('InvalidParameter', `素材 URL 抓取失败: ${String(e).slice(0, 120)}`);
    }
    if (!res.ok) throw new AssetError('InvalidParameter', `素材 URL 返回 ${res.status}`);
    const clen = Number(res.headers.get('content-length') || 0);
    if (clen > limits.maxFileBytes) {
        throw new AssetError('QuotaExceeded', `单文件超出上限(${Math.round(limits.maxFileBytes / 1024 / 1024)}MB)`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limits.maxFileBytes) {
        throw new AssetError('QuotaExceeded', `单文件超出上限(${Math.round(limits.maxFileBytes / 1024 / 1024)}MB)`);
    }
    if (buf.length === 0) throw new AssetError('InvalidParameter', '素材 URL 内容为空');
    const fallback: Record<AssetType, string> = { image: 'image/png', video: 'video/mp4', audio: 'audio/mpeg' };
    const mime = (res.headers.get('content-type') || fallback[assetType]).split(';')[0].trim();
    return { bytes: buf, mime };
}

/** 删素材:行 + R2(R2 失败不阻断 —— 行删了引用即失效,残字节可后续清)。 */
export async function deleteAsset(userId: string, assetId: string): Promise<boolean> {
    const row = await prisma.enterpriseAsset.findFirst({
        where: { id: assetId, user_id: userId },
        select: { id: true, r2_key: true },
    });
    if (!row) return false;
    await prisma.enterpriseAsset.delete({ where: { id: row.id } });
    deleteImage(row.r2_key).catch((e) => console.warn('[enterprise-assets] R2 delete failed', row.r2_key, e));
    return true;
}

// ── 生成引用解析 ──────────────────────────────────────────────────────────

const ASSET_REF = /^asset-\d{14}-[0-9a-f]{6}$/;
const GROUP_REF = /^group-\d{14}-[0-9a-f]{6}$/;
/** 不做引用替换的字段(纯文本/控制字段,防 prompt 恰好长得像 id 被误替换)。 */
const SKIP_KEYS = new Set(['prompt', 'model', 'text', 'name', 'description']);

/** 剥 asset:// 前缀取裸 id(volc 面 body 不做全局 stripAssetUri,引用可能带前缀)。 */
function bareRef(v: string): string {
    return v.startsWith('asset://') ? v.slice('asset://'.length) : v;
}

function collectRefs(value: unknown, key: string | null, out: { assets: Set<string>; groups: Set<string> }): void {
    if (typeof value === 'string') {
        if (key && SKIP_KEYS.has(key)) return;
        const bare = bareRef(value);
        if (ASSET_REF.test(bare)) out.assets.add(bare);
        else if (GROUP_REF.test(bare)) out.groups.add(bare);
        return;
    }
    if (Array.isArray(value)) {
        for (const v of value) collectRefs(v, key, out);
        return;
    }
    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) collectRefs(v, k, out);
    }
}

/**
 * 把生成请求体里的 asset-… / group-… 引用换成 R2 公网 URL(深遍历,整串精确匹配;
 * asset://<id> 前缀形同样识别)。
 * - asset id:任意字符串位置(标量字段 / 数组元素 / {url:} 值)直接替换;
 * - group id:仅允许出现在【数组】里,按 created_at 升序展开为成员 URL 序列
 *   (对标火山「多图参考指定素材组」;标量位置的 group 引用 → 报错);
 * - 未知 / 非本人 id → 默认 AssetError('AssetNotFound');`lenient: true`(volc 面,
 *   2026-08-06)则原样保留 —— 平台库素材换直链,认不出的(真人素材 / 存量 provider
 *   素材,id 尾缀 5 位不匹配我们 6-hex 正则,或已删)透传给上游 provider 解析。
 * 无引用时原样返回。
 */
export async function resolveAssetRefs(
    body: Record<string, unknown>,
    userId: string,
    opts?: { lenient?: boolean },
): Promise<Record<string, unknown>> {
    const lenient = opts?.lenient === true;
    const refs = { assets: new Set<string>(), groups: new Set<string>() };
    collectRefs(body, null, refs);
    if (refs.assets.size === 0 && refs.groups.size === 0) return body;

    const [assets, groupAssets] = await Promise.all([
        refs.assets.size
            ? prisma.enterpriseAsset.findMany({
                  where: { id: { in: [...refs.assets] }, user_id: userId },
                  select: { id: true, public_url: true },
              })
            : Promise.resolve([]),
        refs.groups.size
            ? prisma.enterpriseAsset.findMany({
                  where: { group_id: { in: [...refs.groups] }, user_id: userId },
                  orderBy: { created_at: 'asc' },
                  select: { group_id: true, public_url: true },
              })
            : Promise.resolve([]),
    ]);
    const assetUrl = new Map(assets.map((a) => [a.id, a.public_url]));
    const groupUrls = new Map<string, string[]>();
    for (const a of groupAssets) {
        if (!a.group_id) continue;
        const list = groupUrls.get(a.group_id) ?? [];
        list.push(a.public_url);
        groupUrls.set(a.group_id, list);
    }
    const knownGroups = new Set<string>();
    if (!lenient) {
        for (const id of refs.assets) {
            if (!assetUrl.has(id)) throw new AssetError('AssetNotFound', `素材不存在: ${id}`, 400);
        }
    }
    if (refs.groups.size) {
        const owned = await prisma.enterpriseAssetGroup.findMany({
            where: { id: { in: [...refs.groups] }, user_id: userId },
            select: { id: true },
        });
        for (const g of owned) knownGroups.add(g.id);
        if (!lenient) {
            // group 必须真实存在且属于本人(空组展开为 0 张图会被档位门控拒 → 明确报错更友好)
            for (const id of refs.groups) {
                if (!knownGroups.has(id)) throw new AssetError('GroupNotFound', `素材组不存在: ${id}`, 400);
                if (!groupUrls.get(id)?.length) throw new AssetError('InvalidParameter', `素材组为空: ${id}`, 400);
            }
        }
    }

    function transform(value: unknown, key: string | null): unknown {
        if (typeof value === 'string') {
            if (key && SKIP_KEYS.has(key)) return value;
            const bare = bareRef(value);
            if (ASSET_REF.test(bare)) return assetUrl.get(bare) ?? value;
            if (GROUP_REF.test(bare)) {
                if (lenient && !knownGroups.has(bare)) return value; // 非平台组(真人/provider)透传
                throw new AssetError('InvalidParameter', `素材组引用只能放在数组字段里: ${value}`, 400);
            }
            return value;
        }
        if (Array.isArray(value)) {
            const out: unknown[] = [];
            for (const v of value) {
                const bare = typeof v === 'string' ? bareRef(v) : '';
                if (typeof v === 'string' && GROUP_REF.test(bare) && (!lenient || knownGroups.has(bare))) {
                    for (const u of groupUrls.get(bare) ?? []) out.push(u);
                } else {
                    out.push(transform(v, key));
                }
            }
            return out;
        }
        if (value && typeof value === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value)) out[k] = transform(v, k);
            return out;
        }
        return value;
    }
    return transform(body, null) as Record<string, unknown>;
}
