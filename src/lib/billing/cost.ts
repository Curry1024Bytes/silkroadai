/**
 * P4a 影子计量 — 取价 + 算价的纯逻辑(无 prisma / 无 I/O / 无 server-only,可直接单测)。
 *
 * 取价沿用 P2 的版本化定价:某 (model, tier) 的生效价 = effective_from <= 日志时间 的最新一行。
 * 算价:cost(¥) = in/1e6 × input_cny_per_1m + out/1e6 × output_cny_per_1m。
 * 只在该档有【完整 in+out 价】时 matched=true 才算;图片/仅 per_image/无价 → matched=false, cost=0
 * (影子阶段不瞎算图片张数,留 P4b 人工看)。
 */

/** Decimal 列从 Prisma 可能是 string 或 number;统一成 number|null。 */
export function toNum(v: string | number | null | undefined): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

export interface PriceForCost {
    input_cny_per_1m: string | number | null;
    output_cny_per_1m: string | number | null;
}

/** 版本化价候选:同一 (model) 的多档多版本价行。 */
export interface VersionedPrice {
    id: string;
    tier: string;
    effective_from: string | Date;
    input_cny_per_1m: string | number | null;
    output_cny_per_1m: string | number | null;
}

/**
 * 在 `prices` 里挑出给定 `tier` 下、effective_from <= `at` 的最新一行(生效价)。
 * 无匹配返回 null。不依赖入参顺序(自己比 effective_from)。
 */
export function pickEffectivePrice<P extends { tier: string; effective_from: string | Date }>(
    prices: P[],
    tier: string,
    at: Date,
): P | null {
    const atMs = at.getTime();
    let best: P | null = null;
    let bestMs = -Infinity;
    for (const p of prices) {
        if (p.tier !== tier) continue;
        const efMs = new Date(p.effective_from).getTime();
        if (efMs <= atMs && efMs > bestMs) {
            best = p;
            bestMs = efMs;
        }
    }
    return best;
}

export interface UsageCost {
    costCny: number;
    matched: boolean;
}

/**
 * 按生效价算单条调用的 ¥ 成本。
 * - price 为 null(model/tier 没配价)→ matched=false, cost=0。
 * - price 有但缺 in 或 out 价(图片/仅 per_image)→ matched=false, cost=0(影子不瞎算)。
 * - in+out 价齐全 → matched=true, cost = in/1e6×inP + out/1e6×outP(8 位小数)。
 */
export function computeUsageCost(price: PriceForCost | null, inTokens: number, outTokens: number): UsageCost {
    if (!price) return { costCny: 0, matched: false };
    const inP = toNum(price.input_cny_per_1m);
    const outP = toNum(price.output_cny_per_1m);
    if (inP === null || outP === null) return { costCny: 0, matched: false };
    const cost = (inTokens / 1_000_000) * inP + (outTokens / 1_000_000) * outP;
    // 8 位小数对齐 Decimal(20,8),避免浮点长尾。
    return { costCny: Number(cost.toFixed(8)), matched: true };
}
