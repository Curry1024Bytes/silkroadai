import { describe, it, expect } from 'vitest';
import { listModels, checkLiteLLMHealth } from '../client';

/**
 * Smoke test — calls the real VPS LiteLLM via SSH tunnel (localhost:4000).
 *
 * Prereqs:
 *   1. SSH tunnel up: `ssh -fN -L 4000:localhost:4000 root@23.27.113.88`
 *   2. .env has LITELLM_BASE_URL + LITELLM_MASTER_KEY (loaded by
 *      vitest.config.ts via dotenv/config)
 *
 * GET-only — does not mutate any LiteLLM state.
 */
describe('LiteLLM client smoke test', () => {
    it('liveliness endpoint responds', async () => {
        const result = await checkLiteLLMHealth();
        expect(result).toBeDefined();
        console.log('  Health response:', result);
    });

    it('lists at least 10 models', async () => {
        const result = await listModels();
        expect(result.data).toBeInstanceOf(Array);
        expect(result.data.length).toBeGreaterThanOrEqual(10);

        const modelIds = result.data.map((m) => m.id).sort();
        console.log(`  Found ${modelIds.length} models:`);
        for (const id of modelIds) console.log(`    - ${id}`);
    });

    it('at least 80% of expected models are present', async () => {
        const result = await listModels();
        const ids = new Set(result.data.map((m) => m.id));

        // Silk Road AI 已配置的核心模型 sanity check
        const expected = ['claude-opus-4-7', 'deepseek-v4-flash', 'qwen3.6', 'glm-5'];
        const present = expected.filter((id) => ids.has(id));
        const missing = expected.filter((id) => !ids.has(id));

        const ratio = present.length / expected.length;
        console.log(
            `  Expected ${expected.length} core models, found ${present.length} (${(ratio * 100).toFixed(0)}%)`,
        );
        if (missing.length > 0) console.log(`  Missing: ${missing.join(', ')}`);

        expect(
            ratio,
            `only ${present.length}/${expected.length} expected models present (missing: ${missing.join(', ')})`,
        ).toBeGreaterThanOrEqual(0.8);
    });
});
