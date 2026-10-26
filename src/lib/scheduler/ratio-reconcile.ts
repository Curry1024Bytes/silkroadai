import * as Sentry from '@sentry/nextjs';
import { reconcileCustomerRatios } from '@/lib/newapi/customer-ratio';

/**
 * 客户专属倍率对账(2026-10-25)。每小时把 portal 留痕与 new-api 矩阵 / 用户分组比对一次,
 * 有漂移就 console.error + Sentry —— 07-24 分组倍率双入口互相覆盖、多收客户 ¥5,593 的事故,
 * 根子是没有一份"应该是什么"的记录可以对回去。这里就是那份记录的守卫。
 */
const INTERVAL_MS = 60 * 60 * 1_000;
let timer: ReturnType<typeof setInterval> | null = null;

export async function runRatioReconcile(): Promise<{ checked: number; drifts: number }> {
    const { checked, drifts } = await reconcileCustomerRatios();
    if (drifts.length > 0) {
        console.error('[ratio-reconcile] drift detected', JSON.stringify(drifts));
        Sentry.captureMessage('customer special-ratio drift', {
            level: 'error',
            extra: { drifts },
        });
    } else {
        console.log(`[ratio-reconcile] ok: ${checked} customers in sync`);
    }
    return { checked, drifts: drifts.length };
}

export function startRatioReconcileScheduler(): void {
    if (timer) return;
    const tick = () =>
        runRatioReconcile().catch((err) => {
            console.error('[ratio-reconcile] pass failed:', err);
        });
    // 启动后 2 分钟首跑(让 new-api 连通稳定),之后每小时
    setTimeout(tick, 2 * 60 * 1_000);
    timer = setInterval(tick, INTERVAL_MS);
}

export function stopRatioReconcileScheduler(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
