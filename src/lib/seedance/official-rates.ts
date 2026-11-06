/**
 * 火山方舟 Seedance【官方挂牌价】(元/1M token):[变体][分辨率] = { 无视频, 含视频 }。
 * 纯数据,无 I/O:cn-billing.ts(自扣计费)与定价页「官方价 × 折扣」预填共用同一份表,
 * 不在别处复制价格。⚠️ 此表不含任何折扣;零售/客户折扣由调用方显式乘。
 * 2026-07-19 加 fast/mini;2026-08-03 全变体加 480p(上游挂牌 480p 与 720p 统一价,
 * token 量 ∝ 像素,480p 整条约为 720p 的一半价)。
 */
import type { SeedanceVariant } from './cn-adapter';

export type Resolution = '480p' | '720p' | '1080p' | '4k';

export const OFFICIAL_CNY_PER_M: Record<
    SeedanceVariant,
    Partial<Record<Resolution, { noVideo: number; withVideo: number }>>
> = {
    pro: {
        '480p': { noVideo: 46, withVideo: 28 }, // 官方挂牌(与 720p 同费率)
        '720p': { noVideo: 46, withVideo: 28 }, // 官方挂牌
        '1080p': { noVideo: 51, withVideo: 31 }, // 官方挂牌
        '4k': { noVideo: 26, withVideo: 16 }, // 官方挂牌
    },
    fast: {
        '480p': { noVideo: 37, withVideo: 22 }, // 官方挂牌(与 720p 同费率)
        '720p': { noVideo: 37, withVideo: 22 }, // 官方挂牌
        '1080p': { noVideo: 40.5, withVideo: 24.5 }, // 官方挂牌(1080p 单独档,2026-08-08 修正)
    },
    mini: {
        '480p': { noVideo: 23, withVideo: 14 }, // 官方挂牌(与 720p 同费率)
        '720p': { noVideo: 23, withVideo: 14 }, // 官方挂牌
        '1080p': { noVideo: 25.5, withVideo: 15.5 }, // 官方挂牌(1080p 单独档,2026-08-08 修正)
    },
    // seedance 2.5:国内版渠道(上游 artsdance-2-5-pro)仅 720p/1080p;火山渠道(上游筷子
    // 开放平台,2026-08-17)仅 480p/720p —— 两渠道同一费率表(同为火山官方挂牌),取并集。
    // 480p 与 720p 同费率(与 2.0 全系一致:token ∝ 像素,整条约半价,不是费率档不同)。
    '2.5': {
        '480p': { noVideo: 70, withVideo: 42 }, // 官方挂牌(与 720p 同费率)
        '720p': { noVideo: 70, withVideo: 42 }, // 官方挂牌
        '1080p': { noVideo: 77, withVideo: 46 }, // 官方挂牌(2026-09-07 调价,原 90/54)
    },
    // 海外版proMax(2026-07-23,dreamina 系):dreamina 官方挂牌(上游对我们 9 折)。
    promax: {
        '480p': { noVideo: 68, withVideo: 40.8 }, // 官方挂牌(与 720p 同费率)
        '720p': { noVideo: 68, withVideo: 40.8 }, // 官方挂牌
        '1080p': { noVideo: 73.44, withVideo: 44.88 }, // 官方挂牌
        '4k': { noVideo: 38.08, withVideo: 23.12 }, // 官方挂牌
    },
    'promax-fast': {
        '480p': { noVideo: 54.4, withVideo: 32.896 }, // 官方挂牌(与 720p 同费率)
        '720p': { noVideo: 54.4, withVideo: 32.896 }, // 官方挂牌
    },
    'promax-mini': {
        '480p': { noVideo: 34, withVideo: 20.4 }, // 官方挂牌(与 720p 同费率)
        '720p': { noVideo: 34, withVideo: 20.4 }, // 官方挂牌
    },
    // 海外版 proMax seedance 2.5(2026-08-08):按原价(划线价)挂牌;2026-10-15 换 service-inference.ai 上游后
    // 加 480p(与 720p 同费率,沿用全线 480p 口径)。
    'promax-2.5': {
        '480p': { noVideo: 72.76, withVideo: 43.52 }, // 官方挂牌(与 720p 同费率)
        '720p': { noVideo: 72.76, withVideo: 43.52 }, // 官方挂牌(原价)
        '1080p': { noVideo: 80.24, withVideo: 47.94 }, // 官方挂牌(原价)
    },
};

/**
 * 火山方舟原生模型 id → 变体,仅供定价页预填官方价。只列核对过的 id;
 * 其余模型返回 null,由管理员手填,不按名字猜。
 */
const ARK_MODEL_VARIANTS: Record<string, SeedanceVariant> = {
    'doubao-seedance-2-5-260628': '2.5',
    'doubao-seedance-2-0-260128': 'pro',
    'doubao-seedance-2-0-fast-260128': 'fast',
    'doubao-seedance-2-0-mini-260615': 'mini',
};

/**
 * 某方舟模型某档的官方价(元/1M token),用于预填。官方表没有单列 4k 的变体按 1080p
 * 价预填(与 2026-10-29 上架时 new-api 公式一致),管理员可改。未知模型返回 null。
 */
export function arkOfficialPrice(model: string, resolution: Resolution, withVideo: boolean): number | null {
    const variant = ARK_MODEL_VARIANTS[model];
    if (!variant) return null;
    const table = OFFICIAL_CNY_PER_M[variant];
    const row = table[resolution] ?? (resolution === '4k' ? table['1080p'] : undefined);
    if (!row) return null;
    return withVideo ? row.withVideo : row.noVideo;
}
