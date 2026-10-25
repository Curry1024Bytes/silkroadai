/**
 * 企业任务对账定时 sweep(2026-10-19)。
 *
 * 对账器(enterprise/reconcile.ts)此前只在客户打开概览 / 日志页、导出时按需跑 —— 客户提交后
 * 不再轮询也不开页面,任务就一直 queued 且不计费(智象 10-18:31 条 global 任务滞留 ≈ ¥50)。
 * 本 sweep 跑在【主站实例】(instrumentation 门:企业实例不跑定时任务,但两实例同库),
 * 每 10 分钟找出有滞留任务的客户,逐个调 reconcileStaleTasks(每客户每趟最多 20 条,对账器自带
 * 幂等扣费 + 48h 过期终态 + 回调投递)。主站实例的 .env 必须配齐各线上游 key
 * (SEEDANCE_SVCINF_{KEY,PROMAX_KEY,GLOBAL_KEY} / ENTERPRISE_VOLC_UPSTREAM_KEY),否则对应 region 的
 * 任务只会「这次没查到」留给下趟。
 */
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { ENTERPRISE_TIER } from '@/lib/enterprise/billing';
import { reconcileStaleTasks } from '@/lib/enterprise/reconcile';

const INTERVAL_MS = 10 * 60 * 1000;
const STALE_AFTER_MS = 90 * 1000; // 与 reconcile.ts 同口径
const MAX_USERS_PER_SWEEP = 50;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** 单趟:找出有滞留任务的客户 → 逐个对账。导出供测试直接驱动。 */
export async function sweepStaleEnterpriseTasks(now: Date = new Date()): Promise<{ users: number }> {
    if (running) return { users: 0 };
    running = true;
    try {
        const rows = await prisma.seedanceVideoTask.findMany({
            where: {
                tier: ENTERPRISE_TIER,
                OR: [{ status: { in: ['queued', 'in_progress'] } }, { status: 'completed', billed: false }],
                created_at: { lt: new Date(now.getTime() - STALE_AFTER_MS) },
            },
            distinct: ['user_id'],
            select: { user_id: true },
            take: MAX_USERS_PER_SWEEP,
        });
        for (const r of rows) {
            try {
                await reconcileStaleTasks(r.user_id);
            } catch (e) {
                console.warn('[enterprise-reconcile-sweep] user failed', { user_id: r.user_id, err: String(e) });
            }
        }
        if (rows.length > 0) console.log(`[enterprise-reconcile-sweep] sweep complete: users=${rows.length}`);
        return { users: rows.length };
    } finally {
        running = false;
    }
}

export function startEnterpriseReconcileSweepScheduler(): void {
    if (timer || process.env.PORTAL_ENTERPRISE_RECONCILE_ENABLED !== 'true') return;
    sweepStaleEnterpriseTasks().catch((err) => {
        console.error('[enterprise-reconcile-sweep] initial sweep failed:', err);
        Sentry.captureException(err, { tags: { area: 'enterprise-reconcile-sweep' } });
    });
    timer = setInterval(() => {
        sweepStaleEnterpriseTasks().catch((err) => {
            console.error('[enterprise-reconcile-sweep] scheduled sweep failed:', err);
            Sentry.captureException(err, { tags: { area: 'enterprise-reconcile-sweep' } });
        });
    }, INTERVAL_MS);
    console.log('Enterprise reconcile sweep scheduler started');
}

export function stopEnterpriseReconcileSweepScheduler(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
