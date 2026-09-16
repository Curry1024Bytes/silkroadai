import { PLATFORM_TENANT_ID, tenantScope } from './tenant-scope';
import type { AdminPrincipal } from './auth';

/** Historical null users belong to the platform, matching customer key creation. */
export function retirementTenantId(tenantId: string | null): string {
    return tenantId ?? PLATFORM_TENANT_ID;
}

export function retirementTenantScope(tenantId: string | null) {
    const canonical = retirementTenantId(tenantId);
    return canonical === PLATFORM_TENANT_ID
        ? { OR: [{ tenant_id: PLATFORM_TENANT_ID }, { tenant_id: null }] }
        : { tenant_id: canonical };
}

export function retirementAdminScope(admin: AdminPrincipal) {
    const scope = tenantScope(admin);
    return scope.tenant_id ? retirementTenantScope(scope.tenant_id) : {};
}
