import 'server-only';
import type { Prisma as PrismaTypes } from '@prisma/client';

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
export async function lockPricingPublisher(tx: PrismaTypes.TransactionClient) {
    return tx.pricingPublishCoordinator.upsert({
        where: { id: 'newapi' },
        create: { id: 'newapi', revision: 1 },
        update: { revision: { increment: 1 } },
    });
}

/**
 * Serialize readers of the live pricing snapshot with the pricing publisher
 * without advancing the publication revision. Must run in the same database
 * transaction as every protected read.
 */
export async function lockPricingPublisherReadOnly(tx: PrismaTypes.TransactionClient) {
    await tx.$executeRaw`
        INSERT INTO "pricing_publish_coordinator" ("id", "revision")
        VALUES ('newapi', 1)
        ON CONFLICT ("id") DO NOTHING
    `;
    const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "pricing_publish_coordinator"
        WHERE "id" = 'newapi'
        FOR UPDATE
    `;
    if (rows.length !== 1) throw new Error('pricing publish coordinator row unavailable');
}

export async function assertNoRetirementJob(
    tx: PrismaTypes.TransactionClient,
    options: { retirementJobId?: string } = {},
) {
    const job = await tx.channelGroupRetirementJob.findFirst({
        where: {
            status: { notIn: ['succeeded', 'cancelled'] },
            ...(options.retirementJobId ? { id: { not: options.retirementJobId } } : {}),
        },
        select: { id: true },
    });
    if (job) {
        throw new PricingPublishError(
            'channel_group_retirement_busy',
            '有分组删除任务尚未完成，请先在渠道分组页继续核对 Key，再修改目录或发布价格。',
        );
    }
}

export async function assertPricingCatalogWritable(
    tx: PrismaTypes.TransactionClient,
    options: { retirementJobId?: string } = {},
) {
    const coordinator = await lockPricingPublisher(tx);
    if (coordinator.active_job_id) {
        throw new PricingPublishError(
            'pricing_publish_busy',
            '有价格正在发布或等待处理，请先在定价页完成核验或安全取消，再修改模型、档次或目录价格。',
        );
    }
    await assertNoRetirementJob(tx, options);
}

/**
 * Map a pricing error to a response. Lives here rather than beside the
 * publication chain because the live pricing routes need it and that chain is
 * being removed (docs/2026-11-08-拆除签名发布链路.md).
 */
export function pricingPublishErrorResponse(error: unknown): {
    body: { error: string; message: string };
    status: number;
} {
    if (error instanceof PricingPublishError)
        return { body: { error: error.code, message: error.message }, status: error.status };
    if (error && typeof error === 'object' && 'code' in error && ['P2028', 'P2034'].includes(String(error.code))) {
        return {
            body: { error: 'pricing_publish_busy', message: '价格发布或目录更新正在处理中，请稍后刷新任务状态。' },
            status: 409,
        };
    }
    if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string' &&
        error.code.startsWith('persisted_pricing_')
    ) {
        return {
            body: {
                error: error.code,
                message: '尚不能核对 new-api 已保存的价格。请让维护人员配置并检查价格只读核验连接；当前未发布修改。',
            },
            status: 503,
        };
    }
    return {
        body: {
            error: 'pricing_publish_unavailable',
            message: '价格核验暂不可用，请稍后重试；未确认生效前请查看发布任务状态。',
        },
        status: 503,
    };
}
