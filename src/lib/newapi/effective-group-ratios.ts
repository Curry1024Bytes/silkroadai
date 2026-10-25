import 'server-only';
import { getOption, getUsableGroupsForCustomer } from './client';
import { getGroupRatios } from '@/lib/channel-group';

/**
 * 客户**有效**分组倍率(2026-10-23,专属倍率读路径)。
 *
 * new-api 的 `GroupGroupRatio[用户分组][令牌分组]` 覆盖矩阵让运营可以给某个客户某几档
 * 设专属倍率;扣费已经按它走,但 portal 原来各处显示的是全局 `GroupRatio`。这里统一成
 * "以客户身份问 new-api"(`/api/user/self/groups`,与 new-api 自家前端同源),拿不到时
 * 回落全局。调用方可用 `special` 判断哪几档是专属价(与全局不同)。
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
            const groups = await getUsableGroupsForCustomer({ accessToken: user.newapi_access_token, userId: uid });
            customer = {};
            for (const [g, v] of Object.entries(groups)) if (v.ratio !== 'auto') customer[g] = v.ratio;
            if (cache.size >= MAX_ENTRIES) cache.clear();
            cache.set(uid, { at: now, ratios: customer });
        } catch (err) {
            console.warn(`[effective-ratios] self/groups failed for newapi user ${uid}, using global:`, err);
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

/** 测试用。 */
export function _resetEffectiveRatioCache(): void {
    cache.clear();
}

/** Personal quotes must be verifiable. This reader never substitutes global/stale customer prices.
 * It returns only groups present in the customer's own authorized response. Portal tenant and
 * allowed_tier_keys checks remain mandatory at every Key mutation and caller's group selection.
 */
export async function getVerifiedEffectiveGroupRatios(user: CustomerAuthLike): Promise<EffectiveGroupRatios> {
    if (
        user.newapi_user_id == null ||
        !Number.isSafeInteger(user.newapi_user_id) ||
        user.newapi_user_id <= 0 ||
        !user.newapi_access_token
    )
        throw new Error('Customer pricing identity is unavailable');
    const [groups, raw] = await Promise.all([
        getUsableGroupsForCustomer({ accessToken: user.newapi_access_token, userId: user.newapi_user_id }),
        getOption('GroupRatio', true),
    ]);
    const parsed: unknown = JSON.parse(raw ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Cannot verify public group ratios');
    const listRatios: Record<string, number> = {};
    for (const [group, ratio] of Object.entries(parsed)) {
        if (!group.trim() || typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0)
            throw new Error('Cannot verify public group ratios');
        listRatios[group] = ratio;
    }
    const ratios: Record<string, number> = {};
    const special = new Set<string>();
    for (const [group, value] of Object.entries(groups)) {
        if (value.ratio === 'auto') continue;
        if (!Number.isFinite(value.ratio) || value.ratio < 0 || !Object.hasOwn(listRatios, group))
            throw new Error('Cannot verify customer group ratio');
        ratios[group] = value.ratio;
        if (value.ratio !== listRatios[group]) special.add(group);
    }
    return { ratios, listRatios, special, source: 'customer' };
}
