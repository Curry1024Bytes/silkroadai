/**
 * 「火山」渠道素材库(2026-07-29,Phase 2b)。
 *
 * volc 客户的素材库不走我们 R2,而是走 provider 自有 REST 素材库(与真人认证同 provider
 * 同 key,`ENTERPRISE_REALPERSON_*`)—— 这样真人认证产出的 GroupId、上传的真人素材、以及
 * volc 视频(asset://id 引用)全在【同一个 provider 账号】内自洽,解跨账号不互认。
 *
 * 客户用火山 Action 风格(CreateAsset / ListAssets / …)调我们 /api;本模块把每个 Action
 * 翻译到 provider REST(`/api/v1/asset*` / `/api/v1/asset-group*`),响应映射回火山
 * `Result` 形(字段名对齐我们非-volc 路径,客户脚本无感)。素材 URL = provider 返的真火山
 * 直链,原样透传。
 *
 * provider 包 {requestId, code, message, data},code=0 成功;失败(code=1 / HTTP 4xx)
 * → RealPersonError(复用真人认证的错误类型,route 层统一映射火山 Error envelope)。
 */
import 'server-only';
import { z } from 'zod';
import { RealPersonError } from './real-person';

function getConfig(): { base: string; key: string } {
    const base = process.env.ENTERPRISE_REALPERSON_BASE_URL;
    const key = process.env.ENTERPRISE_REALPERSON_KEY;
    if (!base || !key) throw new RealPersonError(503, 'ServiceUnavailable', '火山渠道素材库未配置,请联系服务方');
    return { base: base.replace(/\/$/, ''), key };
}

interface ProviderEnvelope<T> {
    requestId?: string;
    code?: number;
    message?: string;
    data?: T;
}

async function call<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const { base, key } = getConfig();
    let res: Response;
    try {
        res = await fetch(`${base}${path}`, {
            method,
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
        });
    } catch (e) {
        throw new RealPersonError(503, 'ServiceUnavailable', `火山素材库上游不可达: ${String(e)}`);
    }
    let j: ProviderEnvelope<T>;
    try {
        j = (await res.json()) as ProviderEnvelope<T>;
    } catch {
        throw new RealPersonError(502, 'UpstreamError', `火山素材库上游返回非 JSON(HTTP ${res.status})`);
    }
    if (res.status === 401) throw new RealPersonError(502, 'UpstreamError', '火山素材库上游鉴权失败(平台凭证问题)');
    if (j.code !== 0) {
        // provider 业务错误(素材组不存在 / 媒体校验失败等)原样透传 message
        const status = res.status >= 400 ? res.status : res.status === 200 ? 400 : res.status;
        throw new RealPersonError(status, 'AssetOperationFailed', j.message || '素材操作失败');
    }
    return j.data as T;
}

// ── 火山 Action 入参 zod(与非-volc /api 路径共用命名习惯:PascalCase)──────────────
const createAssetSchema = z.object({
    AssetType: z.enum(['Image', 'Video', 'Audio']),
    URL: z.string().min(1).max(2000),
    Name: z.string().trim().min(1).max(64),
    GroupId: z.string().trim().min(1).max(80),
});
const idSchema = z.object({ Id: z.string().trim().min(1).max(80) });
const listAssetsSchema = z.object({
    GroupId: z.string().trim().max(80).optional(),
    // 火山官方 Filter 包(客户脚本用 Filter:{GroupIds, GroupType, Statuses});也兼容平铺 GroupId
    Filter: z
        .object({
            GroupIds: z.array(z.string()).optional(),
            GroupType: z.string().optional(),
            Statuses: z.array(z.string()).optional(),
        })
        .optional(),
    PageNumber: z.coerce.number().int().min(1).default(1),
    PageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const createGroupSchema = z.object({
    Name: z.string().trim().min(1).max(64),
    Description: z.string().trim().max(300).optional(),
});
const updateGroupSchema = idSchema.extend({
    Name: z.string().trim().min(1).max(64).optional(),
    Description: z.string().trim().max(300).nullable().optional(),
});
const listGroupsSchema = z.object({
    Filter: z.object({ GroupIds: z.array(z.string()).optional(), GroupType: z.string().optional() }).optional(),
    PageNumber: z.coerce.number().int().min(1).default(1),
    PageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// ── provider 响应字段 → 火山 Result 形映射 ────────────────────────────────────────
interface ProviderAsset {
    assetId: string;
    groupId: string;
    assetName: string;
    assetType: string;
    assetUrl: string;
    status: string;
    createdTime?: string;
}
interface ProviderGroup {
    groupId: string;
    groupType?: string;
    groupName: string;
    description?: string;
    createdTime?: string;
}
const assetResult = (a: ProviderAsset) => ({
    Id: a.assetId,
    GroupId: a.groupId,
    Name: a.assetName,
    AssetType: a.assetType,
    URL: a.assetUrl, // 火山直链原样透传
    Status: a.status,
    CreatedAt: a.createdTime,
});
const groupResult = (g: ProviderGroup) => ({
    Id: g.groupId,
    Name: g.groupName,
    GroupType: g.groupType,
    Description: g.description,
    CreatedAt: g.createdTime,
});

function badParam(): never {
    throw new RealPersonError(400, 'InvalidParameter', '参数校验失败');
}

/** volc 素材库 Action 分发。返回火山 Result 对象(route 层包 envelope);失败抛 RealPersonError。 */
export async function handleVolcAssetAction(action: string, body: unknown): Promise<unknown> {
    switch (action) {
        case 'CreateAssetGroup': {
            const p = createGroupSchema.safeParse(body);
            if (!p.success) badParam();
            const d = await call<ProviderGroup>('POST', '/api/v1/asset-group', {
                groupName: p.data.Name,
                ...(p.data.Description !== undefined ? { description: p.data.Description } : {}),
            });
            return { Id: d.groupId };
        }
        case 'ListAssetGroups': {
            const p = listGroupsSchema.safeParse(body);
            if (!p.success) badParam();
            const d = await call<{ result: ProviderGroup[]; total: number; pageNo: number; pageSize: number }>(
                'POST',
                '/api/v1/asset-group/query',
                {
                    pageNo: p.data.PageNumber,
                    pageSize: p.data.PageSize,
                    ...(p.data.Filter?.GroupIds ? { groupIds: p.data.Filter.GroupIds } : {}),
                    ...(p.data.Filter?.GroupType ? { groupType: p.data.Filter.GroupType } : {}),
                },
            );
            return {
                Items: (d.result ?? []).map(groupResult),
                Total: d.total,
                PageNumber: d.pageNo,
                PageSize: d.pageSize,
            };
        }
        case 'GetAssetGroup': {
            const p = idSchema.safeParse(body);
            if (!p.success) badParam();
            const d = await call<ProviderGroup>('GET', `/api/v1/asset-group/${encodeURIComponent(p.data.Id)}`);
            return groupResult(d);
        }
        case 'UpdateAssetGroup': {
            const p = updateGroupSchema.safeParse(body);
            if (!p.success) badParam();
            await call('PUT', `/api/v1/asset-group/${encodeURIComponent(p.data.Id)}`, {
                ...(p.data.Name !== undefined ? { groupName: p.data.Name } : {}),
                ...(p.data.Description !== undefined ? { description: p.data.Description } : {}),
            });
            return {};
        }
        case 'DeleteAssetGroup': {
            const p = idSchema.safeParse(body);
            if (!p.success) badParam();
            await call('DELETE', `/api/v1/asset-group/${encodeURIComponent(p.data.Id)}`);
            return {};
        }
        case 'CreateAsset': {
            const p = createAssetSchema.safeParse(body);
            if (!p.success) badParam();
            const d = await call<string>('POST', '/api/v1/asset', {
                groupId: p.data.GroupId,
                assetUrl: p.data.URL,
                assetType: p.data.AssetType,
                assetName: p.data.Name,
            });
            // provider CreateAsset data 为 assetId 字符串(素材处理中,status=PROCESSING)
            return { Id: d, Status: 'PROCESSING' };
        }
        case 'ListAssets': {
            const p = listAssetsSchema.safeParse(body);
            if (!p.success) badParam();
            const groupIds = p.data.Filter?.GroupIds ?? (p.data.GroupId ? [p.data.GroupId] : undefined);
            const d = await call<{ result: ProviderAsset[]; total: number; pageNo: number; pageSize: number }>(
                'POST',
                '/api/v1/asset/query',
                {
                    pageNo: p.data.PageNumber,
                    pageSize: p.data.PageSize,
                    ...(groupIds ? { groupIds } : {}),
                    ...(p.data.Filter?.GroupType ? { groupType: p.data.Filter.GroupType } : {}),
                    ...(p.data.Filter?.Statuses ? { statuses: p.data.Filter.Statuses } : {}),
                },
            );
            return {
                Items: (d.result ?? []).map(assetResult),
                Total: d.total,
                PageNumber: d.pageNo,
                PageSize: d.pageSize,
            };
        }
        case 'GetAsset': {
            const p = idSchema.safeParse(body);
            if (!p.success) badParam();
            const d = await call<ProviderAsset>('GET', `/api/v1/asset/${encodeURIComponent(p.data.Id)}`);
            return assetResult(d);
        }
        case 'UpdateAsset': {
            const p = idSchema.extend({ Name: z.string().trim().min(1).max(64) }).safeParse(body);
            if (!p.success) badParam();
            await call('PUT', `/api/v1/asset/${encodeURIComponent(p.data.Id)}`, { assetName: p.data.Name });
            return {};
        }
        case 'DeleteAsset': {
            const p = idSchema.safeParse(body);
            if (!p.success) badParam();
            await call('DELETE', `/api/v1/asset/${encodeURIComponent(p.data.Id)}`);
            return {};
        }
        default:
            throw new RealPersonError(400, 'InvalidAction', `不支持的 Action: ${action}`);
    }
}

/** volc 素材库接管的 Action 集合(route 层据此在 volc 客户上分流)。 */
export const VOLC_ASSET_ACTIONS = new Set([
    'CreateAsset',
    'GetAsset',
    'UpdateAsset',
    'DeleteAsset',
    'ListAssets',
    'CreateAssetGroup',
    'GetAssetGroup',
    'UpdateAssetGroup',
    'DeleteAssetGroup',
    'ListAssetGroups',
]);
