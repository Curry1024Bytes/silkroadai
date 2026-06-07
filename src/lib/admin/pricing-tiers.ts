/**
 * 定价档次行派生(P2.7)。纯逻辑,客户端安全(被 'use client' 的 /admin/pricing 页 import,
 * 无 server-only / 无 prisma / 无 I/O)。
 *
 * 一个模型的定价行 = 它 upstream_map 支持的档次 ∪ 已有价的 tier,每档一行:
 *  - upstream_map 的 key 决定可定价的档次(pool/official…)。只对【可路由】的档定价 ——
 *    P2.6 起 upstream_map 按档填了 {channel_id, upstream_model},改价 sync 要据此找渠道;
 *    没出现在 upstream_map 的档不该定价(sync 会失败,brief §2)。
 *  - 并上已有价的 tier,兼容历史残留(如迁移前的 'default' 价行)。
 *  - 顺序:pool 在前、official 次之、其余按字典序,稳定。
 *  - 每档「当前价」= 该 tier 下 effective_from 最新一行(调用方传入的 prices 已按 DESC),无则 null(未定价)。
 */

/** 档次排序权重:pool=0(号池/默认档在前)、official=1、其余=2。 */
export function tierOrder(tier: string): number {
    return tier === 'pool' ? 0 : tier === 'official' ? 1 : 2;
}

/** prices 行只需有 `tier`;泛型保留调用方的完整价类型作为 row.current。 */
export interface TierPriceLike {
    tier: string;
}

export interface DerivedTierRow<P extends TierPriceLike> {
    tier: string;
    current: P | null;
}

export function deriveTierRows<P extends TierPriceLike>(model: {
    upstream_map: unknown;
    prices: P[];
}): DerivedTierRow<P>[] {
    const upstreamTiers =
        model.upstream_map && typeof model.upstream_map === 'object' && !Array.isArray(model.upstream_map)
            ? Object.keys(model.upstream_map as Record<string, unknown>)
            : [];
    const priceTiers = model.prices.map((p) => p.tier);
    const tiers = Array.from(new Set([...upstreamTiers, ...priceTiers])).sort(
        (a, b) => tierOrder(a) - tierOrder(b) || a.localeCompare(b),
    );
    // 兜底:模型连 upstream_map 都没有(异常)→ 至少给个 pool 行,operator 仍可定价。
    const list = tiers.length > 0 ? tiers : ['pool'];
    const byTier = new Map<string, P>();
    for (const p of model.prices) if (!byTier.has(p.tier)) byTier.set(p.tier, p);
    return list.map((tier) => ({ tier, current: byTier.get(tier) ?? null }));
}
