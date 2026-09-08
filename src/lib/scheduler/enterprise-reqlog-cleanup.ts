/**
 * 企业请求日志保留期清理(2026-09-03)。
 *
 * enterprise_request_logs 按 ENTERPRISE_REQLOG_RETENTION_DAYS(默认 60 天)滚动删除。
 * 跑在【主站实例】(镜像 image-cleanup 模式,由 src/instrumentation.ts 挂载)——
 * 企业实例 instrumentation 门不跑定时任务,但两实例同库,主站清得到。
 * deleteMany 幂等,多实例并发安全;每次分批删防长事务锁表。
 */
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { reqlogRetentionDays } from '@/lib/enterprise/request-log';

const INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h 一趟(日志表,清理不急)
const BATCH_SIZE = 5000; // 单批删除上限,防一次大 DELETE 长时间持锁
const MAX_BATCHES_PER_SWEEP = 20; // 单趟最多 10 万行,剩的留下一趟

let timer: ReturnType<typeof setInterval> | null = null;

/** 单趟清理。导出供测试直接驱动。 */
export async function sweepExpiredRequestLogs(now: Date = new Date()): Promise<{ deleted: number }> {
    const cutoff = new Date(now.getTime() - reqlogRetentionDays() * 24 * 60 * 60 * 1000);
    let deleted = 0;
    for (let i = 0; i < MAX_BATCHES_PER_SWEEP; i++) {
        const batch = await prisma.enterpriseRequestLog.findMany({
            where: { created_at: { lt: cutoff } },
            select: { id: true },
            take: BATCH_SIZE,
            orderBy: { created_at: 'asc' },
        });
        if (batch.length === 0) break;
        const r = await prisma.enterpriseRequestLog.deleteMany({
            where: { id: { in: batch.map((b) => b.id) } },
        });
        deleted += r.count;
        if (batch.length < BATCH_SIZE) break;
    }
    if (deleted > 0) {
        console.log(`[enterprise-reqlog-cleanup] sweep complete: deleted=${deleted} cutoff=${cutoff.toISOString()}`);
    }
    return { deleted };
}

export function startEnterpriseReqlogCleanupScheduler(): void {
    if (timer) return;
    sweepExpiredRequestLogs().catch((err) => {
        console.error('[enterprise-reqlog-cleanup] initial sweep failed:', err);
        Sentry.captureException(err, { tags: { area: 'enterprise-reqlog-cleanup' } });
    });
    timer = setInterval(() => {
        sweepExpiredRequestLogs().catch((err) => {
            console.error('[enterprise-reqlog-cleanup] scheduled sweep failed:', err);
            Sentry.captureException(err, { tags: { area: 'enterprise-reqlog-cleanup' } });
        });
    }, INTERVAL_MS);
    console.log('Enterprise request-log cleanup scheduler started');
}

export function stopEnterpriseReqlogCleanupScheduler(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
