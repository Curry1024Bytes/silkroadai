import { beforeEach, describe, expect, it, vi } from 'vitest';
const findMany = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({ prisma: { customerModelBillingGroup: { findMany } } }));
import { resolveInternalBillingLogTier } from '../log-binding';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
beforeEach(() => {
    vi.clearAllMocks();
    findMany.mockResolvedValue([]);
});
describe('internal billing log ownership', () => {
    it('resolves a registered group and replica channel to the original logical tier', async () => {
        findMany.mockResolvedValue([{ tier_key: 'sd-tier' }]);
        await expect(resolveInternalBillingLogTier(null, 'private-model', 91)).resolves.toEqual({ key: 'sd-tier' });
        expect(findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    OR: [{ tenant_id: PLATFORM_TENANT_ID }, { tenant_id: null }],
                    internal_group: 'private-model',
                    replica_channel_ids: { has: 91 },
                },
            }),
        );
    });
    it('does not guess ownership from a name or a missing channel', async () => {
        await expect(resolveInternalBillingLogTier('tenant-a', 'portal-price-unknown', 92)).resolves.toBeNull();
        await expect(resolveInternalBillingLogTier('tenant-a', 'private-model', 0)).resolves.toBeNull();
        expect(findMany).toHaveBeenCalledTimes(1);
    });
    it('refuses an ambiguous registration and isolates partner tenants', async () => {
        findMany.mockResolvedValue([{ tier_key: 'one' }, { tier_key: 'two' }]);
        await expect(resolveInternalBillingLogTier('tenant-b', 'private-model', 91)).resolves.toBeNull();
        expect(findMany.mock.calls[0][0].where.tenant_id).toBe('tenant-b');
        expect(findMany.mock.calls[0][0].where.OR).toBeUndefined();
    });
});
