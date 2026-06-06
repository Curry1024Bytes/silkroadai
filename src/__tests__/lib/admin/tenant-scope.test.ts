import { describe, expect, it } from 'vitest';
import { tenantScope, tenantForInsert, PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

describe('tenantScope', () => {
    it('returns {} for superadmin (no filter — sees all tenants)', () => {
        expect(tenantScope({ role: 'superadmin', tenant_id: 'tenant-x' })).toEqual({});
        expect(tenantScope({ role: 'superadmin', tenant_id: null })).toEqual({});
    });

    it('filters admin / staff to their own tenant', () => {
        expect(tenantScope({ role: 'admin', tenant_id: 'tenant-x' })).toEqual({ tenant_id: 'tenant-x' });
        expect(tenantScope({ role: 'staff', tenant_id: 'tenant-y' })).toEqual({ tenant_id: 'tenant-y' });
    });

    it('falls back to the platform tenant when an admin / staff tenant_id is null', () => {
        expect(tenantScope({ role: 'admin', tenant_id: null })).toEqual({ tenant_id: PLATFORM_TENANT_ID });
        expect(tenantScope({ role: 'staff', tenant_id: null })).toEqual({ tenant_id: PLATFORM_TENANT_ID });
    });

    it('scopes a customer too (defensive — never an admin in practice)', () => {
        expect(tenantScope({ role: 'customer', tenant_id: 'tenant-z' })).toEqual({ tenant_id: 'tenant-z' });
    });
});

describe('tenantForInsert', () => {
    it('uses the admin tenant_id when present', () => {
        expect(tenantForInsert({ tenant_id: 'tenant-x' })).toBe('tenant-x');
    });

    it('falls back to the platform tenant when null (P1 superadmin / break-glass)', () => {
        expect(tenantForInsert({ tenant_id: null })).toBe(PLATFORM_TENANT_ID);
    });
});

describe('PLATFORM_TENANT_ID', () => {
    it('matches the fixed UUID the migration inserts (drift guard)', () => {
        // Must stay in lockstep with prisma/migrations/*_add_user_role_and_tenant.
        expect(PLATFORM_TENANT_ID).toBe('00000000-0000-0000-0000-000000000001');
    });
});
