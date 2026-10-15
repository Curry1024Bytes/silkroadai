/** 客户请求日志元数据按每条记录的到期时间分批清理。R2 原文由桶的 7 天生命周期删除。 */
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';

const INTERVAL_MS = 12 * 60 * 60 * 1000;
const BATCH_SIZE = 5000;
const MAX_BATCHES_PER_SWEEP = 20;

let timer: ReturnType<typeof setInterval> | null = null;

export async function sweepExpiredCustomerRequestLogs(now: Date = new Date()): Promise<{ deleted: number }> {
    let deleted = 0;
    for (let i = 0; i < MAX_BATCHES_PER_SWEEP; i++) {
        const batch = await prisma.requestLog.findMany({
            where: { retention_expires_at: { lte: now } },
            select: { id: true },
            take: BATCH_SIZE,
            orderBy: { retention_expires_at: 'asc' },
        });
        if (batch.length === 0) break;
        const result = await prisma.requestLog.deleteMany({ where: { id: { in: batch.map((row) => row.id) } } });
        deleted += result.count;
        if (batch.length < BATCH_SIZE) break;
    }
    if (deleted > 0) console.log(`[reqlog-cleanup] deleted=${deleted} at=${now.toISOString()}`);
    return { deleted };
}

export function startRequestLogCleanupScheduler(): void {
    if (timer) return;
    const run = () => {
        sweepExpiredCustomerRequestLogs().catch((err) => {
            console.error('[reqlog-cleanup] sweep failed:', err);
            Sentry.captureException(err, { tags: { area: 'reqlog-cleanup' } });
        });
    };
    run();
    timer = setInterval(run, INTERVAL_MS);
    console.log('Customer request-log cleanup scheduler started');
}

export function stopRequestLogCleanupScheduler(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
