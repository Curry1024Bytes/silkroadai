/**
 * PR-T2 — image-models data invariants.
 *
 * The dropdown lineup must reference SKU ids that the server-side
 * IMAGE_MODELS whitelist accepts; otherwise the generate handler
 * 400s on every dispatch. This test runs the cross-table check.
 */
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_IMAGE_MODEL_ID,
    IMAGE_COUNT_OPTIONS,
    IMAGE_MODEL_OPTIONS,
    IMAGE_SIZE_OPTIONS,
    PROMPT_MAX_CHARS,
    SAMPLE_PROMPTS,
} from '@/data/image-models';
import { IMAGE_MODEL_IDS } from '@/lib/image-gen/models';

describe('IMAGE_MODEL_OPTIONS', () => {
    it('lists 5 models per the operator brief', () => {
        expect(IMAGE_MODEL_OPTIONS).toHaveLength(5);
    });

    it('every option references an id in the server-side whitelist', () => {
        for (const m of IMAGE_MODEL_OPTIONS) {
            expect(IMAGE_MODEL_IDS, `${m.id} must be a server-recognized SKU`).toContain(m.id);
        }
    });

    it('default selection is the first entry (Nano Banana)', () => {
        expect(DEFAULT_IMAGE_MODEL_ID).toBe(IMAGE_MODEL_OPTIONS[0].id);
        expect(IMAGE_MODEL_OPTIONS[0].label).toBe('Nano Banana');
        // The cheap entry. Post-PR #55 (Gemini +10% markup): ¥0.30/张
        // (= $0.0429 × 7). Floating-point safe within ±0.01.
        expect(IMAGE_MODEL_OPTIONS[0].pricePerImageCny).toBeCloseTo(0.3, 2);
    });

    it('CNY prices are USD × 7 (within rounding)', () => {
        for (const m of IMAGE_MODEL_OPTIONS) {
            const expected = Math.round(m.pricePerImageUsd * 7 * 100) / 100;
            expect(m.pricePerImageCny).toBeCloseTo(expected, 2);
        }
    });

    it('every option has label / blurb / positive price', () => {
        for (const m of IMAGE_MODEL_OPTIONS) {
            expect(m.label).toBeTruthy();
            expect(m.blurb).toBeTruthy();
            expect(m.pricePerImageUsd).toBeGreaterThan(0);
            expect(m.pricePerImageCny).toBeGreaterThan(0);
        }
    });

    it('badges (推荐 / 旗舰) are limited to 1 each', () => {
        const badges = IMAGE_MODEL_OPTIONS.map((m) => m.badge).filter(Boolean);
        const counts = badges.reduce<Record<string, number>>((acc, b) => {
            acc[b!] = (acc[b!] ?? 0) + 1;
            return acc;
        }, {});
        for (const c of Object.values(counts)) {
            expect(c).toBe(1);
        }
    });
});

describe('IMAGE_SIZE_OPTIONS', () => {
    it('lists the 3 supported aspect ratios', () => {
        expect(IMAGE_SIZE_OPTIONS.map((s) => s.id)).toEqual(['1024x1024', '1024x1792', '1792x1024']);
    });
});

describe('IMAGE_COUNT_OPTIONS', () => {
    it('lists 1..4', () => {
        expect(IMAGE_COUNT_OPTIONS).toEqual([1, 2, 3, 4]);
    });
});

describe('PROMPT_MAX_CHARS', () => {
    it('matches the server-side cap (1000)', () => {
        expect(PROMPT_MAX_CHARS).toBe(1000);
    });
});

describe('SAMPLE_PROMPTS', () => {
    it('lists ≥ 4 sample prompts', () => {
        expect(SAMPLE_PROMPTS.length).toBeGreaterThanOrEqual(4);
    });
    it('every sample is a non-empty string ≤ PROMPT_MAX_CHARS', () => {
        for (const s of SAMPLE_PROMPTS) {
            expect(typeof s).toBe('string');
            expect(s.length).toBeGreaterThan(0);
            expect(s.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
        }
    });
});
