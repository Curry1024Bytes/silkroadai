export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        // Dev-only outbound proxy. Double-gated: only when NOT in production
        // AND DEV_PROXY_URL is set (e.g. a local mixed/HTTP proxy at
        // http://127.0.0.1:10808). Routes Node's global fetch through it so
        // server-side OAuth token calls to Google/GitHub work from networks
        // that can't reach them directly. In prod (or with the var unset) this
        // block is skipped entirely — undici stays on its default dispatcher,
        // identical behaviour to before. Mirrors the SENTRY_DSN no-op pattern.
        if (process.env.NODE_ENV !== 'production' && process.env.DEV_PROXY_URL) {
            try {
                const { setGlobalDispatcher, ProxyAgent } = await import('undici');
                setGlobalDispatcher(new ProxyAgent(process.env.DEV_PROXY_URL));
                console.log(`[dev-proxy] outbound fetch via ${process.env.DEV_PROXY_URL}`);
            } catch (e) {
                console.warn('[dev-proxy] failed to install proxy dispatcher', e);
            }
        }

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

        // PR-U1: reseller commission hold-release (pending → confirmed after
        // 14d) + monthly settlement auto-create on day 1 UTC. 1h cadence.
        const { startResellerCommissionScheduler } = await import('@/lib/scheduler/reseller-commission');
        startResellerCommissionScheduler();

        // P4a: shadow metering — poll new-api consume logs → UsageRecord (¥ per
        // CatalogPrice). Pure observation, no billing/balance impact. 10m cadence.
        const { startShadowMeterScheduler } = await import('@/lib/scheduler/shadow-meter');
        startShadowMeterScheduler();
    }
}
