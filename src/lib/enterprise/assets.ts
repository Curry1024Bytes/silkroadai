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
