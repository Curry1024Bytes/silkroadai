import 'server-only';
import { getOption, putOption } from './client';
import { tierOrder } from '@/lib/admin/pricing-tiers';
import { USD_TO_CNY_RATE, quotaToCny } from './quota-units';

/**
 * 定价 sync 的换算 FX —— 把零售 ¥/1M 折算成 new-api ratio,必须与真实计费口径一致。
 *
 * chat 计费:1M token × model_ratio=1 × group=1 → 1M quota;客户实扣 ¥ = quotaToCny(1M)
 *   = (1e6 / QUOTA_PER_USD) × USD_TO_CNY。所以 model_ratio = 零售¥/1M ÷ quotaToCny(1M)。
 * image 计费:ModelPrice 是 per-call USD 直价,¥ = ModelPrice × USD_TO_CNY(QuotaPerUnit 抵消)。
 *
 * ⚠️ 2026-06-12 修正:旧实现把 CHAT_FX 硬编码成 `2 × USD_TO_CNY`(= 14.4),那个 ×2 暗含
 *   QUOTA_PER_USD=500000(1M quota=$2)。但【prod】QUOTA_PER_USD=1,000,000(1M quota=$1,
 *   USDExchangeRate=7)→ 正确 CHAT_FX=7。旧的 14.4 在 prod 高了 2× → 同步出的 model_ratio
 *   砍半 → "重新同步"会把客户实扣压到目录标价的一半。改成 `quotaToCny(1_000_000)` 从 env 推导:
 *   prod(1e6/7)=7,本地测试 env(500000/7.2)=14.4 不变(单测照旧绿)。IMAGE_FX 无 ×2 问题。
 *
 * 改这两个常数只决定【以后】sync/import 怎么算 mr/ModelPrice;不主动 re-sync → 现网 live
 * ratio 不变 → 客户账单零变化。
 */
/** chat FX = 1M quota 的 ¥ 值(= model_ratio=1 时 1M token 的实扣)= quotaToCny(1e6)。prod=7,本地测试=14.4。 */
export const CHAT_FX = quotaToCny(1_000_000);
/** image FX:ModelPrice per-call USD 直价 → ¥ = ModelPrice × USD_TO_CNY → 等效 FX = USD_TO_CNY。prod=7,本地=7.2。 */
export const IMAGE_FX = USD_TO_CNY_RATE;

export interface Ratios {
    model_ratio: number;
    completion_ratio: number;
}

/**
 * 把零售 ¥/1M 价折算成 new-api 的 model_ratio / completion_ratio。
 *
 *   model_ratio      = input_cny_per_1m / CHAT_FX(见 {@link CHAT_FX};prod=7、本地测试 env=14.4)
 *   completion_ratio = output_cny_per_1m / input_cny_per_1m(沿用官方 in/out 比例)
 *
 * 使「目录标价 = 客户实扣」(目录价 / CHAT_FX == new-api live mr)。例(本地测试 env FX=14.4):
 *   零售 ¥2.5/¥10    → mr 0.173611, cr 4
 *   零售 ¥22.5/¥112.5 → mr 1.5625, cr 5
 */
export function computeRatios(cnyIn: number, cnyOut: number): Ratios {
    const mr = cnyIn / CHAT_FX;
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
 *   ¥in/1M  = model_ratio × CHAT_FX(见 {@link CHAT_FX};prod=7、本地测试 env=14.4)
 *   ¥out/1M = ¥in × completion_ratio
 *
 * 与正向 sync 互逆(四舍五入到 CatalogPrice 的 Decimal(12,4) 精度),例(本地测试 env FX=14.4):
 *   mr 0.173611, cr 4 → ¥2.5 / ¥10
 *   mr 1.5625,   cr 5 → ¥22.5 / ¥112.5
 *
 * completion_ratio 缺失时调用方应传 1(= in/out 同价),见 import-catalog.ts。
 */
export function retailFromRatios(modelRatio: number, completionRatio: number): RetailPrice {
    const cnyIn = Number((modelRatio * CHAT_FX).toFixed(4));
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
    /** 图片模型同步进 new-api 全局 ModelPrice 的 USD/张(= per_image_cny / IMAGE_FX)。 */
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
 * 改价后把单个 (model, tier) 的零售价同步到 new-api。两条全局 option 路径,**都按模型名、
 * 不分渠道/档次**(P2.9 实测:new-api v1.0.0-rc.2 PUT `channel.model_ratio`/`completion_ratio`
 * 返回 200 但【静默丢弃】不入库 → per-channel sync 从未生效;真实计费读全局 option):
 *   - chat(有 in/out 价)→ 全局 `ModelRatio` + `CompletionRatio`(见 {@link syncChatModelRatio})。
 *   - 图片(填了 per_image_cny)→ 全局 `ModelPrice`(见 {@link syncImageModelPrice},P2.8 Part B)。
 * 两者对称:GET 全量 dict → 只 merge 我们这个 upstream_model → PUT 整 dict(保留别的条目,
 * gotcha #15 精神)。⚠️ 全局按模型名 → chat 与图片**都无法分 pool/official 档**(同名各档共享
 * 一个值);多档归一 + warn 由调用方(resync)用 {@link resolveChatTierPrice} /
 * {@link resolveImageModelPrice} 做,真分档计费留 P4c。
 *
 * 返回 ok=false:upstream_map 完全没有 {channel_id, upstream_model} 映射 / new-api GET/PUT 失败。
 * 既无 in/out 又无 per_image → ok=true 但 skipped(没有可同步的价)。
 */
export async function syncModelPriceToNewApi(upstreamMap: UpstreamMap, price: PriceInput): Promise<SyncResult> {
    // 图片:per-image → 全局 ModelPrice。必须在下方 in/out 空值判断【之前】。
    if (price.per_image_cny != null) {
        return syncImageModelPrice(upstreamMap, price);
    }

    // 既无 in/out 价又无 per_image —— 真的没有可同步的价格。
    if (price.input_cny_per_1m == null || price.output_cny_per_1m == null) {
        const entry = upstreamMap?.[price.tier] ?? firstUpstreamEntry(upstreamMap);
        return {
            ok: true,
            skipped: '无 in/out 价且无 per-image —— 没有可同步的价格',
            channel_id: entry?.channel_id,
            upstream_model: entry?.upstream_model,
        };
    }

    // chat:有 in/out 价 → 全局 ModelRatio + CompletionRatio。
    return syncChatModelRatio(upstreamMap, price);
}

/**
 * chat 模型 → new-api【全局 ModelRatio + CompletionRatio】同步(P2.9)。
 *
 * ⚠️ 架构限制(与图片 {@link syncImageModelPrice} 同款):全局 `ModelRatio`/`CompletionRatio`
 * 是 `{ 模型名: 值 }`,**按模型名、不分渠道/档次** —— pool/official/cc-kiro 用同一模型名 →
 * 全局层只能一个值 → **chat 也无法分档定价**(本期)。真分档计费留 P4c(portal 自己按档计量)。
 *
 * 旧实现 PUT `channel.model_ratio`(P2),被 new-api 静默丢弃 → 改价从未生效;P2.9 改走全局。
 * 写法镜像 gotcha #15:GET 全量 ModelRatio/CompletionRatio dict → 只 merge 我们这个 upstream_model
 * → PUT 整 dict(保留别的 ~293 条)。换算沿用 {@link computeRatios}(mr 6 位、cr 4 位,对齐现网精度)。
 */
async function syncChatModelRatio(upstreamMap: UpstreamMap, price: PriceInput): Promise<SyncResult> {
    // 模型名:本档映射优先;本档无映射则取任一档(chat 模型名各档一致,同图片 brief B.4)。
    const entry = upstreamMap?.[price.tier] ?? firstUpstreamEntry(upstreamMap);
    if (!entry || !entry.upstream_model) {
        return {
            ok: false,
            error: 'chat 模型在 upstream_map 中没有任何 {channel_id, upstream_model} 映射,无法同步 ModelRatio',
        };
    }
    const ratios = computeRatios(price.input_cny_per_1m as number, price.output_cny_per_1m as number);
    try {
        const mrDict = parseRatioDict(await getOption('ModelRatio'));
        const crDict = parseRatioDict(await getOption('CompletionRatio'));
        mrDict[entry.upstream_model] = ratios.model_ratio;
        crDict[entry.upstream_model] = ratios.completion_ratio;
        // 整 dict 回传,只换我们这个模型名(其余条目原样保留)。两个 option 各 PUT 一次。
        await putOption('ModelRatio', JSON.stringify(mrDict));
        await putOption('CompletionRatio', JSON.stringify(crDict));
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
 * 换算:`ModelPrice_USD = per_image_cny / IMAGE_FX`(= USD_TO_CNY = 7.2,image per-call USD 直价)。
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
    // 5 位小数:对齐 new-api ModelPrice dict 既有精度。换算用 IMAGE_FX(= USD_TO_CNY = 7.2);
    // 配套把目录 per_image ×7.2/7 提上去后(Part B),per_image / 7.2 == 现网 live ModelPrice。
    const modelPrice_usd = Number(((price.per_image_cny as number) / IMAGE_FX).toFixed(5));
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
 * 全局价(ModelPrice/ModelRatio)按模型名,无法分档 → 多档要二选一时,选【默认档】
 * (is_default,通常 pool);默认档不在候选则按档次序(pool→official→其余)取第一个。
 * 供 {@link resolveImageModelPrice} / {@link resolveChatTierPrice} 复用。
 */
function pickDefaultTierRow<T extends { tier: string }>(priced: T[], defaultTier: string): T {
    return (
        priced.find((p) => p.tier === defaultTier) ??
        priced.slice().sort((a, b) => tierOrder(a.tier) - tierOrder(b.tier) || a.tier.localeCompare(b.tier))[0]
    );
}

/**
 * 图片全局价归一(P2.8 Part B,架构限制见 {@link syncImageModelPrice})。
 *
 * 全局 ModelPrice 一个模型名只能有一个价,所以多档若填了不同 per_image 必须二选一:
 *   - 取【默认档】(is_default,通常 pool)的值;默认档没填则按档次序取第一个有价的;
 *   - 多档价不一致时产出 warn(告知 operator 其余档的价未生效,真分档留 P4c)。
 * 没有任何档填了 per_image → 返回默认档 + null(无价可同步)。
 */
export function resolveImageModelPrice(
    pricesByTier: Array<{ tier: string; per_image_cny: number | null }>,
    defaultTier: string,
): { tier: string; per_image_cny: number | null; warn?: string } {
    const withPrice = pricesByTier.filter((p) => p.per_image_cny != null);
    if (withPrice.length === 0) return { tier: defaultTier, per_image_cny: null };
    const chosen = pickDefaultTierRow(withPrice, defaultTier);
    const distinct = new Set(withPrice.map((p) => p.per_image_cny));
    const warn =
        distinct.size > 1
            ? `图片模型暂不支持分档价(new-api ModelPrice 按模型名全局),已用「${chosen.tier}」档价 ¥${chosen.per_image_cny}/张 同步;其余档填的不同价未生效(真分档计费留 P4c)。`
            : undefined;
    return { tier: chosen.tier, per_image_cny: chosen.per_image_cny, warn };
}

/**
 * chat 全局价归一(P2.9,架构限制见 {@link syncChatModelRatio})。与图片
 * {@link resolveImageModelPrice} 对称:全局 ModelRatio 按模型名,多档若填了不同 (in,out)
 * 价 → 取【默认档】(is_default,通常 pool)的价;默认档没填则按档次序取第一个有价的;多档
 * (in,out) 不一致时产出 warn(其余档价未生效,真分档留 P4c)。无任何档定价 → 默认档 + null。
 */
export function resolveChatTierPrice(
    pricesByTier: Array<{ tier: string; input_cny_per_1m: number | null; output_cny_per_1m: number | null }>,
    defaultTier: string,
): { tier: string; input_cny_per_1m: number | null; output_cny_per_1m: number | null; warn?: string } {
    const withPrice = pricesByTier.filter((p) => p.input_cny_per_1m != null && p.output_cny_per_1m != null);
    if (withPrice.length === 0) return { tier: defaultTier, input_cny_per_1m: null, output_cny_per_1m: null };
    const chosen = pickDefaultTierRow(withPrice, defaultTier);
    const distinct = new Set(withPrice.map((p) => `${p.input_cny_per_1m}/${p.output_cny_per_1m}`));
    const warn =
        distinct.size > 1
            ? `chat 模型暂不支持分档价(new-api ModelRatio 按模型名全局),已用「${chosen.tier}」档价 ¥${chosen.input_cny_per_1m}/¥${chosen.output_cny_per_1m} 同步;其余档填的不同价未生效(真分档计费留 P4c)。`
            : undefined;
    return {
        tier: chosen.tier,
        input_cny_per_1m: chosen.input_cny_per_1m,
        output_cny_per_1m: chosen.output_cny_per_1m,
        warn,
    };
}
