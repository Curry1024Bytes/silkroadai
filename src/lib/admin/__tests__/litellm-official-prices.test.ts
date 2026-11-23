import { describe, expect, test } from 'vitest';
import { searchOfficialModelPrices } from '../litellm-official-prices';
import type { OfficialModelPrice } from '../litellm-official-prices';

const mockModels: OfficialModelPrice[] = [
    {
        model: 'doubao/Doubao Seedance 2 0 260128',
        provider: 'doubao',
        inputUsdPer1m: 10.0,
        outputUsdPer1m: 20.0,
        cacheReadUsdPer1m: null,
        cacheWrite5mUsdPer1m: null,
        cacheWrite1hUsdPer1m: null,
    },
    {
        model: 'doubao/Doubao Seedance 2 0 Fast 260128',
        provider: 'doubao',
        inputUsdPer1m: 15.0,
        outputUsdPer1m: 30.0,
        cacheReadUsdPer1m: null,
        cacheWrite5mUsdPer1m: null,
        cacheWrite1hUsdPer1m: null,
    },
    {
        model: 'doubao/Doubao Seedance 2 0 Mini 260615',
        provider: 'doubao',
        inputUsdPer1m: 5.0,
        outputUsdPer1m: 10.0,
        cacheReadUsdPer1m: null,
        cacheWrite5mUsdPer1m: null,
        cacheWrite1hUsdPer1m: null,
    },
    {
        model: 'openai/gpt-4',
        provider: 'openai',
        inputUsdPer1m: 30.0,
        outputUsdPer1m: 60.0,
        cacheReadUsdPer1m: null,
        cacheWrite5mUsdPer1m: null,
        cacheWrite1hUsdPer1m: null,
    },
];

describe('searchOfficialModelPrices', () => {
    test('exact match returns only the exact match', () => {
        const results = searchOfficialModelPrices(mockModels, 'doubao/Doubao Seedance 2 0 260128');

        expect(results).toHaveLength(1);
        expect(results[0].model).toBe('doubao/Doubao Seedance 2 0 260128');
        expect(results[0].inputUsdPer1m).toBe(10.0);
    });

    test('exact match excludes partial matches like Fast and Mini', () => {
        const results = searchOfficialModelPrices(mockModels, 'doubao/Doubao Seedance 2 0 260128');

        const models = results.map((r) => r.model);
        expect(models).not.toContain('doubao/Doubao Seedance 2 0 Fast 260128');
        expect(models).not.toContain('doubao/Doubao Seedance 2 0 Mini 260615');
    });

    test('case-insensitive exact match', () => {
        const results = searchOfficialModelPrices(mockModels, 'DOUBAO/DOUBAO SEEDANCE 2 0 260128');

        expect(results).toHaveLength(1);
        expect(results[0].model).toBe('doubao/Doubao Seedance 2 0 260128');
    });

    test('no exact match returns partial matches', () => {
        const results = searchOfficialModelPrices(mockModels, 'Seedance');

        expect(results.length).toBeGreaterThan(1);
        expect(results.map((r) => r.model)).toContain('doubao/Doubao Seedance 2 0 260128');
        expect(results.map((r) => r.model)).toContain('doubao/Doubao Seedance 2 0 Fast 260128');
    });

    test('empty query returns empty results', () => {
        const results = searchOfficialModelPrices(mockModels, '');
        expect(results).toHaveLength(0);
    });

    test('no matches returns empty results', () => {
        const results = searchOfficialModelPrices(mockModels, 'nonexistent-model-xyz');
        expect(results).toHaveLength(0);
    });

    test('provider match works when no model name match', () => {
        const results = searchOfficialModelPrices(mockModels, 'openai');

        expect(results.length).toBeGreaterThan(0);
        expect(results[0].model).toBe('openai/gpt-4');
    });
});
