import 'server-only';
import { getPricingGroupRatiosForCustomer } from './client';
import { getGroupRatios } from '@/lib/channel-group';

/**
 * 客户**有效**分组倍率(2026-10-23,专属倍率读路径)。
 *
 * new-api 的 `GroupGroupRatio[用户分组][令牌分组]` 覆盖矩阵让运营可以给某个客户某几档
 * 设专属倍率;扣费已经按它走,但 portal 原来各处显示的是全局 `GroupRatio`。这里统一成
 * "以客户身份问 new-api"(`GET /api/pricing` act-as,返回已套矩阵的 `group_ratio`;与
 * new-api 自家前端同源),拿不到时回落全局。
 *
 * 2026-10-25:数据源从 `/api/user/self/groups` 换成 `/api/pricing` —— 前者在 rc.41+ 要求
 * PAT 带 `profile:read` scope,客户的访问令牌没有(线上 403 → 曾一直回落全局 1.8)。调用方可用 `special` 判断哪几档是专属价(与全局不同)。
 *
 * 60s 进程内缓存按 newapi_user_id,失败回落全局并打 warn(不抛)。
 */
export interface EffectiveGroupRatios {
    /** newapi_group → 该客户的有效倍率。 */
    ratios: Record<string, number>;
    /** newapi_group → 全局挂牌倍率(对照用)。 */
    listRatios: Record<string, number>;
    /** 与全局不同的分组(= 专属价)。 */
    special: Set<string>;
    source: 'customer' | 'global';
}

const TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;
const cache = new Map<number, { at: number; ratios: Record<string, number> }>();

export interface CustomerAuthLike {
    newapi_user_id: number | null;
    newapi_access_token: string | null;
}

export async function getEffectiveGroupRatios(
    user: CustomerAuthLike | null,
    now = Date.now(),
): Promise<EffectiveGroupRatios> {
    const listRatios = await getGroupRatios();
    if (!user || user.newapi_user_id == null || !user.newapi_access_token) {
        return { ratios: { ...listRatios }, listRatios, special: new Set(), source: 'global' };
    }
    const uid = user.newapi_user_id;
    let customer: Record<string, number> | null = null;
    const hit = cache.get(uid);
    if (hit && now - hit.at < TTL_MS) {
        customer = hit.ratios;
    } else {
        try {
            customer = await getPricingGroupRatiosForCustomer({ accessToken: user.newapi_access_token, userId: uid });
            if (cache.size >= MAX_ENTRIES) cache.clear();
            cache.set(uid, { at: now, ratios: customer });
        } catch (err) {
            console.warn(`[effective-ratios] pricing(act-as) failed for newapi user ${uid}, using global:`, err);
            if (hit) customer = hit.ratios; // stale 胜过无
        }
    }
    if (!customer) {
        return { ratios: { ...listRatios }, listRatios, special: new Set(), source: 'global' };
    }
    // 客户视角里没有的组(不可用 / 隐藏)仍用全局值兜底,保证调用方按 newapi_group 查永远有值。
    const ratios: Record<string, number> = { ...listRatios, ...customer };
    const special = new Set<string>();
    for (const [g, r] of Object.entries(customer)) {
        const list = listRatios[g];
        if (list != null && Math.abs(list - r) > 1e-9) special.add(g);
    }
    return { ratios, listRatios, special, source: 'customer' };
}

/** 专属价相对挂牌价的缩放系数;无专属 / 无挂牌 → 1。 */
export function ratioScale(eff: EffectiveGroupRatios, newapiGroup: string): number {
    const list = eff.listRatios[newapiGroup];
    const r = eff.ratios[newapiGroup];
    if (list == null || r == null || list === 0) return 1;
    return r / list;
}

/** 写路径改完某客户后立即失效其缓存(60s 内也要看到新值)。 */
export function invalidateEffectiveRatioCache(newapiUserId: number): void {
    cache.delete(newapiUserId);
}

/** 测试用。 */
export function _resetEffectiveRatioCache(): void {
    cache.clear();
}
