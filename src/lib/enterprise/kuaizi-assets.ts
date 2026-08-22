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
import { rememberVolcId, toUpstreamId, toUpstreamIds, toVendorId } from './volc-id-map';

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

/**
 * 上游错误 → 对客错误。做两件事:**归一到火山官方口径** + **剥掉内部细节**。
 *
 * 上游对「资源不存在」返的是:
 *   HTTP 500  Code=InternalError
 *   Message="get asset failed: rpc error: code = NotFound desc = asset not found: id=192612151255367695"
 * 三处不合格:
 *  ① 状态码错 —— 火山官方对不存在的资源返 404,不是 500。500 还会让客户的重试逻辑
 *    误判成「服务端故障可重试」,实际是终态,白重试。
 *  ② 错误码错 —— InternalError 不是「不存在」的语义;平台素材库面用的是
 *    AssetNotFound / GroupNotFound(见 app/api/route.ts),volc 面必须同口径。
 *  ③ **泄露上游内部 id**(`id=192612151255367695` 是上游的十进制号)——
 *    #398 刚把对客 id 全换成火山号,错误信息又把上游号漏出去,等于白做(#271)。
 *
 * 2026-08-22 客户实测报障:删素材 / 删组后再查,拿到 500 而非 404。
 */
function mapUpstreamError(
    action: string,
    status: number,
    code: string | undefined,
    message: string | undefined,
    clientId?: string,
): RealPersonError {
    const raw = message || '';
    const isGroup = action.includes('Group');
    // NotFound 语义:上游同时出现在 gRPC code 与文案里,两种都认。
    if (/not\s*found/i.test(raw) || /notfound/i.test(code || '')) {
        const what = isGroup ? '素材组' : '素材';
        return new RealPersonError(
            404,
            isGroup ? 'GroupNotFound' : 'AssetNotFound',
            `${what}不存在${clientId ? `: ${clientId}` : ''}`,
        );
    }
    // 其余:剥掉 rpc 内部串与上游内部 id 再对客(#271)。
    const clean = sanitizeUpstreamMessage(raw);
    if (status >= 500) {
        return new RealPersonError(502, 'UpstreamError', clean || '素材库上游暂时异常,请稍后重试');
    }
    return new RealPersonError(status >= 400 ? status : 400, code || 'AssetOperationFailed', clean || '素材操作失败');
}

/** 剥上游报错里的实现细节:gRPC 包装、内部十进制 id。 */
function sanitizeUpstreamMessage(raw: string): string {
    return raw
        .replace(/rpc error:.*?desc\s*=\s*/gi, '')
        .replace(/\bid=\d+/g, '')
        .replace(/\s*:\s*$/, '')
        .trim();
}

/** 调一个 Action。失败抛 RealPersonError(route 层统一映射成火山 Error 信封)。 */
async function call<T>(action: string, body: Record<string, unknown>, clientId?: string): Promise<T> {
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
        console.warn('[kuaizi-assets] action failed', {
            action,
            status: res.status,
            code: upErr?.Code,
            message: upErr?.Message,
        });
        throw mapUpstreamError(action, res.status, upErr?.Code, upErr?.Message, clientId);
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

// ── 火山原生 id 归一(2026-08-19)────────────────────────────────────────────────
//
// volc 卖的是「完全原生的火山体验」,所以对客只暴露【火山自己的号和链接】:
//   Id  ← VendorAssetId / VendorGroupId   (火山原生 id)
//   URL ← VendorAssetUrl                  (火山 TOS 签名链)
// 并把 Vendor* 三个键**撤掉** —— 火山官方响应里根本没有这些键,留着反而不原生。
//
// ⚠️ 为什么 URL 也要换:实测上游的 `URL` 字段是**客户创建时传入链接的原样回显**
//    (传 picsum.photos/512/512.jpg 进去,查回来还是它),并不指向已入库的素材本体;
//    真正能取到素材的只有 VendorAssetUrl(ark-media-asset.tos-cn-beijing.volces.com)。
//    所以这不只是「更原生」,是修一个残废字段。

/** 上游一行素材/组的原始形(只列我们要动的键)。 */
interface UpstreamRow {
    Id?: unknown;
    GroupId?: unknown;
    URL?: unknown;
    VendorAssetId?: unknown;
    VendorGroupId?: unknown;
    VendorAssetUrl?: unknown;
    [k: string]: unknown;
}

function str(v: unknown): string | undefined {
    return typeof v === 'string' && v ? v : undefined;
}

/**
 * 一行上游响应 → 对客原生形。同时把 (火山 id ↔ 上游 id) 回填进映射表(自愈)。
 *
 * 拿不到 vendor id 时**原样返回** —— 例如素材还在 Processing 早期、或本次改动之前
 * 建的存量行。客户拿到的仍是它本来就认识的那个号,不算倒退。
 */
async function nativeRow(row: UpstreamRow, kind: 'asset' | 'group', userId?: string): Promise<UpstreamRow> {
    const { VendorAssetId, VendorGroupId, VendorAssetUrl, ...rest } = row;
    const out: UpstreamRow = { ...rest };
    const upstreamId = str(row.Id);
    const vendorId = str(kind === 'asset' ? VendorAssetId : VendorGroupId);
    if (upstreamId && vendorId) {
        out.Id = vendorId;
        await rememberVolcId(vendorId, upstreamId, kind, userId);
    }
    const vendorUrl = str(VendorAssetUrl);
    if (vendorUrl) out.URL = vendorUrl;
    // 素材行上的 GroupId 也要回显成火山组号(整份响应里不能混两套命名空间)。
    const groupUpstream = str(row.GroupId);
    if (groupUpstream) out.GroupId = await toVendorId(groupUpstream);
    return out;
}

/** 列表 Result 逐行原生化。 */
async function nativePage<T extends UpstreamRow>(
    d: UpstreamPage<T>,
    kind: 'asset' | 'group',
    fallbackPage: number,
    fallbackSize: number,
    userId?: string,
) {
    const base = pageResult(d, fallbackPage, fallbackSize);
    return { ...base, Items: await Promise.all(base.Items.map((it) => nativeRow(it, kind, userId))) };
}

/**
 * CreateAsset 后压住等火山 id 出现,拿到了再吐给客户。
 *
 * 上游 CreateAsset 是异步的,落库即返**上游 id**,火山 id(VendorAssetId)要等火山那边
 * 真正受理才有 —— 实测 ~7.5s,且 **Status 还是 Processing 时就已经有了**(上游文档写
 * 「素材到达终态后才有」不准)。既然对客承诺的是原生火山号,这段等待只能我们压着。
 *
 * 超时 → **报错**(operator 2026-08-19 拍板:宁可报错,也不吐一个非火山的号)。
 * 已知代价:上游那条素材已经建好了,报错后它变成孤儿,客户重试会重复建一条。
 */
const VENDOR_ID_POLL_MS = 1500;
function vendorWaitMs(): number {
    const raw = Number(process.env.ENTERPRISE_VOLC_VENDOR_WAIT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

async function waitForVendorAssetId(upstreamId: string): Promise<string> {
    const deadline = Date.now() + vendorWaitMs();
    let last: UpstreamRow = {};
    for (;;) {
        last = await call<UpstreamRow>('GetAsset', { Id: upstreamId });
        const vendorId = str(last.VendorAssetId);
        if (vendorId) return vendorId;
        // 素材已终态却仍无火山号 = 上游那边根本没受理成功,再等也不会有。
        if (last.Status === 'Failed') {
            throw new RealPersonError(502, 'AssetCreateFailed', '素材入库失败,请检查素材链接后重试');
        }
        if (Date.now() + VENDOR_ID_POLL_MS > deadline) {
            console.error('[kuaizi-assets] vendor asset id timeout (上游已建,对客报错 → 孤儿素材)', {
                upstreamId,
                status: last.Status,
                waitedMs: vendorWaitMs(),
            });
            throw new RealPersonError(504, 'AssetPending', '素材入库超时 —— 上游尚未返回素材编号,请稍后重新上传');
        }
        await new Promise((r) => setTimeout(r, VENDOR_ID_POLL_MS));
    }
}

/** volc 素材库 Action 分发。返回火山 Result 对象(route 层包信封);失败抛 RealPersonError。 */
export async function handleKuaiziAssetAction(action: string, body: unknown, userId?: string): Promise<unknown> {
    switch (action) {
        case 'CreateAssetGroup': {
            const p = createGroupSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            const d = await call<{ Id?: string; VendorGroupId?: string }>('CreateAssetGroup', {
                Name: p.data.Name,
                GroupType: p.data.GroupType,
                ...(p.data.Description !== undefined ? { Description: p.data.Description } : {}),
            });
            // 建组是【同步】渠道调用,火山组号创建即返回 —— 不必像 CreateAsset 那样压着等。
            const gUp = str(d.Id);
            const gVendor = str(d.VendorGroupId);
            if (!gUp) throw new RealPersonError(502, 'UpstreamError', '素材组创建失败(上游未返回编号)');
            if (!gVendor) {
                // 对客承诺的是火山原生号,拿不到就报错 —— 不吐一个非火山的号(2026-08-19 拍板)。
                console.error('[kuaizi-assets] CreateAssetGroup 未返回 VendorGroupId', { upstreamId: gUp });
                throw new RealPersonError(502, 'UpstreamError', '素材组创建失败(上游未返回火山编号),请重试');
            }
            await rememberVolcId(gVendor, gUp, 'group', userId);
            return { Id: gVendor };
        }
        case 'ListAssetGroups': {
            const p = listGroupsSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            const d = await call<UpstreamPage<UpstreamRow>>('ListAssetGroups', {
                PageNumber: p.data.PageNumber,
                PageSize: p.data.PageSize,
                ...(p.data.Filter ? { Filter: p.data.Filter } : {}),
            });
            return nativePage(d, 'group', p.data.PageNumber, p.data.PageSize, userId);
        }
        case 'GetAssetGroup': {
            const p = idSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            const g = await call<UpstreamRow>('GetAssetGroup', { Id: await toUpstreamId(p.data.Id) }, p.data.Id);
            return nativeRow(g, 'group', userId);
        }
        case 'UpdateAssetGroup': {
            const p = updateGroupSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            await call(
                'UpdateAssetGroup',
                {
                    Id: await toUpstreamId(p.data.Id),
                    ...(p.data.Name !== undefined ? { Name: p.data.Name } : {}),
                    ...(p.data.Description !== undefined ? { Description: p.data.Description } : {}),
                },
                p.data.Id,
            );
            return { Id: p.data.Id };
        }
        case 'DeleteAssetGroup': {
            const p = idSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            await call('DeleteAssetGroup', { Id: await toUpstreamId(p.data.Id) }, p.data.Id);
            return {};
        }
        case 'CreateAsset': {
            const p = createAssetSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            const d = await call<{ Id?: string }>('CreateAsset', {
                GroupId: await toUpstreamId(p.data.GroupId),
                URL: p.data.URL,
                AssetType: p.data.AssetType,
                ...(p.data.Name !== undefined ? { Name: p.data.Name } : {}),
            });
            const aUp = str(d.Id);
            if (!aUp) throw new RealPersonError(502, 'UpstreamError', '素材创建失败(上游未返回编号)');
            // 压住等火山素材号(实测 ~7.5s);拿到才吐给客户 —— 见 waitForVendorAssetId。
            const aVendor = await waitForVendorAssetId(aUp);
            await rememberVolcId(aVendor, aUp, 'asset', userId);
            return { Id: aVendor };
        }
        case 'ListAssets': {
            const p = listAssetsSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            const groupIdsRaw = p.data.Filter?.GroupIds ?? (p.data.GroupId ? [p.data.GroupId] : undefined);
            const groupIds = groupIdsRaw ? await toUpstreamIds(groupIdsRaw) : undefined;
            const filter = {
                ...(groupIds ? { GroupIds: groupIds } : {}),
                ...(p.data.Filter?.Statuses ? { Statuses: p.data.Filter.Statuses } : {}),
                ...(p.data.Filter?.Name ? { Name: p.data.Filter.Name } : {}),
            };
            const d = await call<UpstreamPage<UpstreamRow>>('ListAssets', {
                PageNumber: p.data.PageNumber,
                PageSize: p.data.PageSize,
                ...(Object.keys(filter).length ? { Filter: filter } : {}),
            });
            return nativePage(d, 'asset', p.data.PageNumber, p.data.PageSize, userId);
        }
        case 'GetAsset': {
            const p = idSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            const a = await call<UpstreamRow>('GetAsset', { Id: await toUpstreamId(p.data.Id) }, p.data.Id);
            return nativeRow(a, 'asset', userId);
        }
        case 'UpdateAsset': {
            const p = updateAssetSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            await call('UpdateAsset', { Id: await toUpstreamId(p.data.Id), Name: p.data.Name }, p.data.Id);
            return { Id: p.data.Id };
        }
        case 'DeleteAsset': {
            const p = idSchema.safeParse(body);
            if (!p.success) badParam(p.error);
            await call('DeleteAsset', { Id: await toUpstreamId(p.data.Id) }, p.data.Id);
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

/**
 * 是否【我们平台库】的 id。
 *
 * ⚠️ 不能只看 `asset-` / `group-` 前缀 —— 筷子的 **vendor id 跟我们撞前缀**:
 *   我们平台库   `asset-{14位时间戳}-{6位十六进制}`   (newAssetId: randomBytes(3).toString('hex'))
 *   筷子 vendor  `asset-{14位时间戳}-{5位字母数字}`   (实测 asset-20260819085202-247l9,含非 hex 字符)
 *   筷子平台 Id  纯十进制                              (191950112983875603)
 * 客户若把 VendorAssetId 当句柄传回来,只看前缀会把它误路由到平台库 → 404 且报错指错方向。
 * 故按【完整形态】匹配:只有 6 位十六进制后缀才算我们的。
 */
const PLATFORM_ASSET_ID = /^(?:asset|group)-\d{14}-[0-9a-f]{6}$/;
function isPlatformAssetId(v: unknown): boolean {
    return typeof v === 'string' && PLATFORM_ASSET_ID.test(v);
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
