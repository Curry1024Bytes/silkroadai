import 'server-only';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { lockPricingPublisher, PricingPublishError } from './pricing-publish-lock';

const writeInput = z.object({
    job_id: z.string().uuid(),
    key: z.enum(['ModelRatio', 'CompletionRatio', 'ModelPrice', 'billing_setting.billing_expr', 'GroupRatio']),
    request_hash: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Must complete before PUT. This is an independent, committed database write,
 * never the publisher's interactive transaction or its Serializable snapshot. */
export async function beginPricingWrite(
    jobId: string,
    key: 'ModelRatio' | 'CompletionRatio' | 'ModelPrice' | 'billing_setting.billing_expr' | 'GroupRatio',
    requestHash: string,
): Promise<string> {
    const data = writeInput.parse({ job_id: jobId, key, request_hash: requestHash });
    const row = await prisma.$transaction(
        (tx) => tx.pricingPublishWrite.create({ data: { ...data, status: 'in_flight' }, select: { id: true } }),
        { timeout: 10_000, maxWait: 5_000 },
    );
    return row.id;
}

/** Only call after a successful PUT response. If this commit is uncertain too,
 * recovery reads the durable journal; it never infers acknowledgement from GET. */
export async function acknowledgePricingWrite(id: string): Promise<void> {
    await prisma.$transaction(
        (tx) =>
            tx.pricingPublishWrite.update({
                where: { id },
                data: { status: 'acknowledged', acknowledged_at: new Date() },
            }),
        { timeout: 10_000, maxWait: 5_000 },
    );
}

/** Independent read sees entries inserted after the outer transaction started. */
export async function readUncertainPricingWrites(jobId: string) {
    return prisma.pricingPublishWrite.findMany({
        where: { job_id: jobId, status: 'in_flight' },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        select: { id: true, key: true, request_hash: true, created_at: true },
    });
}

const resolutionInput = z.object({
    write_id: z.string().uuid(),
    operator: z.string().trim().min(3).max(120),
    evidence: z.string().trim().min(20).max(4000),
    upstream_requests_ended: z.literal(true),
});

/** Operator-only CLI recovery. This records a human attestation, not automatic
 * proof from price reads. It never releases the job, retries it, or writes new-api. */
export async function resolvePricingWriteManually(input: z.input<typeof resolutionInput>) {
    const attestation = resolutionInput.parse(input);
    return prisma.$transaction(
        async (tx) => {
            const coordinator = await lockPricingPublisher(tx);
            const write = await tx.pricingPublishWrite.findUnique({ where: { id: attestation.write_id } });
            if (!write) throw new PricingPublishError('pricing_write_not_found', '未找到写入记录。', 404);
            if (write.status !== 'in_flight')
                throw new PricingPublishError('pricing_write_not_uncertain', '该记录已不处于未决状态，未做修改。');
            const job = await tx.pricingPublishJob.findUnique({
                where: { id: write.job_id },
                select: { status: true },
            });
            if (coordinator.active_job_id !== write.job_id || !job || ['succeeded', 'cancelled'].includes(job.status)) {
                throw new PricingPublishError(
                    'pricing_job_conflict',
                    '记录不属于当前持锁任务，必须另行排查，未做修改。',
                );
            }
            return tx.pricingPublishWrite.update({
                where: { id: write.id },
                data: {
                    status: 'resolved',
                    resolved_at: new Date(),
                    resolved_by: attestation.operator,
                    resolution_note: attestation.evidence,
                },
                select: { id: true, job_id: true, status: true, resolved_at: true },
            });
        },
        { timeout: 10_000, maxWait: 5_000 },
    );
}
