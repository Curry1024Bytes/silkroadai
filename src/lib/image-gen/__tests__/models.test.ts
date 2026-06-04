/**
 * PR-T1 Phase 3 — IMAGE_MODELS whitelist invariants.
 *
 * Pure-data assertions; no mocks. Catches table drift (missing fields,
 * unknown SKUs, price misformat).
 */
import { describe, expect, it } from 'vitest';

import {
    findImageModel,
    IMAGE_COUNT_MAX,
    IMAGE_COUNT_MIN,
    IMAGE_MODEL_IDS,
    IMAGE_MODELS,
    IMAGE_SIZES,
    sizeToAspectRatio,
} from '@/lib/image-gen/models';

describe('IMAGE_MODELS table', () => {
    it('lists at least 4 models (PR-S apply has 5 routable image SKUs)', () => {
        expect(IMAGE_MODELS.length).toBeGreaterThanOrEqual(4);
    });

    it('every entry has id, label, blurb, finite positive price', () => {
        for (const m of IMAGE_MODELS) {
            expect(m.id).toBeTruthy();
            expect(m.label).toBeTruthy();
            expect(m.blurb).toBeTruthy();
            expect(m.pricePerImageUsd).toBeGreaterThan(0);
            expect(Number.isFinite(m.pricePerImageUsd)).toBe(true);
        }
    });

    it('IMAGE_MODEL_IDS mirrors IMAGE_MODELS in order', () => {
        expect(IMAGE_MODEL_IDS).toEqual(IMAGE_MODELS.map((m) => m.id));
    });

    it('contains the PR-S core SKUs (gpt-image-2 + nano-banana-pro-preview + flash variants)', () => {
        expect(IMAGE_MODEL_IDS).toContain('gpt-image-2');
        expect(IMAGE_MODEL_IDS).toContain('nano-banana-pro-preview');
        expect(IMAGE_MODEL_IDS).toContain('gemini-3.1-flash-image-preview');
    });

    it('does NOT include the unrouted gemini-2.5-flash-image-preview (PR-S 2.5 cleanup; canonical name is gemini-2.5-flash-image)', () => {
        expect(IMAGE_MODEL_IDS).not.toContain('gemini-2.5-flash-image-preview');
    });

    it('includes the canonical Nano Banana SKU (gemini-2.5-flash-image, re-added 2026-05-09 evening for PR-T2)', () => {
        expect(IMAGE_MODEL_IDS).toContain('gemini-2.5-flash-image');
    });
});

describe('findImageModel', () => {
    it('returns the entry for known ids', () => {
        const m = findImageModel('gpt-image-2');
        expect(m?.label).toBe('GPT Image 2');
    });

    it('returns undefined for unknown ids', () => {
        expect(findImageModel('this-model-does-not-exist')).toBeUndefined();
    });
});

describe('geminiImageSize routing flag (W8 D8 — native /v1beta resolution)', () => {
    it('gemini-3.1-flash-image-preview is billed/served at 2K', () => {
        expect(findImageModel('gemini-3.1-flash-image-preview')?.geminiImageSize).toBe('2K');
    });

    it('gemini-3-pro-image-preview + nano-banana-pro-preview are served at 4K', () => {
        expect(findImageModel('gemini-3-pro-image-preview')?.geminiImageSize).toBe('4K');
        expect(findImageModel('nano-banana-pro-preview')?.geminiImageSize).toBe('4K');
    });

    it('1K-tier and non-Gemini SKUs leave it undefined (keep chat/images path)', () => {
        // gemini-2.5-flash-image physically caps at 1408×768; gpt-image-2 +
        // Imagen are not native-Gemini image models.
        expect(findImageModel('gemini-2.5-flash-image')?.geminiImageSize).toBeUndefined();
        expect(findImageModel('gpt-image-2')?.geminiImageSize).toBeUndefined();
        expect(findImageModel('imagen-4.0-ultra-generate-001')?.geminiImageSize).toBeUndefined();
    });

    it('only ever uses the values the upstream accepts (2K | 4K), never 1K/3K/etc', () => {
        for (const m of IMAGE_MODELS) {
            if (m.geminiImageSize !== undefined) {
                expect(['2K', '4K']).toContain(m.geminiImageSize);
            }
        }
    });
});

describe('sizeToAspectRatio', () => {
    it('maps the 3 portal sizes to Gemini aspect ratios', () => {
        expect(sizeToAspectRatio('1024x1024')).toBe('1:1');
        expect(sizeToAspectRatio('1024x1792')).toBe('9:16');
        expect(sizeToAspectRatio('1792x1024')).toBe('16:9');
    });

    it('falls back to 1:1 for anything unexpected', () => {
        expect(sizeToAspectRatio('512x512')).toBe('1:1');
        expect(sizeToAspectRatio('')).toBe('1:1');
    });
});

describe('IMAGE_SIZES + count bounds', () => {
    it('exposes the 3 supported aspect ratios', () => {
        expect(IMAGE_SIZES).toEqual(['1024x1024', '1024x1792', '1792x1024']);
    });

    it('count window is 1..4 per brief', () => {
        expect(IMAGE_COUNT_MIN).toBe(1);
        expect(IMAGE_COUNT_MAX).toBe(4);
    });
});
