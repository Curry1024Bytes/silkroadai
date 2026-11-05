/**
 * Write paths that existed before sale rules must not overwrite a billing group
 * the compiler manages: its GroupRatio and customer rows are compiled outputs,
 * and a direct write would be undone (or mis-priced) at the next publication.
 */
import type { Prisma } from '@prisma/client';
import type { prisma } from '@/lib/db';
import { PricingPublishError } from '@/lib/admin/pricing-publish-lock';

type Db = Prisma.TransactionClient | typeof prisma;

/** new-api groups among `groups` whose GroupRatio the sale-rule compiler owns. */
export async function managedSaleGroups(db: Db, groups: string[]): Promise<Set<string>> {
    const unique = [...new Set(groups)].filter(Boolean);
    if (!unique.length) return new Set();
    const rows = await db.pricingBillingGroup.findMany({
        where: { newapi_group: { in: unique }, unified_sale_ratio: { not: null } },
        select: { newapi_group: true },
    });
    return new Set(rows.map((row) => row.newapi_group));
}

export async function assertGroupsUnmanaged(db: Db, groups: string[]): Promise<void> {
    const managed = [...(await managedSaleGroups(db, groups))];
    if (managed.length)
        throw new PricingPublishError(
            'pricing_sale_rules_managed',
            `计费分组 ${managed.join('、')} 已由售卖规则管理，请在定价页的「售卖规则」中修改统一售卖价。`,
        );
}

/** GroupRatio keys a publication plan target would write. */
export function groupRatioTargets(target: unknown): string[] {
    if (!target || typeof target !== 'object' || !('GroupRatio' in target)) return [];
    const value = (target as { GroupRatio?: unknown }).GroupRatio;
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}
