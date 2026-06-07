/**
 * P2.5 — 从 new-api 旗舰渠道反向导出「模型 + 价格」候选(纯函数,无 DB / 无 HTTP)。
 *
 * 调用方(src/app/api/admin/models/import/route.ts):先 getChannel 逐个拉回选中的
 * 旗舰渠道完整对象,喂给 {@link buildImportCandidates} 得到候选清单,再与 portal DB
 * 现有 slug 对账(已存在→skip)后落库。把推导逻辑抽到这里,是为了能脱离 new-api /
 * 数据库对「反向价格推导 + 厂商/模态推断」单测对拍(brief §6)。
 *
 * 价格反向推导 = P2 正向 sync 的逆运算,复用 pricing-sync 的 PRICING_FX(不另写 7):
 *   ¥in/1M  = model_ratio × PRICING_FX
 *   ¥out/1M = ¥in × completion_ratio
 * 图片模型走 new-api 的 ModelPrice(每张固定价),不走 model_ratio/completion_ratio,
 * 本模块算不出 per-image ¥ → price_status='image',价格留空,由 operator 在
 * /admin/pricing 手填(brief §2)。
 *
 * `server-only`:本身是纯逻辑,但 import 了 server-only 的 pricing-sync(retailFromRatios /
 * parseRatioDict)→ 整体视为 server-only(见 src/__tests__/lib/server-only-guards.test.ts)。
 */
import 'server-only';
import { retailFromRatios, parseRatioDict } from './pricing-sync';

/** new-api getChannel 结果里我们关心的子集(放宽以兼容真实对象的其余字段)。 */
export interface ChannelForImport {
    id: number;
    name?: string | null;
    /** 逗号分隔的模型名清单(new-api `channel.models` 字段)。 */
    models?: string | null;
    model_ratio?: string | Record<string, number> | null;
    completion_ratio?: string | Record<string, number> | null;
    /**
     * 该渠道的导入档次(P2.6)= ChannelGroup.key('pool'/'official')。由调用方按
     * 「channel_id ∈ official 渠道组登记的 ids → official,否则 pool」判定后填入。
     */
    tier: string;
}

/**
 * 价格推导结果:
 * - `priced`   chat 模型且渠道有 model_ratio → 算出 ¥in/¥out。
 * - `image`    图片模型(按名字判断)→ per-image 价算不出,留空待手填。
 * - `unpriced` 在 channel.models 里但渠道无 model_ratio 条目(也非图片)→ 价格未知,待手填。
 */
export type PriceStatus = 'priced' | 'image' | 'unpriced';

export interface ImportCandidate {
    slug: string;
    display_name: string;
    vendor: string;
    modality: 'chat' | 'image';
    /** 档次(P2.6)= 来源渠道的 ChannelGroup.key('pool'/'official')。 */
    tier: string;
    channel_id: number;
    channel_name: string | null;
    /** upstream_map[tier].upstream_model —— = slug 本身。 */
    upstream_model: string;
    input_cny_per_1m: number | null;
    output_cny_per_1m: number | null;
    price_status: PriceStatus;
    /** completion_ratio 缺该 model → cr 取默认 1(in=out 同价),预览里标注。 */
    ratio_defaulted: boolean;
}

/**
 * 按模型名前缀推断厂商。优先用模型名(比渠道 id 更稳 —— 渠道 id 是 operator 可配的
 * 入参,不该硬编码进推断逻辑);命中不了回退 'unknown',operator 后续可在 /admin/models 改。
 * OpenAI 家族取宽口径(对齐 W6 D3 categorize.ts 的 F3/F4 经验:含 dall-e/sora/whisper 等)。
 */
export function inferVendor(slug: string): string {
    const s = slug.toLowerCase();
    if (s.startsWith('claude')) return 'anthropic';
    if (s.startsWith('gemini') || s.startsWith('imagen')) return 'google';
    if (s.startsWith('deepseek')) return 'deepseek';
    if (s.startsWith('qwen') || s.startsWith('qwq')) return 'qwen';
    if (s.startsWith('glm') || s.startsWith('chatglm')) return 'zhipu';
    if (s.startsWith('kimi') || s.startsWith('moonshot')) return 'moonshot';
    if (
        s.startsWith('gpt') ||
        s.startsWith('chatgpt') ||
        s.startsWith('o1') ||
        s.startsWith('o3') ||
        s.startsWith('o4') ||
        s.startsWith('codex') ||
        s.startsWith('dall-e') ||
        s.startsWith('sora') ||
        s.startsWith('whisper') ||
        s.startsWith('tts') ||
        s.startsWith('text-embedding')
    ) {
        return 'openai';
    }
    return 'unknown';
}

/** 图片模型判定:名字含 image / dall-e / imagen(brief §3「按名字含 image 判断」+ dall-e/imagen 补充)。 */
export function isImageModel(slug: string): boolean {
    const s = slug.toLowerCase();
    return s.includes('image') || s.includes('dall-e') || s.includes('imagen');
}

/**
 * 由 slug 生成友好显示名(简单规则,operator 后续可改)。带 '/' 的取最后一段
 * (e.g. 'deepseek-ai/DeepSeek-V4' → 'DeepSeek-V4' 再拆),按 -/_ 拆词,字母词首字母大写,
 * 纯数字/版本号 token 原样保留(故 'claude-opus-4-7' → 'Claude Opus 4 7',operator 改成 4.7)。
 */
export function toDisplayName(slug: string): string {
    const base = slug.includes('/') ? (slug.split('/').pop() ?? slug) : slug;
    return base
        .split(/[-_]/)
        .map((w) => (w.length > 0 && /[a-z]/i.test(w[0]) ? w[0].toUpperCase() + w.slice(1) : w))
        .join(' ')
        .trim();
}

/**
 * 从选中的旗舰渠道(已逐个 getChannel 拉回、各自带 tier)推导出导入候选清单。
 *
 * - 去重键 = (slug, tier)(P2.6):同一 slug 在两个【同档】渠道出现 → 取第一个
 *   (first-wins);在 pool 渠道 + official 渠道各出现一次 → 产出【两个】候选
 *   (pool 一个 + official 一个),供调用方合并成「一个模型两档价」。
 * - 顺序保持渠道入参顺序 → 渠道内 models 顺序,便于稳定的 sort_order 分配。
 */
export function buildImportCandidates(channels: ChannelForImport[]): ImportCandidate[] {
    const seen = new Set<string>();
    const out: ImportCandidate[] = [];

    for (const ch of channels) {
        const mrDict = parseRatioDict(ch.model_ratio);
        const crDict = parseRatioDict(ch.completion_ratio);
        const models = (ch.models ?? '')
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean);

        for (const slug of models) {
            const dedupKey = `${slug}\u0000${ch.tier}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);

            const base = {
                slug,
                display_name: toDisplayName(slug),
                vendor: inferVendor(slug),
                tier: ch.tier,
                channel_id: ch.id,
                channel_name: ch.name ?? null,
                upstream_model: slug,
            };

            // 图片模型优先:即便渠道误配了 model_ratio,也不按 mr/cr 给图片定价。
            if (isImageModel(slug)) {
                out.push({
                    ...base,
                    modality: 'image',
                    input_cny_per_1m: null,
                    output_cny_per_1m: null,
                    price_status: 'image',
                    ratio_defaulted: false,
                });
                continue;
            }

            const mr = mrDict[slug];
            if (typeof mr === 'number') {
                const crRaw = crDict[slug];
                const ratioDefaulted = typeof crRaw !== 'number';
                const cr = ratioDefaulted ? 1 : crRaw;
                const price = retailFromRatios(mr, cr);
                out.push({
                    ...base,
                    modality: 'chat',
                    input_cny_per_1m: price.input_cny_per_1m,
                    output_cny_per_1m: price.output_cny_per_1m,
                    price_status: 'priced',
                    ratio_defaulted: ratioDefaulted,
                });
                continue;
            }

            // 在 models 里但渠道无 model_ratio 条目(且非图片)→ 价格未知,建模型但待手填。
            out.push({
                ...base,
                modality: 'chat',
                input_cny_per_1m: null,
                output_cny_per_1m: null,
                price_status: 'unpriced',
                ratio_defaulted: false,
            });
        }
    }

    return out;
}
