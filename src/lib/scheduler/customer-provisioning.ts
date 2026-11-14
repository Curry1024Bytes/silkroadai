import * as Sentry from '@sentry/nextjs';
import { runCustomerProvisioningWorker } from '@/lib/auth/customer-provisioning-queue';

const INTERVAL_MS = 5_000;
const BATCH_SIZE = 10;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function sweep(): Promise<void> {
    if (running) return;
    running = true;
    try {
        const processed = await runCustomerProvisioningWorker({ batchSize: BATCH_SIZE });
        if (processed > 0) console.log(`[customer-provisioning] processed=${processed}`);
    } catch (err) {
        console.error('[customer-provisioning] worker failed:', err);
        Sentry.captureException(err, { tags: { area: 'customer-provisioning' } });
    } finally {
        running = false;
    }
}

export function startCustomerProvisioningScheduler(): void {
    if (timer) return;
    void sweep();
    timer = setInterval(() => void sweep(), INTERVAL_MS);
    console.log('Customer provisioning scheduler started');
}

export function stopCustomerProvisioningScheduler(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
}
