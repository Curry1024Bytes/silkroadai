import { beforeAll, describe, it, expect } from 'vitest';
import { listAvailableModels, checkNewApiHealth, quotaToUsd, cnyToQuota, USD_TO_CNY_RATE } from '../client';
import { checkNewapiSmokeTarget } from '../../../../scripts/check-newapi-smoke-target';

/**
 * Smoke test against the real VPS new-api via SSH tunnel:
 *   Use the tunnel in deploy/部署与运维手册.md §7.3 (remote 172.17.0.1:3000).
 *   NEWAPI_BASE_URL=http://127.0.0.1:18082 pnpm test:smoke
 *
 * Prereqs:
 *   - .env has NEWAPI_BASE_URL + NEWAPI_ADMIN_TOKEN + NEWAPI_ADMIN_USER_ID
 *     (loaded by vitest.config.ts via dotenv/config)
 *   - tunnel up; use its actual IPv4 port to avoid another app on localhost/IPv6
 *
 * GET-only — does not mutate any new-api state.
 */
describe('new-api client smoke test', () => {
    beforeAll(async () => {
        const target = await checkNewapiSmokeTarget(process.env.NEWAPI_BASE_URL || 'http://localhost:3000');
        if (!target.ok) throw new Error(`new-api smoke target rejected: ${target.origin ?? ''} ${target.reason}`);
    }, 10_000);

    it('responds to health check', async () => {
        const ok = await checkNewApiHealth();
        expect(ok).toBe(true);
    });

    it('lists available models from VPS new-api', async () => {
        const models = await listAvailableModels();
        expect(models).toBeInstanceOf(Array);
        expect(models.length).toBeGreaterThan(0);
        const sorted = [...models].sort();
        console.log(`  Found ${models.length} models:`);
        for (const m of sorted) console.log(`    - ${m}`);
    });

    it('quota conversion is reversible', () => {
        // 100 CNY → quota → quotaToUsd → * cnyRate ≈ 100 CNY
        const quota = cnyToQuota(100);
        const usd = quotaToUsd(quota);
        const cny = usd * USD_TO_CNY_RATE;
        expect(Math.abs(cny - 100)).toBeLessThan(0.01);
    });
});
