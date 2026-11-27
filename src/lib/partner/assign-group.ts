import 'server-only';

import { prisma } from '@/lib/db';
import { getSaleRuleOptions, getUser } from '@/lib/newapi/client';
import {
    listAllCustomerTokens,
    updateUserGroupWithReadback,
    withOptionSyncLock,
} from '@/lib/newapi/user-tier-multiplier';
import {
    GROUP_GROUP_RATIO_KEYS,
    GROUP_RATIO_KEYS,
    SPECIAL_USABLE_KEY,
    USABLE_GROUPS_KEY,
    moveInProblems,
    parseNestedRatioMap,
    parseRatioMap,
    parseSpecialUsable,
    parseTokenGroups,
    parseUsableGroups,
    type LiveSaleOptions,
} from '@/lib/pricing-rules/options';
import { PartnerPricingError } from '@/lib/partner/errors';
import { isPartnerTenant, partnerUserGroup } from '@/lib/partner/group';
import { openPartnerGroups } from '@/lib/partner/pricing-sync';

/**
 * 把代理客户在 new-api 的 user.group 改成 partner-X，这样扣费命中代理零售率。
 * 客户 Key 都显式指定计费分组，改用户分组不改路由；空分组或 auto 的 Key 会跟着用户分组走，迁移前拒绝。
 */

/** 代理的默认档次必须已开放，否则新客户的第一个 Key 用不了。 */
export async function partnerAcceptsCustomers(tenantId: string, defaultNewapiGroup: string): Promise<boolean> {
    return (await openPartnerGroups(tenantId)).has(defaultNewapiGroup);
}

/** 新开户：在 new-api 建号成功后、Portal 落库前调用。重试时已在代理分组则不动。 */
export async function assignNewPartnerCustomer(args: { tenantId: string; newapiUserId: number }): Promise<void> {
    const group = partnerUserGroup(args.tenantId);
    await withOptionSyncLock(async () => {
        const user = await getUser(args.newapiUserId);
        if (user.group === group) return;
        await updateUserGroupWithReadback({ user, group, operation: 'partner-assign-new' });
        const reloaded = await getUser(args.newapiUserId);
        if (reloaded.group !== group) throw new PartnerPricingError('new-api 未按预期保存代理客户分组。', 502);
    });
}

export interface PartnerAssignResult {
    user_id: string;
    email: string;
    status: 'assigned' | 'already' | 'blocked';
    problems: string[];
}

function liveSaleOptions(options: Record<string, unknown>): LiveSaleOptions {
    return {
        groupRatio: parseRatioMap(options[GROUP_RATIO_KEYS[0]], GROUP_RATIO_KEYS[0]),
        groupGroupRatio: parseNestedRatioMap(options[GROUP_GROUP_RATIO_KEYS[0]], GROUP_GROUP_RATIO_KEYS[0]),
        usableGroups: parseUsableGroups(options[USABLE_GROUPS_KEY]),
        specialUsable: parseSpecialUsable(options[SPECIAL_USABLE_KEY]),
        scheduledModels: [],
        diagnostics: [],
    };
}

/**
 * 存量客户：逐个迁移。和售卖规则移动客户用同一套检查（options.ts moveInProblems）：
 * 原分组有原生专属倍率或特殊可用分组、有未固定分组的 Key、迁移后 Key 的分组不可用，都拒绝并列出原因。
 */
export async function assignExistingPartnerCustomer(userId: string, tenantId: string): Promise<PartnerAssignResult> {
    const user = await prisma.user.findFirst({
        where: { id: userId, tenant_id: tenantId },
        select: { id: true, email: true, tenant_id: true, newapi_user_id: true, newapi_access_token: true },
    });
    if (!user) throw new PartnerPricingError('客户不存在或不属于该代理。', 404);
    if (!isPartnerTenant(user.tenant_id)) throw new PartnerPricingError('平台客户不能归入代理分组。', 400);
    const result = (status: PartnerAssignResult['status'], problems: string[] = []): PartnerAssignResult => ({
        user_id: user.id,
        email: user.email,
        status,
        problems,
    });
    const newapiUserId = user.newapi_user_id;
    const accessToken = user.newapi_access_token;
    if (newapiUserId == null || !accessToken) return result('blocked', ['客户尚未开通 new-api 账号']);

    const group = partnerUserGroup(tenantId);
    return withOptionSyncLock(async () => {
        const remote = await getUser(newapiUserId);
        if (remote.group === group) return result('already');

        const [options, open, multipliers, tokens] = await Promise.all([
            getSaleRuleOptions(),
            openPartnerGroups(tenantId),
            prisma.userTierMultiplier.count({ where: { user_id: user.id, enabled: true } }),
            listAllCustomerTokens({ accessToken, userId: newapiUserId }),
        ]);
        const problems: string[] = [];
        if (!open.size) problems.push('代理还没有开放任何分组：需要超管设批发率、代理设零售率');
        if (multipliers) problems.push(`客户有 ${multipliers} 条生效中的平台专属倍率或售卖折扣，请先撤销`);
        problems.push(
            ...moveInProblems({
                live: liveSaleOptions(options),
                fromGroup: remote.group ?? '',
                internalGroup: group,
                keyGroups: tokens.map((token) => parseTokenGroups(token.group)),
            }),
        );
        if (problems.length) return result('blocked', problems);

        await updateUserGroupWithReadback({ user: remote, group, operation: 'partner-assign-existing' });
        const reloaded = await getUser(newapiUserId);
        if (reloaded.group !== group) throw new PartnerPricingError('new-api 未按预期保存客户分组，请核对后重试。', 502);
        return result('assigned');
    });
}
