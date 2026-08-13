import { describe, expect, it, vi } from 'vitest';
import {
    LITELLM_PRICE_SOURCES,
    fetchLiteLlmPriceCatalog,
    parseLiteLlmPriceCatalog,
    searchOfficialModelPrices,
} from '@/lib/admin/litellm-official-prices';

const SAMPLE = {
    'anthropic.claude-fable-5': {
        litellm_provider: 'bedrock_converse',
        input_cost_per_token: 0.00001,
        output_cost_per_token: 0.00005,
        cache_read_input_token_cost: 0.000001,
        cache_creation_input_token_cost: 0.0000125,
        cache_creation_input_token_cost_above_1hr: 0.00002,
    },
    'text-embedding-3-small': { input_cost_per_token: 0.00000002 },
};

describe('LiteLLM official price source', () => {
    it('normalizes per-token prices to USD per million tokens', () => {
        expect(parseLiteLlmPriceCatalog(SAMPLE)).toEqual([
            {
                model: 'anthropic.claude-fable-5',
                provider: 'bedrock_converse',
                inputUsdPer1m: 10,
                outputUsdPer1m: 50,
                cacheReadUsdPer1m: 1,
                cacheWrite5mUsdPer1m: 12.5,
                cacheWrite1hUsdPer1m: 20,
            },
        ]);
    });

    it('uses the GitHub source when the CDN is unavailable', async () => {
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(new Response('gateway unavailable', { status: 502 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(SAMPLE), { status: 200 }));

        const result = await fetchLiteLlmPriceCatalog(fetcher as typeof fetch);

        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls[0][0]).toBe(LITELLM_PRICE_SOURCES[0].url);
        expect(fetcher.mock.calls[1][0]).toBe(LITELLM_PRICE_SOURCES[1].url);
        expect(result.source).toBe('litellm-github');
        expect(result.models[0].inputUsdPer1m).toBe(10);
    });

    it('ranks exact model-name matches ahead of provider variants', () => {
        const models = parseLiteLlmPriceCatalog({
            ...SAMPLE,
            'bedrock/anthropic.claude-fable-5': SAMPLE['anthropic.claude-fable-5'],
            'claude-fable-5': SAMPLE['anthropic.claude-fable-5'],
        });

        expect(searchOfficialModelPrices(models, 'claude-fable-5').map((model) => model.model)).toEqual([
            'claude-fable-5',
            'anthropic.claude-fable-5',
            'bedrock/anthropic.claude-fable-5',
        ]);
    });
});
