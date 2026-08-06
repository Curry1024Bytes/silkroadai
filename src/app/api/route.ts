import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { resolveEnterpriseAuth } from '@/lib/enterprise/keys';
import {
    AssetError,
    deleteAsset,
    fetchAssetFromUrl,
    newAssetId,
    storeAsset,
    type AssetType,
} from '@/lib/enterprise/assets';
import { RealPersonError, createVisualValidateSession, getVisualValidateGroupId } from '@/lib/enterprise/real-person';
import { handleVolcAssetAction, VOLC_ASSET_ACTIONS } from '@/lib/enterprise/volc-assets';

export const runtime = 'nodejs';

/**
 * P3 素材库 Action API —— 对标火山方舟素材库契约(operator 提供的网关文档):
 * `POST /api?Action=<action>&Version=2024-01-01&ns=asset_manager`,JSON body,
 * `Authorization: Bearer sk-ent-…`,响应 {ResponseMetadata, Result} 火山 envelope。
 *
 * 素材字节存我们 R2(公网直链),隔离 = 门户 user_id 行级归属(与上游无关,
 * operator 2026-07-19 确认上游对直传 URL 全权限)。生成里用:请求体写 asset-…/
 * group-… id,enterprise proxy 解析注入(见 lib/enterprise/assets resolveAssetRefs)。
 *
 * ⚠️ 本路由挂在 /api 精确路径(不影响 /api/* 子路由);主站实例同样可达但同样
 * sk-ent 鉴权 —— 非企业 key 一律 401。middleware 企业白名单已放行 `/api`。
 */
const VERSION = '2024-01-01';

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

function meta(action: string) {
    const d = new Date();
    const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    return {
        RequestId: `${ts}${randomBytes(8).toString('hex').toUpperCase()}`,
        Action: action,
        Version: VERSION,
        Service: 'ark',
        Region: 'cn-beijing',
    };
}

const ok = (action: string, result: unknown) => NextResponse.json({ ResponseMetadata: meta(action), Result: result });

const fail = (action: string, status: number, code: string, message: string) =>
    NextResponse.json({ ResponseMetadata: { ...meta(action), Error: { Code: code, Message: message } } }, { status });

const ASSET_TYPES = ['image', 'video', 'audio'] as const;
// 对齐火山官方 AssetType 大写(Image/Video/Audio):入口大小写都收、归一小写(内部/DB 存小写,
// 兼容历史数据);出口用 ASSET_TYPE_OUT 统一回大写。
const assetTypeInput = z
    .string()
    .transform((s) => s.toLowerCase())
    .pipe(z.enum(ASSET_TYPES));
const ASSET_TYPE_OUT: Record<string, string> = { image: 'Image', video: 'Video', audio: 'Audio' };

const createAssetSchema = z.object({
    AssetType: assetTypeInput,
    URL: z.string().min(1).max(2000),
    Name: z.string().trim().min(1).max(100),
    Description: z.string().trim().max(500).optional(),
    GroupId: z.string().trim().max(60).optional(),
});
const idSchema = z.object({ Id: z.string().trim().min(1).max(60) });
const updateAssetSchema = idSchema.extend({
    Name: z.string().trim().min(1).max(100).optional(),
    Description: z.string().trim().max(500).nullable().optional(),
    GroupId: z.string().trim().max(60).nullable().optional(),
});
const listAssetsSchema = z.object({
    GroupId: z.string().trim().max(60).optional(),
    AssetType: assetTypeInput.optional(),
    PageNumber: z.number().int().min(1).default(1),
    PageSize: z.number().int().min(1).max(100).default(20),
});
const createGroupSchema = z.object({
    Name: z.string().trim().min(1).max(100),
    Description: z.string().trim().max(500).optional(),
});
const updateGroupSchema = idSchema.extend({
    Name: z.string().trim().min(1).max(100).optional(),
    Description: z.string().trim().max(500).nullable().optional(),
});
const listGroupsSchema = z.object({
    PageNumber: z.number().int().min(1).default(1),
    PageSize: z.number().int().min(1).max(100).default(20),
});

function assetResult(a: {
    id: string;
    name: string;
    description: string | null;
    asset_type: string;
    group_id: string | null;
    public_url: string;
    bytes: number;
    mime: string | null;
    created_at: Date;
}) {
    return {
        Id: a.id,
        Name: a.name,
        Description: a.description ?? undefined,
        AssetType: ASSET_TYPE_OUT[a.asset_type] ?? a.asset_type,
        GroupId: a.group_id ?? undefined,
        Status: 'active',
        URL: a.public_url,
        Bytes: a.bytes,
        MimeType: a.mime ?? undefined,
        CreatedAt: a.created_at.toISOString(),
    };
}

function groupResult(g: { id: string; name: string; description: string | null; created_at: Date }) {
    return {
        Id: g.id,
        Name: g.name,
        Description: g.description ?? undefined,
        CreatedAt: g.created_at.toISOString(),
    };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
    const action = req.nextUrl.searchParams.get('Action') || '';
    if (!action) return fail('Unknown', 400, 'MissingParameter', 'query 参数 Action 必填');

    // AK/SK 火山签名验签需要原始 body,故先读 body 再鉴权(sk-ent Bearer 不受影响)。
    const raw = await req.text();
    // middleware 把 `/`(火山官方根路径形态)/ `/api/`(尾斜杠)rewrite 到本路由,
    // 原始 path 在 x-enterprise-orig-path —— SignerV4 客户签的是实际请求 path,验签
    // 必须用它。只信白名单值(外部伪造该头拿不到任何好处,签名仍要过 HMAC)。
    const origPath = req.headers.get('x-enterprise-orig-path');
    const auth = await resolveEnterpriseAuth({
        authorization: req.headers.get('authorization'),
        method: req.method,
        path: origPath === '/' || origPath === '/api/' ? origPath : req.nextUrl.pathname,
        query: req.nextUrl.searchParams,
        headers: req.headers,
        rawBody: raw,
    });
    if (!auth.ok) return fail(action, auth.status, 'UnauthorizedOperation', auth.message);
    const userId = auth.customer.userId;

    // 「火山」渠道客户?= 已开通 volc(有 volc 上游 key 行)。AK/SK 是账号级(非按 region),
    // 故按"客户是否开通 volc"判定。volc 客户的真人认证 + 素材库都走 provider(专属服务)。
    const isVolc = !!(await prisma.enterpriseUpstreamKey.findUnique({
        where: { user_id_region: { user_id: userId, region: 'volc' } },
        select: { id: true },
    }));

    // 真人认证是「火山」渠道专属服务:未开通 volc → 403。
    if ((action === 'CreateVisualValidateSession' || action === 'GetVisualValidateResult') && !isVolc) {
        return fail(action, 403, 'ChannelNotEnabled', '真人认证为「火山」渠道专属服务,请先开通火山渠道');
    }

    let body: unknown = {};
    if (raw.trim()) {
        try {
            body = JSON.parse(raw);
        } catch {
            return fail(action, 400, 'InvalidParameter', '请求体必须是 JSON');
        }
    }

    // 素材库分流(2026-08-06 改按【请求密钥的渠道】,替代 Phase 2b 的账号级一刀切 ——
    // 一刀切让"开通 volc 但在测 promax"的客户素材也被劫持到 provider,而 promax/cn/global
    // 生成的 asset:// 引用解析的是我们 R2 库,素材传了也用不上,还吃 provider 配额):
    //  - volc 区 sk-ent key → provider REST(火山直链;与真人 GroupId / volc 视频 asset:// 同一
    //    provider 账号自洽,Phase 2b 语义不变)
    //  - cn/global/promax 区 sk-ent key → 我们 R2 库(这三个渠道生成时 resolveAssetRefs 查的就是它)
    //  - AK/SK / sk_ent_(账号级,727 火山对齐面,无渠道绑定)→ 开通 volc 即走 provider
    //    (存量火山客户 AK/SK 脚本的 asset:// 视频引用依赖 provider 账号,不能断)
    const useVolcAssets = isVolc && (auth.customer.accountLevel === true || auth.customer.region === 'volc');

    try {
        if (useVolcAssets && VOLC_ASSET_ACTIONS.has(action)) {
            return ok(action, await handleVolcAssetAction(action, body));
        }
        switch (action) {
            case 'CreateAsset': {
                const p = createAssetSchema.safeParse(body);
                if (!p.success) return fail(action, 400, 'InvalidParameter', p.error.issues[0]?.message || 'invalid');
                const { AssetType: at, URL, Name, Description, GroupId } = p.data;
                const fetched = await fetchAssetFromUrl(URL, at as AssetType);
                const row = await storeAsset({
                    userId,
                    assetType: at as AssetType,
                    name: Name,
                    description: Description,
                    groupId: GroupId,
                    bytes: fetched.bytes,
                    mime: fetched.mime,
                    sourceUrl: URL,
                });
                return ok(action, { Id: row.id, Status: 'active', URL: row.public_url });
            }
            case 'GetAsset': {
                const p = idSchema.safeParse(body);
                if (!p.success) return fail(action, 400, 'InvalidParameter', 'Id 必填');
                const a = await prisma.enterpriseAsset.findFirst({ where: { id: p.data.Id, user_id: userId } });
                if (!a) return fail(action, 404, 'AssetNotFound', `素材不存在: ${p.data.Id}`);
                return ok(action, assetResult(a));
            }
            case 'UpdateAsset': {
                const p = updateAssetSchema.safeParse(body);
                if (!p.success) return fail(action, 400, 'InvalidParameter', p.error.issues[0]?.message || 'invalid');
                const { Id, Name, Description, GroupId } = p.data;
                if (GroupId) {
                    const g = await prisma.enterpriseAssetGroup.findFirst({
                        where: { id: GroupId, user_id: userId },
                        select: { id: true },
                    });
                    if (!g) return fail(action, 404, 'GroupNotFound', `素材组不存在: ${GroupId}`);
                }
                const r = await prisma.enterpriseAsset.updateMany({
                    where: { id: Id, user_id: userId },
                    data: {
                        ...(Name !== undefined ? { name: Name } : {}),
                        ...(Description !== undefined ? { description: Description } : {}),
                        ...(GroupId !== undefined ? { group_id: GroupId } : {}),
                    },
                });
                if (r.count === 0) return fail(action, 404, 'AssetNotFound', `素材不存在: ${Id}`);
                return ok(action, {});
            }
            case 'DeleteAsset': {
                const p = idSchema.safeParse(body);
                if (!p.success) return fail(action, 400, 'InvalidParameter', 'Id 必填');
                const done = await deleteAsset(userId, p.data.Id);
                if (!done) return fail(action, 404, 'AssetNotFound', `素材不存在: ${p.data.Id}`);
                return ok(action, {});
            }
            case 'ListAssets': {
                const p = listAssetsSchema.safeParse(body);
                if (!p.success) return fail(action, 400, 'InvalidParameter', p.error.issues[0]?.message || 'invalid');
                const where = {
                    user_id: userId,
                    ...(p.data.GroupId ? { group_id: p.data.GroupId } : {}),
                    ...(p.data.AssetType ? { asset_type: p.data.AssetType } : {}),
                };
                const [total, items] = await Promise.all([
                    prisma.enterpriseAsset.count({ where }),
                    prisma.enterpriseAsset.findMany({
                        where,
                        orderBy: { created_at: 'desc' },
                        skip: (p.data.PageNumber - 1) * p.data.PageSize,
                        take: p.data.PageSize,
                    }),
                ]);
                return ok(action, {
                    Items: items.map(assetResult),
                    Total: total,
                    PageNumber: p.data.PageNumber,
                    PageSize: p.data.PageSize,
                });
            }
            case 'CreateAssetGroup': {
                const p = createGroupSchema.safeParse(body);
                if (!p.success) return fail(action, 400, 'InvalidParameter', p.error.issues[0]?.message || 'invalid');
                const g = await prisma.enterpriseAssetGroup.create({
                    data: {
                        id: newAssetId('group'),
                        user_id: userId,
                        name: p.data.Name,
                        description: p.data.Description ?? null,
                    },
                });
                return ok(action, { Id: g.id });
            }
            case 'GetAssetGroup': {
                const p = idSchema.safeParse(body);
                if (!p.success) return fail(action, 400, 'InvalidParameter', 'Id 必填');
                const g = await prisma.enterpriseAssetGroup.findFirst({ where: { id: p.data.Id, user_id: userId } });
                if (!g) return fail(action, 404, 'GroupNotFound', `素材组不存在: ${p.data.Id}`);
                const count = await prisma.enterpriseAsset.count({ where: { group_id: g.id } });
                return ok(action, { ...groupResult(g), AssetCount: count });
            }
            case 'UpdateAssetGroup': {
                const p = updateGroupSchema.safeParse(body);
                if (!p.success) return fail(action, 400, 'InvalidParameter', p.error.issues[0]?.message || 'invalid');
                const r = await prisma.enterpriseAssetGroup.updateMany({
                    where: { id: p.data.Id, user_id: userId },
                    data: {
                        ...(p.data.Name !== undefined ? { name: p.data.Name } : {}),
                        ...(p.data.Description !== undefined ? { description: p.data.Description } : {}),
                    },
                });
                if (r.count === 0) return fail(action, 404, 'GroupNotFound', `素材组不存在: ${p.data.Id}`);
                return ok(action, {});
            }
            case 'DeleteAssetGroup': {
                const p = idSchema.safeParse(body);
                if (!p.success) return fail(action, 400, 'InvalidParameter', 'Id 必填');
                const g = await prisma.enterpriseAssetGroup.findFirst({
                    where: { id: p.data.Id, user_id: userId },
                    select: { id: true },
                });
                if (!g) return fail(action, 404, 'GroupNotFound', `素材组不存在: ${p.data.Id}`);
                // 删组只解除成员引用,不删素材(对标网关「同步清理归属记录」语义的安全版)
                await prisma.$transaction([
                    prisma.enterpriseAsset.updateMany({ where: { group_id: g.id }, data: { group_id: null } }),
                    prisma.enterpriseAssetGroup.delete({ where: { id: g.id } }),
                ]);
                return ok(action, {});
            }
            case 'ListAssetGroups': {
                const p = listGroupsSchema.safeParse(body);
                if (!p.success) return fail(action, 400, 'InvalidParameter', p.error.issues[0]?.message || 'invalid');
                const [total, items] = await Promise.all([
                    prisma.enterpriseAssetGroup.count({ where: { user_id: userId } }),
                    prisma.enterpriseAssetGroup.findMany({
                        where: { user_id: userId },
                        orderBy: { created_at: 'desc' },
                        skip: (p.data.PageNumber - 1) * p.data.PageSize,
                        take: p.data.PageSize,
                    }),
                ]);
                return ok(action, {
                    Items: items.map(groupResult),
                    Total: total,
                    PageNumber: p.data.PageNumber,
                    PageSize: p.data.PageSize,
                });
            }
            // ── 真人视觉认证(「火山」渠道,翻译到新 provider REST;不计费)──────────
            case 'CreateVisualValidateSession': {
                // 客户端 body 含 CallbackURL/ProjectName,上游 /sessions 无入参,忽略之
                const s = await createVisualValidateSession();
                return ok(action, {
                    BytedToken: s.bytedToken,
                    H5Link: s.h5Link,
                    ...(s.expiresIn !== undefined ? { ExpiresIn: s.expiresIn } : {}),
                });
            }
            case 'GetVisualValidateResult': {
                const p = z.object({ BytedToken: z.string().trim().min(1).max(200) }).safeParse(body);
                if (!p.success) return fail(action, 400, 'InvalidParameter', 'BytedToken 必填');
                const groupId = await getVisualValidateGroupId(p.data.BytedToken);
                return ok(action, { GroupId: groupId });
            }
            default:
                return fail(action, 400, 'InvalidAction', `不支持的 Action: ${action}`);
        }
    } catch (e) {
        if (e instanceof RealPersonError) return fail(action, e.status, e.code, e.message);
        if (e instanceof AssetError) return fail(action, e.status, e.code, e.message);
        console.error('[asset-api] internal error', action, e);
        return fail(action, 500, 'InternalError', 'internal error');
    }
}
