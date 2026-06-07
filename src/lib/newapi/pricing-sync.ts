import 'server-only';
import { getChannel, updateChannel, getOption, putOption } from './client';
import { tierOrder } from '@/lib/admin/pricing-tiers';

/**
 * 定价 sync 专用 FX 常量 = 7。
 *
 * ⚠️ 与 quota-units.ts 的 USD_TO_CNY_RATE(默认 7.2,余额展示用)【故意不同】。
 * 定价 mr/cr 是业务决策(¥0.5/$1、¥1.5/$1 配 FX=7 得到干净的 ratio),沿用
 * scripts/apply-new-pricing-2026-05-21.* 实际在用的值(brief 1.2:FX / quota 以
 * 现有脚本为准,不要凭记忆写死)。改这个值会改变所有客户的 token 计费,慎动。
 */
export const PRICING_FX = 7;

export interface Ratios {
    model_ratio: number;
    completion_ratio: number;
}

/**
 * 把零售 ¥/1M 价折算成 new-api 的 model_ratio / completion_ratio。
 *
 *   model_ratio      = input_cny_per_1m / PRICING_FX
 *   completion_ratio = output_cny_per_1m / input_cny_per_1m(沿用官方 in/out 比例)
 *
 * 与现有脚本等价:脚本传 (official_USD × discount_cny),此处直接传零售 ¥(折扣已含),
 * 折扣在 cr 的分子分母里约掉,结果一致。例:
 *   gpt-5.4 零售 ¥2.5/¥10  → mr 0.357143, cr 4
 *   opus    零售 ¥22.5/¥112.5 → mr 3.214286, cr 5
 */
export function computeRatios(cnyIn: number, cnyOut: number): Ratios {
    const mr = cnyIn / PRICING_FX;
    const cr = cnyIn > 0 ? cnyOut / cnyIn : 1;
    return { model_ratio: Number(mr.toFixed(6)), completion_ratio: Number(cr.toFixed(4)) };
}

/** computeRatios 的逆运算输出:从 new-api ratio 还原出的零售 ¥/1M 价。 */
export interface RetailPrice {
    input_cny_per_1m: number;
    output_cny_per_1m: number;
}

/**
 * {@link computeRatios} 的【逆运算】(P2.5 从 new-api 反向导入定价用)。
 *
 *   ¥in/1M  = model_ratio × PRICING_FX
 *   ¥out/1M = ¥in × completion_ratio
 *
 * 与正向 sync 互逆(四舍五入到 CatalogPrice 的 Decimal(12,4) 精度):
 *   mr 0.357143, cr 4 → ¥2.5 / ¥10   (gpt-5.4)
 *   mr 3.214286, cr 5 → ¥22.5 / ¥112.5(opus)
 *
 * completion_ratio 缺失时调用方应传 1(= in/out 同价),见 import-catalog.ts。
 */
export function retailFromRatios(modelRatio: number, completionRatio: number): RetailPrice {
    const cnyIn = Number((modelRatio * PRICING_FX).toFixed(4));
    const cnyOut = Number((cnyIn * completionRatio).toFixed(4));
    return { input_cny_per_1m: cnyIn, output_cny_per_1m: cnyOut };
}

/** upstream_map 一个档次的映射(P2 结构,P3 扩展为 pool/official 多档)。 */
export interface UpstreamMapEntry {
    channel_id: number;
    upstream_model: string;
}
export type UpstreamMap = Record<string, UpstreamMapEntry>;

export interface PriceInput {
    tier: string;
    input_cny_per_1m: number | null;
    output_cny_per_1m: number | null;
    per_image_cny?: number | null;
}

export interface SyncResult {
    ok: boolean;
    skipped?: string; // 跳过原因(无 in/out 价且无 per-image —— 没有可同步的价)
    channel_id?: number;
    upstream_model?: string;
    ratios?: Ratios;
    /** 图片模型:本次走【全局 ModelPrice】同步(非 per-channel mr/cr)。 */
    image?: boolean;
    /** 图片模型同步进 new-api 全局 ModelPrice 的 USD/张(= per_image_cny / PRICING_FX)。 */
    modelPrice_usd?: number;
    /** 非致命提示(如:图片多档填了不同价,已按默认档值同步,其余未生效)。 */
    warn?: string;
    error?: string;
}

/** new-api channel.model_ratio / completion_ratio 可能是 JSON 字符串或已解析 dict。 */
export function parseRatioDict(s: string | Record<string, number> | null | undefined): Record<string, number> {
    if (!s) return {};
    if (typeof s === 'object') return s;
    try {
        return JSON.parse(s) as Record<string, number>;
    } catch {
        return {};
    }
}

/**
 * 改价后把单个 (model, tier) 的零售价折算 mr/cr,sync 到对应 new-api 渠道:
 * GET 渠道完整对象 → 在原 model_ratio / completion_ratio dict 上【merge】我们这个
 * upstream_model → 整对象 PUT 回(gotcha #15:必须回传整个对象,否则
 * models/model_mapping 等被静默清空)。
 *
 * 返回 ok=false 的情形(调用方:价格已落 portal DB 为事实源,sync 是 best-effort,
 * 失败在 UI 回报并可「重新同步」):
 *   - 档次在 upstream_map 没有 {channel_id, upstream_model} 映射 → 无法 sync;
 *   - new-api GET/PUT 失败。
 * 图片模型(填了 per_image_cny)→ 走 {@link syncImageModelPrice}(全局 ModelPrice,P2.8 Part B)。
 * 既无 in/out 价又无 per_image → ok=true 但 skipped(没有可同步的价)。
 */
export async function syncModelPriceToNewApi(upstreamMap: UpstreamMap, price: PriceInput): Promise<SyncResult> {
    // ── 图片模型:per-image 定价走 new-api【全局 ModelPrice】(按模型名,USD/张),
    //    不折算 model_ratio/completion_ratio。必须在下方 in/out 空值判断【之前】。 ──
    if (price.per_image_cny != null) {
        return syncImageModelPrice(upstreamMap, price);
    }

    const entry = upstreamMap?.[price.tier];
    if (!entry || typeof entry.channel_id !== 'number' || !entry.upstream_model) {
        return { ok: false, error: `档次 "${price.tier}" 在 upstream_map 中没有 {channel_id, upstream_model} 映射` };
    }

    // 既无 in/out 价又无 per_image —— 真的没有可同步的价格。
    if (price.input_cny_per_1m == null || price.output_cny_per_1m == null) {
        return {
            ok: true,
            skipped: '无 in/out 价且无 per-image —— 没有可同步的价格',
            channel_id: entry.channel_id,
            upstream_model: entry.upstream_model,
        };
    }

    const ratios = computeRatios(price.input_cny_per_1m, price.output_cny_per_1m);

    try {
        const ch = await getChannel(entry.channel_id);
        const mr = parseRatioDict(ch.model_ratio);
        const cr = parseRatioDict(ch.completion_ratio);
        mr[entry.upstream_model] = ratios.model_ratio;
        cr[entry.upstream_model] = ratios.completion_ratio;
        // 整对象回传,只换 model_ratio / completion_ratio(其余字段原样保留)。
        await updateChannel({ ...ch, model_ratio: JSON.stringify(mr), completion_ratio: JSON.stringify(cr) });
        return { ok: true, channel_id: entry.channel_id, upstream_model: entry.upstream_model, ratios };
    } catch (err) {
        return {
            ok: false,
            channel_id: entry.channel_id,
            upstream_model: entry.upstream_model,
            ratios,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

/** upstream_map 里第一个有效映射(图片模型各档同名 → 取任一档即可拿到模型名)。 */
function firstUpstreamEntry(map: UpstreamMap): UpstreamMapEntry | undefined {
    for (const k of Object.keys(map ?? {})) {
        const e = map[k];
        if (e && typeof e.channel_id === 'number' && e.upstream_model) return e;
    }
    return undefined;
}

/**
 * 图片模型 → new-api【全局 ModelPrice】同步(P2.8 Part B)。
 *
 * ⚠️ 架构限制:new-api 的 ModelPrice 是【全局按模型名】(system option key=ModelPrice,
 * JSON 字符串 dict `{ model: usd_per_image }`),不分渠道/档次 —— 同一图片模型名在所有
 * 档共享一个 ModelPrice。所以图片模型的 per-image 价【无法分 pool/official 档】(与 chat
 * 不同:chat 用 per-channel model_ratio 能分档)。真正的图片分档计费留 P4c(portal 自己
 * 按档计量,不依赖 new-api ModelPrice)。本期按单一价同步(默认档值,见 resolveImageModelPrice)。
 *
 * 换算:`ModelPrice_USD = per_image_cny / PRICING_FX`(FX=7;对拍 gpt-image-2 ¥0.10/7 ≈ 0.01429)。
 * 写法镜像 gotcha #15:GET 全量 ModelPrice dict → 在原 dict 上 merge 我们这个模型 → PUT 整个
 * dict(只 PUT 自己那条会清掉别的模型的 ModelPrice 条目)。
 */
async function syncImageModelPrice(upstreamMap: UpstreamMap, price: PriceInput): Promise<SyncResult> {
    // 模型名:本档映射的 upstream_model 优先;本档无映射则取任一档(图片模型各档同名,brief B.4)。
    const entry = upstreamMap?.[price.tier] ?? firstUpstreamEntry(upstreamMap);
    if (!entry || !entry.upstream_model) {
        return {
            ok: false,
            image: true,
            error: '图片模型在 upstream_map 中没有任何 {channel_id, upstream_model} 映射,无法同步 ModelPrice',
        };
    }
    // 5 位小数:对齐 new-api ModelPrice dict 既有精度(gpt-image-2=0.01429 / gemini=0.00891),
    // 也让 ¥0.10/7 = 0.01429 与现网值精确一致(P2.8 Part B 实测确认)。
    const modelPrice_usd = Number(((price.per_image_cny as number) / PRICING_FX).toFixed(5));
    try {
        // parseRatioDict:把 JSON 字符串/对象解析成 Record<string, number>(对 ModelPrice dict 同形)。
        const dict = parseRatioDict(await getOption('ModelPrice'));
        dict[entry.upstream_model] = modelPrice_usd;
        await putOption('ModelPrice', JSON.stringify(dict));
        return {
            ok: true,
            image: true,
            channel_id: entry.channel_id,
            upstream_model: entry.upstream_model,
            modelPrice_usd,
        };
    } catch (err) {
        return {
            ok: false,
            image: true,
            channel_id: entry.channel_id,
            upstream_model: entry.upstream_model,
            modelPrice_usd,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

/**
 * 图片全局价归一(P2.8 Part B,架构限制见 {@link syncImageModelPrice})。
 *
 * 全局 ModelPrice 一个模型名只能有一个价,所以多档若填了不同 per_image 必须二选一:
 *   - 取【默认档】(is_default,通常 pool)的值;默认档没填则按档次序(pool→official→其余)
 *     取第一个有价的;
 *   - 多档价不一致时产出 warn(告知 operator 其余档的价未生效,真分档留 P4c)。
 * 没有任何档填了 per_image → 返回默认档 + null(无价可同步)。
 */
export function resolveImageModelPrice(
    pricesByTier: Array<{ tier: string; per_image_cny: number | null }>,
    defaultTier: string,
): { tier: string; per_image_cny: number | null; warn?: string } {
    const withPrice = pricesByTier.filter((p) => p.per_image_cny != null);
    if (withPrice.length === 0) return { tier: defaultTier, per_image_cny: null };
    const chosen =
        withPrice.find((p) => p.tier === defaultTier) ??
        withPrice.slice().sort((a, b) => tierOrder(a.tier) - tierOrder(b.tier) || a.tier.localeCompare(b.tier))[0];
    const distinct = new Set(withPrice.map((p) => p.per_image_cny));
    const warn =
        distinct.size > 1
            ? `图片模型暂不支持分档价(new-api ModelPrice 按模型名全局),已用「${chosen.tier}」档价 ¥${chosen.per_image_cny}/张 同步;其余档填的不同价未生效(真分档计费留 P4c)。`
            : undefined;
    return { tier: chosen.tier, per_image_cny: chosen.per_image_cny, warn };
}
