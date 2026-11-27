import 'server-only';

import { listEnabledChannelGroups } from '@/lib/channel-group';
import { isPartnerTenant } from '@/lib/partner/group';
import { openPartnerGroups } from '@/lib/partner/pricing-sync';

/**
 * 客户可选的档次。代理客户只看得到代理已开放（设了零售率）的分组；
 * new-api 那边也会拒绝未开放分组的 Key，这里让页面和接口提前一致。
 * 平台客户的默认档次不走这里（注册入口用 getDefaultChannelGroup 保持拓扑校验）。
 */
export async function listCustomerTierGroups(tenantId: string | null) {
    const groups = await listEnabledChannelGroups(tenantId);
    if (!isPartnerTenant(tenantId)) return groups;
    const open = await openPartnerGroups(tenantId);
    return groups.filter((group) => open.has(group.newapi_group));
}
