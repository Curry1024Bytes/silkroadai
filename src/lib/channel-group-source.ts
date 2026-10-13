import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

/** Opt in per deployment; partner-owned catalogs retain their existing controls. */
export function mirrorsNewApiGroups(tenantId: string | null = null): boolean {
    return process.env.NEWAPI_GROUP_SYNC_MODE === 'mirror' && (tenantId ?? PLATFORM_TENANT_ID) === PLATFORM_TENANT_ID;
}

export const mirroredGroupMessage = '分组由 new-api 管理，请在 new-api 修改后刷新；Portal 只设置默认分组。';
