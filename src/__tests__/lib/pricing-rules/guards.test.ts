import { describe, expect, it, vi } from 'vitest';
import type { prisma } from '@/lib/db';
import { assertGroupsUnmanaged, groupRatioTargets, managedSaleGroups } from '@/lib/pricing-rules/guards';

function db(managed: string[]) {
    const findMany = vi.fn(async (args: { where: { newapi_group: { in: string[] } } }) =>
        managed.filter((group) => args.where.newapi_group.in.includes(group)).map((group) => ({ newapi_group: group })),
    );
    return { client: { pricingBillingGroup: { findMany } } as unknown as typeof prisma, findMany };
}

describe('sale-rule write guards', () => {
    it('reads the GroupRatio keys a V6/V7 plan would write', () => {
        expect(groupRatioTargets({ GroupRatio: { 'pool-gpt': 0.6 } })).toEqual(['pool-gpt']);
        expect(groupRatioTargets({ ModelRatio: { m: 1 } })).toEqual([]);
        expect(groupRatioTargets(null)).toEqual([]);
    });

    it('refuses only groups the compiler manages and skips the query when there is nothing to check', async () => {
        const { client, findMany } = db(['pool-gpt']);
        await expect(assertGroupsUnmanaged(client, ['pool-gpt', 'default'])).rejects.toMatchObject({
            code: 'pricing_sale_rules_managed',
        });
        await expect(assertGroupsUnmanaged(client, ['default'])).resolves.toBeUndefined();
        expect(await managedSaleGroups(client, [])).toEqual(new Set());
        expect(findMany).toHaveBeenCalledTimes(2);
    });
});
