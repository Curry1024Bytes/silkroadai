export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        // W5 D4: Sentry server-side init. Conditional on SENTRY_DSN — empty
        // env keeps SDK in no-op mode so dev / test runs don't ship anywhere.
        // Path is `../sentry.server.config` — Next looks for the config at
        // the project root, but this instrumentation hook lives under src/.
        await import('../sentry.server.config');

        const { startTimeoutScheduler } = await import('@/lib/order/timeout');
        startTimeoutScheduler();

        // W6 D2: balance-low retention alerts. 1h cadence.
        const { startBalanceAlertScheduler } = await import('@/lib/scheduler/balance-alert');
        startBalanceAlertScheduler();

        // PR-T1 Phase 4: image-generation TTL + soft-delete sweep. 6h cadence.
        const { startImageCleanupScheduler } = await import('@/lib/scheduler/image-cleanup');
        startImageCleanupScheduler();
    }
}
