import 'server-only';

import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

/** new-api User.group 上限 64。前缀 8 + UUID 去横线 32 = 40。 */
export function partnerUserGroup(tenantId: string): string {
    return `partner-${tenantId.replaceAll('-', '')}`;
}

export function isPartnerUserGroup(group: string): boolean {
    return /^partner-[0-9a-f]{32}$/.test(group);
}

/** 非平台主体的租户就是白标代理；其客户的价格由代理定。 */
export function isPartnerTenant(tenantId: string | null | undefined): tenantId is string {
    return tenantId != null && tenantId !== PLATFORM_TENANT_ID;
}
