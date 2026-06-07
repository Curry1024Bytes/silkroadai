import 'server-only';
import { getChannel, updateChannel } from './client';

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
    skipped?: string; // 跳过原因(如图片模型 per-image 不走 mr/cr)
    channel_id?: number;
    upstream_model?: string;
    ratios?: Ratios;
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
 * 图片模型(无 in/out 价、只有 per_image)→ ok=true 但 skipped(per-image 定价不走 mr/cr)。
 */
export async function syncModelPriceToNewApi(upstreamMap: UpstreamMap, price: PriceInput): Promise<SyncResult> {
    const entry = upstreamMap?.[price.tier];
    if (!entry || typeof entry.channel_id !== 'number' || !entry.upstream_model) {
        return { ok: false, error: `档次 "${price.tier}" 在 upstream_map 中没有 {channel_id, upstream_model} 映射` };
    }

    // 图片模型:per-image 定价,不折算 model_ratio/completion_ratio。
    if (price.input_cny_per_1m == null || price.output_cny_per_1m == null) {
        return {
            ok: true,
            skipped: 'per-image / 无 in-out 价 —— 不折算 model_ratio/completion_ratio',
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
