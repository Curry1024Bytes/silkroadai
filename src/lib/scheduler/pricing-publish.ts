import 'server-only';
import { runPricingPublisherOnce } from '@/lib/admin/pricing-publish';

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function tickPricingPublisher() {
    if (running) return;
    running = true;
    try {
        await runPricingPublisherOnce();
    } catch {
        // Never log driver/API payloads. Intent remains in PostgreSQL and the
        // next tick reads remote state before attempting another write.
        console.warn('[pricing-publisher] attempt interrupted; durable intent retained');
    } finally {
        running = false;
    }
}

export function startPricingPublishScheduler() {
    if (timer || !process.env.NEWAPI_PRICING_DATABASE_URL?.trim()) return;
    timer = setInterval(() => {
        void tickPricingPublisher();
    }, 10_000);
    timer.unref?.();
    void tickPricingPublisher();
}

export function stopPricingPublishScheduler() {
    if (timer) clearInterval(timer);
    timer = null;
}
