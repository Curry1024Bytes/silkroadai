/**
 * P4a — 影子计量 scheduler. 每 10 分钟轮询一次 new-api 日志 → 写 UsageRecord(只读账)。
 * 镜像 `src/lib/scheduler/balance-alert.ts`,从 `src/instrumentation.ts` 随 Next server 启动。
 *
 * 纯观察:runShadowMeter 只 GET new-api 日志 + 写 portal usage_records / usage_meter_cursor,
 * 不扣余额、不挡请求、不改充值、不调 new-api 写接口(P4a 边界)。
 */
import * as Sentry from '@sentry/nextjs';
import { runShadowMeter } from '@/lib/billing/meter';

const INTERVAL_MS = 10 * 60 * 1_000; // 10 分钟

let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
    try {
        const r = await runShadowMeter();
        if (r.recorded > 0 || r.unmatched > 0 || r.skippedNoUser > 0) {
            console.log(
                `[shadow-meter] cursor ${r.cursorBefore}→${r.cursorAfter} pages=${r.pagesFetched} fetched=${r.fetched} recorded=${r.recorded} matched=${r.matched} unmatched=${r.unmatched} skippedNoUser=${r.skippedNoUser}`,
            );
        }
    } catch (err) {
        console.error('[shadow-meter] scan failed:', err);
        Sentry.captureException(err, { tags: { area: 'shadow-meter' } });
    }
}

export function startShadowMeterScheduler(): void {
    if (timer) return;

    // 启动时跑一轮(错误吞掉,别让启动期 DB/new-api 抖动拖垮 Next server;tick 内已隔离)。
    void tick();

    timer = setInterval(() => {
        void tick();
    }, INTERVAL_MS);

    console.log('Shadow meter scheduler started');
}

export function stopShadowMeterScheduler(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
        console.log('Shadow meter scheduler stopped');
    }
}
