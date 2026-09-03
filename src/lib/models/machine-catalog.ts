/**
 * 机器可读模型目录(借鉴 OpenRouter `/api/v1/models` 模式)。
 *
 * 客户今天从 `GET /v1/models` 只拿到裸 OpenAI 列表(id/object/created/owned_by),
 * 价格、模态、能力全要人肉翻网页。本模块给代理层的 /models 拦截提供增强数据:
 * 每个条目追加一个 `silkroadai` 命名空间字段(display_name / vendor / type /
 * vision / context_window / 按客户档次解析的 ¥ 价格)。OpenAI SDK 对未知字段
 * 自动忽略 → 存量客户端零影响;工具链(litellm、网关、比价脚本)可编程发现。
 *
 * 设计约束:
 *  - 【只加不减】:上游列表的条目集合、已有字段、顺序全部原样(HIDDEN_MODELS
 *    也不从这里剔除 —— 它们仍可调用,denylist 只管 portal 页面/picker 展示);
 *  - 【best-effort】:目录/档次任何一步失败,调用方回退原字节透传,绝不打断
 *    客户请求(镜像 quota-cache / oss-store 的降级哲学);
 *  - 价格【只给精确档次命中】:客户档(NewApiToken.tier,即 ChannelGroup.key /
 *    CatalogPrice.tier 的 key 空间)没定价的模型 pricing=null,不回退别档 ——
 *    错价比没价危害大。
 */
import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { categorizeByType, categorizeByVendor, type TypeName, type VendorName } from '@/lib/models/categorize';

export interface TierPricing {
    /** ¥ / 1M input tokens(chat 类);image 模型为 null */
    input_cny_per_1m: number | null;
    /** ¥ / 1M output tokens */
    output_cny_per_1m: number | null;
    /** ¥ / 张(生图模型按张计价) */
    per_image_cny: number | null;
}

export interface CatalogMetaEntry {
    display_name: string;
    context_window: number | null;
    /** dynamic ChannelGroup.key → 该档最新价(effective_from 最新的一版) */
    pricesByTier: Map<string, TierPricing>;
}

/** 客户条目上的命名空间扩展字段(JSON 输出形)。
 *  ⚠️ `type` 是 portal 全站统一的【展示分类】(与 /models 页、chat picker 同一套
 *  categorize 规则):具备视觉能力的对话旗舰归 'vision' 而非 'chat' —— 按
 *  type==='chat' 过滤会漏掉它们。判断「能不能对话」用 type ∈ {chat, vision},
 *  判断「收不收图」用布尔 `vision`(能力位)。 */
export interface SilkroadaiModelExtra {
    display_name?: string;
    vendor: VendorName;
    type: TypeName;
    vision: boolean;
    context_window?: number;
    /** 本响应价格对应的档次(= 请求 key 的档) */
    tier: string;
    /** 该档无定价 → null(不回退别档) */
    pricing: TierPricing | null;
}

const META_TTL_MS = 60_000;
let metaCache: { at: number; map: Map<string, CatalogMetaEntry> } | null = null;

/** 测试用:清模块级缓存。 */
export function resetCatalogMetaCacheForTests(): void {
    metaCache = null;
}

const toNum = (d: unknown): number | null => (d == null ? null : Number(d));

/**
 * 目录元数据(slug → display_name/context_window/分档最新价),60s 模块缓存
 * (镜像 model-groups 的 TTL 做法;/models 调用频率低,DB 压力可忽略)。
 */
export async function loadCatalogMeta(): Promise<Map<string, CatalogMetaEntry>> {
    if (metaCache && Date.now() - metaCache.at < META_TTL_MS) return metaCache.map;
    const rows = await prisma.catalogModel.findMany({
        // ⚠️ 必须锁平台主体:slug 仅在 tenant 内唯一(@@unique([tenant_id, slug])),
        // P6c 白标 tenant 自定价上线后,不过滤会让 tenant 行按 slug 随机覆盖平台行 →
        // 平台客户看到别人的价(billing meter.ts 全部按 tenant 过滤,这里同标准)。
        where: { enabled: true, tenant_id: PLATFORM_TENANT_ID },
        // 只取已生效的价(effective_from ≤ now):与计费侧 pickEffectivePrice 对齐,
        // 未来定的排期价不能提前登在目录上(目录说 A 价、账单扣 B 价 = 事故)。
        include: {
            prices: {
                where: { effective_from: { lte: new Date() } },
                orderBy: { effective_from: 'desc' },
            },
        },
    });
    const map = new Map<string, CatalogMetaEntry>();
    for (const row of rows) {
        const pricesByTier = new Map<string, TierPricing>();
        const upstreamMap =
            row.upstream_map && typeof row.upstream_map === 'object' && !Array.isArray(row.upstream_map)
                ? (row.upstream_map as Record<string, unknown>)
                : {};
        // prices 已按 effective_from 降序 → 每个 tier 第一条 = 现行价
        for (const p of row.prices) {
            if (!Object.hasOwn(upstreamMap, p.tier)) continue; // 历史价不等于当前仍可路由
            if (pricesByTier.has(p.tier)) continue;
            pricesByTier.set(p.tier, {
                input_cny_per_1m: toNum(p.input_cny_per_1m),
                output_cny_per_1m: toNum(p.output_cny_per_1m),
                per_image_cny: toNum(p.per_image_cny),
            });
        }
        map.set(row.slug, {
            display_name: row.display_name,
            context_window: row.context_window ?? null,
            pricesByTier,
        });
    }
    metaCache = { at: Date.now(), map };
    return map;
}

/**
 * 从 Authorization 头解析客户档次:sk- → NewApiToken.tier。
 * 查不到(system token / 未知 key / 无头)就失败关闭,由调用方整体回退原始
 * new-api payload。价格缺失比展示错误档次的价格安全。
 */
export async function resolveTierFromAuthHeader(authHeader: string | null): Promise<string> {
    const m = authHeader?.match(/^Bearer\s+(.+)$/i);
    if (!m) throw new Error('cannot resolve catalog tier without a bearer token');
    const raw = m[1].startsWith('sk-') ? m[1].slice(3) : m[1];
    if (!raw) throw new Error('cannot resolve catalog tier from an empty bearer token');
    const token = await prisma.newApiToken.findUnique({
        where: { newapi_token_value: raw },
        select: { tier: true },
    });
    if (!token) throw new Error('bearer token is not a Portal customer token');
    return token.tier;
}

/**
 * 纯函数:OpenAI 模型列表 payload → 每个条目追加 `silkroadai` 字段。
 * 上游条目集合/字段/顺序原样;形状不符(data 非数组等)直接抛,调用方回退透传。
 */
export function enrichModelList(
    payload: Record<string, unknown>,
    tier: string,
    meta: Map<string, CatalogMetaEntry>,
): Record<string, unknown> {
    const data = payload.data;
    if (!Array.isArray(data)) throw new Error('model list payload has no data array');
    const enriched = data.map((entry) => {
        if (!entry || typeof entry !== 'object' || typeof (entry as Record<string, unknown>).id !== 'string') {
            return entry; // 形状怪的条目原样保留
        }
        const id = (entry as Record<string, unknown>).id as string;
        const cat = meta.get(id);
        const type = categorizeByType(id);
        const extra: SilkroadaiModelExtra = {
            ...(cat ? { display_name: cat.display_name } : {}),
            vendor: categorizeByVendor(id),
            type,
            vision: type === 'vision',
            ...(cat?.context_window != null ? { context_window: cat.context_window } : {}),
            tier,
            pricing: cat?.pricesByTier.get(tier) ?? null,
        };
        return { ...(entry as Record<string, unknown>), silkroadai: extra };
    });
    return { ...payload, data: enriched };
}
