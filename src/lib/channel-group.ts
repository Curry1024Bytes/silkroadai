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
