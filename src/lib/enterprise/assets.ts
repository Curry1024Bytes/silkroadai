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
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/mp4': 'm4a',
};

export type AssetType = 'image' | 'video' | 'audio';

// ── 火山官方媒体校验(2026-08-06,客户反馈:官方直传会拒的图我们收了还标 active)──
// 官方要求(727 文档审计):图 <30MB、宽高 300-6000px、宽高比 0.4-2.5;
// 视频 MP4/MOV ≤50MB、2-15s(帧率/总像素上游生成时仍会校验,这里不解析);音频 ≤15MB。
// 单点挂在 storeAsset —— Action API 与控制台上传同享。

const IMAGE_MAX_BYTES = 30 * 1024 * 1024;
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const AUDIO_MAX_BYTES = 15 * 1024 * 1024;

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
    return null;
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

/** 上传时按火山官方要求校验媒体;不合格 → AssetError('InvalidParameter')(400,带具体原因)。 */
export function validateAssetMedia(assetType: AssetType, bytes: Buffer, mime: string): void {
    const mb = (n: number) => `${Math.round(n / 1024 / 1024)}MB`;
    if (assetType === 'image') {
        if (bytes.length >= IMAGE_MAX_BYTES) {
            throw new AssetError('InvalidParameter', `图片超出火山官方上限 30MB(实际 ${mb(bytes.length)})`);
        }
        const dims = readImageDims(bytes);
        if (!dims) {
            throw new AssetError('InvalidParameter', '无法解析图片尺寸(仅支持 PNG / JPEG / WebP / GIF,且文件需完整)');
        }
        const { w, h } = dims;
        if (w < 300 || h < 300 || w > 6000 || h > 6000) {
            throw new AssetError('InvalidParameter', `图片宽高需在 300-6000px(火山官方要求),实际 ${w}×${h}`);
        }
        const ratio = w / h;
        if (ratio < 0.4 || ratio > 2.5) {
            throw new AssetError(
                'InvalidParameter',
                `图片宽高比需在 0.4-2.5(火山官方要求),实际 ${ratio.toFixed(2)}(${w}×${h})`,
            );
        }
        return;
    }
    if (assetType === 'video') {
        if (bytes.length > VIDEO_MAX_BYTES) {
            throw new AssetError('InvalidParameter', `视频超出火山官方上限 50MB(实际 ${mb(bytes.length)})`);
        }
        const m = mime.toLowerCase();
        if (!m.includes('mp4') && !m.includes('quicktime')) {
            throw new AssetError('InvalidParameter', `视频仅支持 MP4 / MOV(火山官方要求),实际 ${mime}`);
        }
        const dur = readMp4DurationSec(bytes);
        if (dur != null && (dur < 2 || dur > 15)) {
            throw new AssetError('InvalidParameter', `视频时长需 2-15 秒(火山官方要求),实际 ${dur.toFixed(1)} 秒`);
        }
        return;
    }
    // audio
    if (bytes.length > AUDIO_MAX_BYTES) {
        throw new AssetError('InvalidParameter', `音频超出火山官方上限 15MB(实际 ${mb(bytes.length)})`);
    }
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
