import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';
import { lockPricingPublisher, PricingPublishError } from '@/lib/admin/pricing-publish-lock';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

const context = new AsyncLocalStorage<{ tx: Prisma.TransactionClient; deadline: number }>();

/** Revalidate the live database mutex before remote calls and before exposing a
 * newly issued credential. A timed-out transaction must not keep creating keys. */
export async function customerKeyMutationTimeout(): Promise<number | undefined> {
    const current = context.getStore();
    if (!current) return undefined;
    await lockPricingPublisher(current.tx);
    const remaining = current.deadline - Date.now();
    if (remaining <= 0) {
        throw new PricingPublishError('key_mutation_expired', 'Key 操作超时，请稍后核对结果。');
    }
    return Math.min(10_000, remaining);
}

/** Serializes the complete remote-create/local-persist lifecycle with retirement
 * enqueue. Other tiers remain available while a retirement awaits recovery. */
export async function withCustomerKeyMutation<T>(
    scope: { tenantId: string | null; tierKey: string; newapiGroup: string; requireDefault?: boolean },
    work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
    const { prisma } = await import('@/lib/db');
    return prisma.$transaction(
        async (tx) => {
            await lockPricingPublisher(tx);
            const tenantId = scope.tenantId ?? PLATFORM_TENANT_ID;
            const job = await tx.channelGroupRetirementJob.findFirst({
                where: {
                    OR: [{ tenant_id: tenantId }, ...(tenantId === PLATFORM_TENANT_ID ? [{ tenant_id: null }] : [])],
                    tier_key: scope.tierKey,
                    status: { notIn: ['succeeded', 'cancelled'] },
                },
                select: { id: true },
            });
            if (job) {
                throw new PricingPublishError('tier_retiring', '这个分组正在下架，请选择其他分组。');
            }
            const tier = await tx.channelGroup.findFirst({
                where: {
                    tenant_id: tenantId,
                    key: scope.tierKey,
                    newapi_group: scope.newapiGroup,
                    enabled: true,
                    ...(scope.requireDefault ? { is_default: true } : {}),
                },
                select: { id: true },
            });
            if (!tier) throw new PricingPublishError('tier_unavailable', '分组配置已变化，请刷新后重试。');
            return context.run({ tx, deadline: Date.now() + 90_000 }, () => work(tx));
        },
        { timeout: 120_000, maxWait: 5_000 },
    );
}
