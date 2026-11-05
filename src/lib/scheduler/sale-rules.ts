import 'server-only';
import { prisma } from '@/lib/db';
import { runSaleRuleSchedulerTick } from '@/lib/pricing-rules/publish';

/**
 * Timed sale rules only start and end through this pass, so it runs whenever
 * Portal schedulers run. Before any billing group is adopted it does nothing
 * but one database count. Every VERIFY_EVERY-th pass also re-runs the remote
 * customer checks so drift made outside Portal is found.
 */
const INTERVAL_MS = 60_000;
const VERIFY_EVERY = 10;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let passes = 0;

/** False when this process will never run the pass; timed rules must not be saved then. */
export function saleRuleSchedulerEnabled(): boolean {
    if (process.env.PORTAL_FLAVOR === 'seedance-enterprise') return false;
    if (process.env.PORTAL_SCHEDULERS === 'off') return false;
    return process.env.SALE_RULE_SCHEDULER !== 'off';
}

export async function tickSaleRules(): Promise<void> {
    if (running) return;
    running = true;
    try {
        const managed = await prisma.pricingBillingGroup.count({ where: { unified_sale_ratio: { not: null } } });
        if (!managed) return;
        passes += 1;
        await runSaleRuleSchedulerTick(passes % VERIFY_EVERY === 1);
    } catch (error) {
        // Codes and messages only; never request payloads or upstream bodies.
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
        console.warn('[sale-rules] scheduled publication failed; the next pass re-plans from live state', { code });
    } finally {
        running = false;
    }
}

export function startSaleRuleScheduler(): void {
    if (timer || !saleRuleSchedulerEnabled()) return;
    timer = setInterval(() => {
        void tickSaleRules();
    }, INTERVAL_MS);
    timer.unref?.();
    void tickSaleRules();
}

export function stopSaleRuleScheduler(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
