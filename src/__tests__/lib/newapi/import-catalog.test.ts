import { describe, expect, it } from 'vitest';
import {
    buildImportCandidates,
    inferVendor,
    isImageModel,
    toDisplayName,
    type ChannelForImport,
} from '@/lib/newapi/import-catalog';

describe('inferVendor', () => {
    it.each([
        ['claude-opus-4-7', 'anthropic'],
        ['gpt-5.4', 'openai'],
        ['gpt-image-2', 'openai'],
        ['dall-e-3', 'openai'],
        ['o3-pro', 'openai'],
        ['codex', 'openai'],
        ['text-embedding-3-large', 'openai'],
        ['gemini-3-pro', 'google'],
        ['imagen-4', 'google'],
        ['deepseek-v4', 'deepseek'],
        ['qwen3-max', 'qwen'],
        ['glm-5', 'zhipu'],
        ['kimi-k2', 'moonshot'],
        ['mystery-model', 'unknown'],
    ])('%s → %s', (slug, vendor) => {
        expect(inferVendor(slug)).toBe(vendor);
    });
});

describe('isImageModel', () => {
    it.each([
        ['gpt-image-2', true],
        ['gemini-3-pro-image', true],
        ['dall-e-3', true],
        ['imagen-4', true],
        ['claude-opus-4-7', false],
        ['gpt-5.4', false],
    ])('%s → %s', (slug, expected) => {
        expect(isImageModel(slug)).toBe(expected);
    });
});

describe('toDisplayName', () => {
    it('title-cases alpha words, keeps numeric/version tokens', () => {
        expect(toDisplayName('claude-opus-4-7')).toBe('Claude Opus 4 7');
        expect(toDisplayName('gpt-5.4')).toBe('Gpt 5.4');
    });

    it('uses the last path segment for vendor/model paths', () => {
        expect(toDisplayName('deepseek-ai/DeepSeek-V4-Flash')).toBe('DeepSeek V4 Flash');
    });
});

describe('buildImportCandidates', () => {
    const claudeChannel: ChannelForImport = {
        id: 2,
        name: 'sub2api',
        tier: 'pool',
        models: 'claude-opus-4-7, claude-sonnet-4-6', // whitespace after comma → must be trimmed
        model_ratio: JSON.stringify({ 'claude-opus-4-7': 3.214286, 'claude-sonnet-4-6': 0.642857 }),
        completion_ratio: JSON.stringify({ 'claude-opus-4-7': 5, 'claude-sonnet-4-6': 5 }),
    };
    const openaiChannel: ChannelForImport = {
        id: 3,
        name: 'sub2api-openai',
        tier: 'pool',
        // gpt-5.4 priced; gpt-mini has model_ratio but NO completion_ratio; gpt-image-2 is image;
        // mystery is in models but absent from model_ratio (and not image).
        models: 'gpt-5.4,gpt-mini,gpt-image-2,mystery',
        model_ratio: JSON.stringify({ 'gpt-5.4': 0.357143, 'gpt-mini': 1 }),
        completion_ratio: JSON.stringify({ 'gpt-5.4': 4 }),
    };
    const imageChannel: ChannelForImport = {
        id: 17,
        name: 'nexaxis',
        tier: 'pool',
        models: 'gemini-3-pro-image',
        model_ratio: {}, // already-parsed empty dict (not a JSON string)
        completion_ratio: {},
    };

    it('reverse-derives chat prices, detects image + unpriced models', () => {
        const candidates = buildImportCandidates([claudeChannel, openaiChannel, imageChannel]);
        const bySlug = Object.fromEntries(candidates.map((c) => [c.slug, c]));

        // priced chat (inverse of computeRatios — opus mr 3.214286 × CHAT_FX 14.4 → ¥46.2857/¥231.4285)
        expect(bySlug['claude-opus-4-7']).toMatchObject({
            vendor: 'anthropic',
            modality: 'chat',
            tier: 'pool',
            price_status: 'priced',
            input_cny_per_1m: 46.2857,
            output_cny_per_1m: 231.4285,
            ratio_defaulted: false,
            channel_id: 2,
            channel_name: 'sub2api',
            upstream_model: 'claude-opus-4-7',
        });
        expect(bySlug['gpt-5.4']).toMatchObject({
            vendor: 'openai',
            price_status: 'priced',
            input_cny_per_1m: 5.1429, // mr 0.357143 × 14.4
            output_cny_per_1m: 20.5716,
            channel_id: 3,
        });

        // model_ratio present but completion_ratio missing → cr defaults to 1 (in = out)
        expect(bySlug['gpt-mini']).toMatchObject({
            price_status: 'priced',
            input_cny_per_1m: 14.4, // mr 1 × CHAT_FX 14.4
            output_cny_per_1m: 14.4,
            ratio_defaulted: true,
        });

        // name contains 'image' → image, no price (even though on an OpenAI channel)
        expect(bySlug['gpt-image-2']).toMatchObject({
            vendor: 'openai',
            modality: 'image',
            price_status: 'image',
            input_cny_per_1m: null,
            output_cny_per_1m: null,
        });

        // in models but no model_ratio entry, not image → unpriced (build model, flag for manual price)
        expect(bySlug['mystery']).toMatchObject({
            modality: 'chat',
            price_status: 'unpriced',
            input_cny_per_1m: null,
            output_cny_per_1m: null,
        });

        // image channel with already-parsed empty dicts
        expect(bySlug['gemini-3-pro-image']).toMatchObject({
            vendor: 'google',
            modality: 'image',
            price_status: 'image',
        });
    });

    it('dedupes by (slug, tier): same tier → first wins; pool + official → two candidates', () => {
        const poolA: ChannelForImport = {
            id: 2,
            name: 'A',
            tier: 'pool',
            models: 'dup-model',
            model_ratio: { 'dup-model': 1 },
            completion_ratio: { 'dup-model': 2 },
        };
        const poolB: ChannelForImport = {
            id: 3,
            name: 'B',
            tier: 'pool',
            models: 'dup-model',
            model_ratio: { 'dup-model': 9 },
            completion_ratio: { 'dup-model': 9 },
        };
        const official: ChannelForImport = {
            id: 4,
            name: 'C',
            tier: 'official',
            models: 'dup-model',
            model_ratio: { 'dup-model': 2 },
            completion_ratio: { 'dup-model': 3 },
        };

        // Two pool channels with the same slug → 1 candidate, first pool wins.
        const samePool = buildImportCandidates([poolA, poolB]);
        expect(samePool).toHaveLength(1);
        expect(samePool[0]).toMatchObject({ tier: 'pool', channel_id: 2, input_cny_per_1m: 14.4 });

        // Same slug on a pool channel + an official channel → 2 candidates (one per tier).
        const both = buildImportCandidates([poolA, official]);
        expect(both).toHaveLength(2);
        const byTier = Object.fromEntries(both.map((c) => [c.tier, c]));
        expect(byTier.pool).toMatchObject({ channel_id: 2, input_cny_per_1m: 14.4 }); // mr 1 × FX 14.4
        expect(byTier.official).toMatchObject({ channel_id: 4, input_cny_per_1m: 28.8 }); // mr 2 × FX 14.4
    });

    it('handles empty / missing models', () => {
        expect(buildImportCandidates([{ id: 5, tier: 'pool', models: '' }])).toEqual([]);
        expect(buildImportCandidates([{ id: 5, tier: 'pool' }])).toEqual([]);
        expect(buildImportCandidates([])).toEqual([]);
    });
});
