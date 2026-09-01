/**
 * 「火山」渠道素材库 —— 上游 = 筷子 AI 开放平台私域素材库(2026-08-17)。
 *
 * 筷子的素材库与火山方舟官方 Assets API **1:1 对齐**(Action 风格单入口 + ResponseMetadata/
 * Result 信封 + PascalCase 字段),而我们对客的 /api Action 面本来就是同一套契约 ——
 * 所以本模块几乎是「拆信封 + 转发」,不做字段翻译:
 *   POST {BASE}/ai-open-platform-api/api/support/v1/asset?Action=<Action>&Version=2024-01-01
 *   鉴权 `ApiKey: kz-…` 自定义请求头(**不是** Bearer —— 视频面才是 Bearer)
 *
 * 【默认启用】(operator 2026-08-17 拍板:火山渠道就是给**单个客户**用的)——
 * volc 渠道客户的 10 个素材 Action 转发到筷子自有素材库,与视频面同一个筷子账号自洽
 * (`asset://<Id>` 引用上游能直接解析,不必经我们转 R2 直链)。
 * 非 volc 渠道(cn / global / promax)不受影响,照旧走平台素材库(assets.ts,字节存我们
 * R2 + user_id 行级归属,2026-08-06 拍板的统一托管)。
 *
 * ⚠️ 关掉的开关:`ENTERPRISE_KUAIZI_ASSETS=0`(回落平台素材库)。**要关的唯一场景 = 火山
 * 渠道接入第二个客户** —— 筷子素材库按 **ApiKey 账号** 归属,我们全平台共用一把 key,
 * 多个 volc 客户会**互相可见**,没有 user_id 行级隔离。单客户独占时这不是问题。
 *
 * 其余取舍(已知,单客户场景可接受):
 *  - volc 客户此前存在平台库(R2)的素材不会出现在列表里(两套库各自独立);按 Id 操作
 *    也不会回落平台库 —— 存量素材需重新上传到筷子侧。
 *  - 素材 URL 是筷子签名链,约 12h 过期(平台库是永久 R2 直链)→ 客户脚本别缓存 URL,
 *    用时现查 GetAsset。
 *  - CreateAsset 是**异步**的:落库即返 Id,需轮询 GetAsset 到 `Status=Active` 才可用。
 *
 * 关掉后,volc 生成里的 `asset://<id>` 走 proxy 的 lenient 混合解析:平台库素材换 R2 直链,
 * 认不出的引用整串透传给上游解析 —— 所以客户在筷子侧自建的素材 id 那时也仍然能用。
 */
import 'server-only';
import { z } from 'zod';
import { RealPersonError } from './real-person';

const DEFAULT_BASE = 'https://aiopenapi.kuaizi.cn';
const ASSET_PATH = '/ai-open-platform-api/api/support/v1/asset';
const VERSION = '2024-01-01';

/** 是否启用筷子素材库接管(**缺省开**;`ENTERPRISE_KUAIZI_ASSETS=0` 才回落平台库)。
 *  见文件头:要关的唯一场景是火山渠道接入第二个客户(共享 ApiKey 账号无行级隔离)。 */
export function kuaiziAssetsEnabled(): boolean {
    return process.env.ENTERPRISE_KUAIZI_ASSETS !== '0';
}

function getConfig(): { base: string; key: string } {
    const key = process.env.ENTERPRISE_KUAIZI_KEY;
    if (!key) throw new RealPersonError(503, 'ServiceUnavailable', '火山渠道素材库未配置,请联系服务方');
    return { base: (process.env.ENTERPRISE_KUAIZI_BASE_URL || DEFAULT_BASE).replace(/\/$/, ''), key };
}

interface KuaiziEnvelope<T> {
    ResponseMetadata?: { RequestId?: string; Error?: { Code?: string; Message?: string } };
    Result?: T;
}

/** 调一个 Action。失败抛 RealPersonError(route 层统一映射成火山 Error 信封)。 */
async function call<T>(action: string, body: Record<string, unknown>): Promise<T> {
    const { base, key } = getConfig();
    let res: Response;
    try {
        res = await fetch(`${base}${ASSET_PATH}?Action=${encodeURIComponent(action)}&Version=${VERSION}`, {
            method: 'POST',
            headers: { ApiKey: key, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
        });
    } catch (e) {
        console.warn('[kuaizi-assets] unreachable', { action, err: String(e) });
        throw new RealPersonError(503, 'ServiceUnavailable', '素材库上游暂时不可达,请稍后重试');
    }
    let j: KuaiziEnvelope<T>;
    try {
        j = (await res.json()) as KuaiziEnvelope<T>;
    } catch {
        throw new RealPersonError(502, 'UpstreamError', `素材库上游返回非 JSON(HTTP ${res.status})`);
    }
    const upErr = j.ResponseMetadata?.Error;
    if (upErr?.Code || !res.ok) {
        // 401 = 我们的平台凭证问题,不是客户的错 —— 不把上游文案原样抛给客户。
        if (res.status === 401) {
            console.error('[kuaizi-assets] upstream auth failed (platform credential)', { action });
            throw new RealPersonError(502, 'UpstreamError', '素材库上游鉴权失败(平台凭证问题),请联系服务方');
        }
        console.warn('[kuaizi-assets] action failed', { action, status: res.status, code: upErr?.Code });
        throw new RealPersonError(
            res.status >= 400 ? res.status : 400,
            upErr?.Code || 'AssetOperationFailed',
            upErr?.Message || '素材操作失败',
        );
    }
    return (j.Result ?? {}) as T;
}

// ── 入参 zod(与平台库 /api 面同名同形,客户脚本无感)────────────────────────────
const idSchema = z.object({ Id: z.string().trim().min(1).max(80) });
const createAssetSchema = z.object({
    GroupId: z.string().trim().min(1).max(80),
    URL: z.string().trim().min(1).max(2000),
    AssetType: z
        .string()
        .transform((s) => s.toLowerCase())
        .pipe(z.enum(['image', 'video', 'audio']))
        .transform((s) => ({ image: 'Image', video: 'Video', audio: 'Audio' })[s]),
    Name: z.string().trim().min(1).max(64).optional(),
});
const updateAssetSchema = idSchema.extend({ Name: z.string().trim().min(1).max(64) });
const createGroupSchema = z.object({
    Name: z.string().trim().min(1).max(64),
    Description: z.string().trim().max(300).optional(),
    // 上游当前仅支持 AIGC,传其它值它会报错 —— 我们前置挡掉,给清晰文案。
    GroupType: z.literal('AIGC').default('AIGC'),
});
const updateGroupSchema = idSchema.extend({
    Name: z.string().trim().min(1).max(64).optional(),
    Description: z.string().trim().max(300).optional(),
});
const pageSchema = {
    PageNumber: z.coerce.number().int().min(1).default(1),
    PageSize: z.coerce.number().int().min(1).max(100).default(20),
};
const listAssetsSchema = z.object({
    // 兼容平铺 GroupId(平台库面支持);上游只认 Filter.GroupIds 数组。
    GroupId: z.string().trim().max(80).optional(),
    Filter: z
        .object({
            GroupIds: z.array(z.string().trim().max(80)).max(50).optional(),
            Statuses: z
                .array(z.enum(['Active', 'Processing', 'Failed']))
                .max(10)
                .optional(),
            Name: z.string().trim().max(64).optional(),
        })
        .optional(),
    ...pageSchema,
});
const listGroupsSchema = z.object({
    Filter: z
        .object({ Name: z.string().trim().max(64).optional(), GroupType: z.literal('AIGC').optional() })
        .optional(),
    ...pageSchema,
});

function badParam(err: z.ZodError): never {
    const msg = err.issues.map((i) => `${i.path?.length ? i.path.join('.') : 'body'}: ${i.message}`).join('\n');
    throw new RealPersonError(400, 'InvalidParameter', msg || '参数校验失败');
}

/** 上游分页 Result → 我们对客的分页形(平台库面用 Total,上游用 TotalCount)。 */
interface UpstreamPage<T> {
    Items?: T[];
    TotalCount?: number;
    PageNumber?: number;
    PageSize?: number;
}
function pageResult<T>(d: UpstreamPage<T>, fallbackPage: number, fallbackSize: number) {
    return {
        Items: d.Items ?? [],
        Total: d.TotalCount ?? 0,
        PageNumber: d.PageNumber ?? fallbackPage,
        PageSize: d.PageSize ?? fallbackSize,
    };
}

/** volc 素材库 Action 分发。返回火山 Result 对象(route 层包信封);失败抛 RealPersonError。 */
export async function handleKuaiziAssetAction(action: string, body: unknown): Promise<unknown> {
    switch (action) {
        case 'CreateAssetGroup': {
            const p = createGroupSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            const d = await call<{ Id?: string }>('CreateAssetGroup', {
                Name: p.data.Name,
                GroupType: p.data.GroupType,
                ...(p.data.Description !== undefined ? { Description: p.data.Description } : {}),
            });
            return { Id: d.Id };
        }
        case 'ListAssetGroups': {
            const p = listGroupsSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            const d = await call<UpstreamPage<unknown>>('ListAssetGroups', {
                PageNumber: p.data.PageNumber,
                PageSize: p.data.PageSize,
                ...(p.data.Filter ? { Filter: p.data.Filter } : {}),
            });
            return pageResult(d, p.data.PageNumber, p.data.PageSize);
        }
        case 'GetAssetGroup': {
            const p = idSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            return call<unknown>('GetAssetGroup', { Id: p.data.Id });
        }
        case 'UpdateAssetGroup': {
            const p = updateGroupSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            await call('UpdateAssetGroup', {
                Id: p.data.Id,
                ...(p.data.Name !== undefined ? { Name: p.data.Name } : {}),
                ...(p.data.Description !== undefined ? { Description: p.data.Description } : {}),
            });
            return { Id: p.data.Id };
        }
        case 'DeleteAssetGroup': {
            const p = idSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            await call('DeleteAssetGroup', { Id: p.data.Id });
            return {};
        }
        case 'CreateAsset': {
            const p = createAssetSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            const d = await call<{ Id?: string }>('CreateAsset', {
                GroupId: p.data.GroupId,
                URL: p.data.URL,
                AssetType: p.data.AssetType,
                ...(p.data.Name !== undefined ? { Name: p.data.Name } : {}),
            });
            // 上游 CreateAsset 是异步的:落库即返 Id,素材需轮询 GetAsset 到 Status=Active。
            return { Id: d.Id };
        }
        case 'ListAssets': {
            const p = listAssetsSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            const groupIds = p.data.Filter?.GroupIds ?? (p.data.GroupId ? [p.data.GroupId] : undefined);
            const filter = {
                ...(groupIds ? { GroupIds: groupIds } : {}),
                ...(p.data.Filter?.Statuses ? { Statuses: p.data.Filter.Statuses } : {}),
                ...(p.data.Filter?.Name ? { Name: p.data.Filter.Name } : {}),
            };
            const d = await call<UpstreamPage<unknown>>('ListAssets', {
                PageNumber: p.data.PageNumber,
                PageSize: p.data.PageSize,
                ...(Object.keys(filter).length ? { Filter: filter } : {}),
            });
            return pageResult(d, p.data.PageNumber, p.data.PageSize);
        }
        case 'GetAsset': {
            const p = idSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            return call<unknown>('GetAsset', { Id: p.data.Id });
        }
        case 'UpdateAsset': {
            const p = updateAssetSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            await call('UpdateAsset', { Id: p.data.Id, Name: p.data.Name });
            return { Id: p.data.Id };
        }
        case 'DeleteAsset': {
            const p = idSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            await call('DeleteAsset', { Id: p.data.Id });
            return {};
        }
        default:
            throw new RealPersonError(400, 'InvalidAction', `不支持的 Action: ${action}`);
    }
}

/**
 * volc 客户的这次素材 Action 该不该走筷子?(route 层分流,沿用 #328 的 id 命名空间规则)
 *
 * 缺省走筷子,但三种情况回落平台素材库 —— 否则会打断既有能力:
 *  ① **真人素材**(显式 `GroupType=LivenessFace`,顶层或 Filter 内):真人素材四渠道通用、
 *    平台托管(#329),且筷子只支持 AIGC 组 —— 转过去必 400,真人认证线会断。
 *  ② **平台形 Id**(`asset-…` / `group-…`):volc 客户的存量平台素材按 Id 仍可 CRUD;
 *    筷子 Id 是十进制数字串,两者天然可辨(#328 同款判据)。
 *  ③ **CreateAsset 指定了平台形 GroupId**:往存量平台组里加素材,跟着组走。
 */
export function shouldUseKuaiziAssets(action: string, body: unknown): boolean {
    if (!KUAIZI_ASSET_ACTIONS.has(action)) return false;
    const b = (body ?? {}) as {
        GroupType?: unknown;
        Filter?: { GroupType?: unknown };
        Id?: unknown;
        GroupId?: unknown;
    };
    if (b.GroupType === 'LivenessFace' || b.Filter?.GroupType === 'LivenessFace') return false;
    if (isPlatformAssetId(b.Id) || isPlatformAssetId(b.GroupId)) return false;
    return true;
}

/** 平台库 id 形(`asset-YYYYMMDDHHMMSS-xxxxxx` / `group-…`);筷子 id 是纯十进制串。 */
function isPlatformAssetId(v: unknown): boolean {
    return typeof v === 'string' && (v.startsWith('asset-') || v.startsWith('group-'));
}

/** 筷子素材库接管的 Action 集合(route 层据此在 volc 客户上分流)。 */
export const KUAIZI_ASSET_ACTIONS = new Set([
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
