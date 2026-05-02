import { describe, it, expect } from 'vitest';
import {
    listAvailableModels,
    checkNewApiHealth,
    quotaToUsd,
    cnyToQuota,
    USD_TO_CNY_RATE,
} from '../client';

/**
 * Smoke test against the real VPS new-api via SSH tunnel:
 *   ssh -fN -L 3000:localhost:3000 -o ServerAliveInterval=60 vps
 *
 * Prereqs:
 *   - .env has NEWAPI_BASE_URL + NEWAPI_ADMIN_TOKEN + NEWAPI_ADMIN_USER_ID
 *     (loaded by vitest.config.ts via dotenv/config)
 *   - tunnel up (so localhost:3000 = VPS new-api)
 *
 * GET-only — does not mutate any new-api state.
 */
describe('new-api client smoke test', () => {
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
