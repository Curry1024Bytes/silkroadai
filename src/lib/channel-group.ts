import 'server-only';
import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

/**
 * 客户可选的档次 = 某 tenant 下 enabled 的 ChannelGroup,按 tier_level 升序
 * (pool=0 在前,official=1 在后)。null tenant_id → 平台主体。
 *
 * 用在:建 key 校验/解析档次(/api/portal/keys POST)+ /keys 页渲染档次单选。
 */
export async function listEnabledChannelGroups(tenantId: string | null) {
    return prisma.channelGroup.findMany({
        where: { tenant_id: tenantId ?? PLATFORM_TENANT_ID, enabled: true },
        orderBy: { tier_level: 'asc' },
    });
}

/**
 * Per-customer 档次门:若 user.allowed_tier_keys 非空,把可见/可建档次收窄到
 * 这些 key;空数组 = 不限制(看本 tenant 全部 enabled,现状)。
 *
 * 纯函数(不查库)—— 同时用在 /keys 页(收窄展示)和建 key POST(收窄校验),
 * 保证两处用同一套规则。运维按客户在 User.allowed_tier_keys 设值;通用 admin
 * UI 待做。
 */
export function restrictGroupsForUser<T extends { key: string }>(groups: T[], allowedTierKeys: string[]): T[] {
    if (!allowedTierKeys || allowedTierKeys.length === 0) return groups;
    const allow = new Set(allowedTierKeys);
    return groups.filter((g) => allow.has(g.key));
}
