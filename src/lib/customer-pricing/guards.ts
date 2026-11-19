import 'server-only';
import { prisma } from '@/lib/db';
import { CustomerPricingError } from './math';

export async function assertLegacyCustomerPricingWritable(userId: string): Promise<void> {
    const active = await prisma.customerPricingBinding.findFirst({ where: { user_id: userId }, select: { id: true } });
    if (active)
        throw new CustomerPricingError(
            'official_pricing_managed',
            '该客户已启用官方基准专属定价，请在新的专属定价面板调整；旧倍率入口仅用于查看。',
        );
}

export async function assertTierOutsideSaleRules(tierKey: string): Promise<void> {
    const managed = await prisma.pricingBillingGroup.findFirst({
        where: { tier_key: tierKey, unified_sale_ratio: { not: null } },
        select: { id: true },
    });
    if (managed)
        throw new CustomerPricingError(
            'sale_rules_managed',
            '该分组已被旧售卖规则管理，请先解除该管理方式后再设置官方基准专属价。',
        );
}

export async function assertNoOfficialBindingsForTier(tierKey: string): Promise<void> {
    const active = await prisma.customerPricingBinding.findFirst({
        where: { tier_key: tierKey },
        select: { id: true },
    });
    if (active)
        throw new CustomerPricingError(
            'official_pricing_managed',
            '该分组已有官方基准客户定价，不能同时启用旧售卖规则。',
        );
}
