import 'server-only';
import type { Prisma } from '@prisma/client';

export class PricingPublishError extends Error {
    constructor(
        public code: string,
        message: string,
        public status = 409,
    ) {
        super(message);
        this.name = 'PricingPublishError';
    }
}

/** Must run inside the same transaction as the protected mutations. No expiring
 * lease: the database releases this mutex only on transaction end/disconnection. */
export async function lockPricingPublisher(tx: Prisma.TransactionClient) {
    return tx.pricingPublishCoordinator.upsert({
        where: { id: 'newapi' },
        create: { id: 'newapi', revision: 1 },
        update: { revision: { increment: 1 } },
    });
}

export async function assertPricingCatalogWritable(tx: Prisma.TransactionClient) {
    const coordinator = await lockPricingPublisher(tx);
    if (coordinator.active_job_id) {
        throw new PricingPublishError(
            'pricing_publish_busy',
            '有价格正在发布或等待处理，请先在定价页完成核验或安全取消，再修改模型、档次或目录价格。',
        );
    }
}
