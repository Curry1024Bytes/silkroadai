import 'server-only';
import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

/** Historical logs resolve by persisted ownership, never by an internal-looking name prefix. */
export async function resolveInternalBillingLogTier(
    tenantId: string | null,
    group: string,
    channelId: number,
): Promise<{ key: string } | null> {
    if (!group || !Number.isSafeInteger(channelId) || channelId <= 0) return null;
    const tenant = tenantId ?? PLATFORM_TENANT_ID;
    const rows = await prisma.customerModelBillingGroup.findMany({
        where: {
            ...(tenant === PLATFORM_TENANT_ID
                ? { OR: [{ tenant_id: tenant }, { tenant_id: null }] }
                : { tenant_id: tenant }),
            internal_group: group,
            replica_channel_ids: { has: channelId },
        },
        select: { tier_key: true },
        take: 2,
    });
    return rows.length === 1 ? { key: rows[0].tier_key } : null;
}
