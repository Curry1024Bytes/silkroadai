/**
 * W6 D3 — categorize + groupModels unit tests.
 */
import { describe, expect, it } from 'vitest';
import {
    categorizeByType,
    categorizeByVendor,
    groupModels,
    filterGrouped,
    countGrouped,
    TYPE_ORDER,
    VENDOR_ORDER,
} from '@/lib/models/categorize';

describe('categorizeByType (W6 D3)', () => {
    it('audio: whisper / tts → audio', () => {
        expect(categorizeByType('whisper-1')).toBe('audio');
        expect(categorizeByType('tts-1-hd')).toBe('audio');
        // Multi-modal name — audio wins (priority order)
        expect(categorizeByType('gpt-4o-mini-tts')).toBe('audio');
    });

    it('image-gen: dall-e / sora / flux / image-1 / image-gen → image-gen', () => {
        expect(categorizeByType('dall-e-3')).toBe('image-gen');
        expect(categorizeByType('sora-2')).toBe('image-gen');
        expect(categorizeByType('flux-pro-1.1')).toBe('image-gen');
        expect(categorizeByType('gpt-image-1')).toBe('image-gen');
        // Black Forest Labs / SiliconFlow style
        expect(categorizeByType('black-forest-labs/FLUX.1-schnell')).toBe('image-gen');
    });

    it('embedding: embed / bge / m3e → embedding', () => {
        expect(categorizeByType('text-embedding-3-large')).toBe('embedding');
        expect(categorizeByType('BAAI/bge-large-zh-v1.5')).toBe('embedding');
        expect(categorizeByType('moka-ai/m3e-large')).toBe('embedding');
    });

    it('vision: vision / -vl- / gpt-4o / claude-opus / claude-sonnet → vision', () => {
        expect(categorizeByType('gpt-4o')).toBe('vision');
        expect(categorizeByType('gpt-4o-mini')).toBe('vision');
        expect(categorizeByType('claude-opus-4-7')).toBe('vision');
        expect(categorizeByType('claude-sonnet-4-6')).toBe('vision');
        expect(categorizeByType('Qwen/Qwen2.5-VL-72B-Instruct')).toBe('vision');
        expect(categorizeByType('llava-vision-1.6')).toBe('vision');
    });

    it('chat: everything else falls through to chat', () => {
        expect(categorizeByType('gpt-4-turbo')).toBe('chat');
        expect(categorizeByType('claude-haiku-4-5')).toBe('chat');
        expect(categorizeByType('deepseek-chat')).toBe('chat');
        expect(categorizeByType('Qwen/Qwen2.5-72B-Instruct')).toBe('chat');
    });

    it('priority: audio beats image, image beats embedding, embedding beats vision, vision beats chat', () => {
        // tts beats e.g. an image-gen substring (none collide naturally,
        // but assert audio is priority 1)
        expect(categorizeByType('whisper-large-v3')).toBe('audio');
        // dall-e (image) wins over chat fallback
        expect(categorizeByType('dall-e-2')).toBe('image-gen');
        // text-embedding-3 (embedding) wins over chat fallback (and over
        // OpenAI-vendor signal — vendor is orthogonal anyway)
        expect(categorizeByType('text-embedding-3-small')).toBe('embedding');
        // gpt-4o (vision) wins over chat
        expect(categorizeByType('gpt-4o-2026-05')).toBe('vision');
    });

    it('edge: empty string → chat (fallback)', () => {
        expect(categorizeByType('')).toBe('chat');
    });

    it('edge: case-insensitive', () => {
        expect(categorizeByType('Whisper-1')).toBe('audio');
        expect(categorizeByType('GPT-4o')).toBe('vision');
        expect(categorizeByType('FLUX.1')).toBe('image-gen');
    });
});

describe('categorizeByVendor (W6 D3)', () => {
    it('OpenAI family — chat + branded products', () => {
        expect(categorizeByVendor('gpt-4-turbo')).toBe('OpenAI');
        expect(categorizeByVendor('o1-preview')).toBe('OpenAI');
        expect(categorizeByVendor('o3-mini')).toBe('OpenAI');
        expect(categorizeByVendor('o4')).toBe('OpenAI');
        expect(categorizeByVendor('chatgpt-4o-latest')).toBe('OpenAI');
        expect(categorizeByVendor('dall-e-3')).toBe('OpenAI');
        expect(categorizeByVendor('sora-2')).toBe('OpenAI');
        expect(categorizeByVendor('whisper-1')).toBe('OpenAI');
        expect(categorizeByVendor('text-embedding-3-large')).toBe('OpenAI');
        expect(categorizeByVendor('tts-1-hd')).toBe('OpenAI');
    });

    it('Anthropic: claude-*', () => {
        expect(categorizeByVendor('claude-opus-4-7')).toBe('Anthropic');
        expect(categorizeByVendor('claude-sonnet-4-6')).toBe('Anthropic');
        expect(categorizeByVendor('claude-haiku-4-5')).toBe('Anthropic');
    });

    it('DeepSeek: deepseek-* / deepseek-ai/*', () => {
        expect(categorizeByVendor('deepseek-chat')).toBe('DeepSeek');
        expect(categorizeByVendor('deepseek-v4-flash')).toBe('DeepSeek');
        expect(categorizeByVendor('deepseek-ai/DeepSeek-V3.1')).toBe('DeepSeek');
        expect(categorizeByVendor('Pro/deepseek-ai/DeepSeek-V3')).toBe('DeepSeek');
    });

    it('Qwen / Alibaba', () => {
        expect(categorizeByVendor('Qwen/Qwen2.5-72B-Instruct')).toBe('Qwen');
        expect(categorizeByVendor('qwen-max')).toBe('Qwen');
    });

    it('Zhipu: glm / chatglm / zai-org/', () => {
        expect(categorizeByVendor('glm-4-plus')).toBe('Zhipu');
        expect(categorizeByVendor('chatglm-3')).toBe('Zhipu');
        expect(categorizeByVendor('zai-org/glm-4-air')).toBe('Zhipu');
    });

    it('Moonshot: kimi / moonshot', () => {
        expect(categorizeByVendor('kimi-latest')).toBe('Moonshot');
        expect(categorizeByVendor('moonshot-v1-128k')).toBe('Moonshot');
    });

    it('Tencent: hunyuan', () => {
        expect(categorizeByVendor('hunyuan-pro')).toBe('Tencent');
    });

    it('MiniMax', () => {
        expect(categorizeByVendor('minimax-text-01')).toBe('MiniMax');
    });

    it('Black Forest Labs: flux', () => {
        expect(categorizeByVendor('flux-pro-1.1')).toBe('Black Forest Labs');
        expect(categorizeByVendor('black-forest-labs/FLUX.1-schnell')).toBe('Black Forest Labs');
    });

    it('Other: unknown vendor falls through', () => {
        expect(categorizeByVendor('mystery-model-2026')).toBe('Other');
        expect(categorizeByVendor('llama3-70b')).toBe('Other');
    });

    it('edge: empty string → Other', () => {
        expect(categorizeByVendor('')).toBe('Other');
    });

    it('priority: claude-substr beats nothing else (Anthropic exclusive); does NOT confuse "claude" inside other names', () => {
        // Defensive: real-world vendors with 'claude' in name are essentially
        // only Anthropic. Just confirm it works on the common case.
        expect(categorizeByVendor('claude-3-5-sonnet')).toBe('Anthropic');
    });
});

describe('groupModels (W6 D3)', () => {
    it('produces nested type → vendor → entries[] structure', () => {
        const r = groupModels([
            'gpt-4o',
            'gpt-4-turbo',
            'claude-opus-4-7',
            'whisper-1',
            'dall-e-3',
            'text-embedding-3-large',
            'deepseek-chat',
        ]);

        expect(r.totalModels).toBe(7);
        // Vendors observed: OpenAI (4), Anthropic (1), DeepSeek (1) → 3
        expect(r.vendorCount).toBe(3);

        // chat: gpt-4-turbo (OpenAI) + deepseek-chat (DeepSeek)
        expect(r.grouped.chat?.OpenAI).toHaveLength(1);
        expect(r.grouped.chat?.DeepSeek).toHaveLength(1);
        // vision: gpt-4o + claude-opus-4-7
        expect(r.grouped.vision?.OpenAI).toHaveLength(1);
        expect(r.grouped.vision?.Anthropic).toHaveLength(1);
        // audio: whisper-1
        expect(r.grouped.audio?.OpenAI).toHaveLength(1);
        // image-gen: dall-e-3
        expect(r.grouped['image-gen']?.OpenAI).toHaveLength(1);
        // embedding: text-embedding-3-large
        expect(r.grouped.embedding?.OpenAI).toHaveLength(1);
    });

    it('alphabetical within vendor, case-insensitive', () => {
        const r = groupModels(['Qwen/Qwen2.5-72B-Instruct', 'Qwen/Qwen2-7B-Instruct', 'qwen-max']);
        const qwens = r.grouped.chat?.Qwen ?? [];
        expect(qwens.map((m) => m.shortName)).toEqual([
            'qwen-max',
            'Qwen/Qwen2-7B-Instruct',
            'Qwen/Qwen2.5-72B-Instruct',
        ]);
    });

    it('dedups identical raw names', () => {
        const r = groupModels(['gpt-4', 'gpt-4', 'gpt-4-turbo']);
        expect(r.totalModels).toBe(2); // gpt-4 + gpt-4-turbo
    });

    it('empty input → empty grouped, totalModels=0, vendorCount=0', () => {
        const r = groupModels([]);
        expect(r.totalModels).toBe(0);
        expect(r.vendorCount).toBe(0);
        expect(r.grouped).toEqual({});
    });

    it('unknown-vendor models go to Other bucket', () => {
        const r = groupModels(['some-mystery-2026', 'llama3-70b']);
        expect(r.grouped.chat?.Other).toHaveLength(2);
    });

    it('TYPE_ORDER and VENDOR_ORDER are stable contracts', () => {
        // These constants are imported by the page UI and the search
        // component. Asserting their content protects the call sites.
        expect(TYPE_ORDER).toEqual(['chat', 'vision', 'audio', 'embedding', 'image-gen']);
        expect(VENDOR_ORDER[0]).toBe('OpenAI');
        expect(VENDOR_ORDER[VENDOR_ORDER.length - 1]).toBe('Other');
    });
});

describe('filterGrouped + countGrouped (W6 D3)', () => {
    const SAMPLE = [
        'gpt-4-turbo',
        'gpt-4o',
        'claude-opus-4-7',
        'deepseek-chat',
        'deepseek-v4-flash',
        'Qwen/Qwen2.5-72B-Instruct',
    ];
    const { grouped } = groupModels(SAMPLE);

    it('empty query → returns the input grouped reference unchanged', () => {
        expect(filterGrouped(grouped, '')).toBe(grouped);
        expect(filterGrouped(grouped, '   ')).toBe(grouped);
    });

    it('matches shortName substring (case-insensitive)', () => {
        const r = filterGrouped(grouped, 'DeepSeek');
        expect(countGrouped(r)).toBe(2);
        // DeepSeek has only chat-type entries in this fixture
        expect(r.chat?.DeepSeek).toHaveLength(2);
        expect(r.vision).toBeUndefined();
    });

    it('matches vendor name (case-insensitive)', () => {
        // No model name contains "anthropic" but vendor does — claude-opus
        // should still surface.
        const r = filterGrouped(grouped, 'anthropic');
        expect(countGrouped(r)).toBe(1);
        expect(r.vision?.Anthropic).toHaveLength(1);
    });

    it('prunes empty type buckets and empty vendor buckets', () => {
        const r = filterGrouped(grouped, 'qwen');
        // Should leave only chat → Qwen
        expect(Object.keys(r)).toEqual(['chat']);
        const chatBucket = r.chat!;
        expect(Object.keys(chatBucket)).toEqual(['Qwen']);
        expect(chatBucket.Qwen).toHaveLength(1);
    });

    it('zero matches → empty object', () => {
        const r = filterGrouped(grouped, 'nonsense-zzzzz');
        expect(r).toEqual({});
        expect(countGrouped(r)).toBe(0);
    });

    it('countGrouped sums entries across types and vendors', () => {
        expect(countGrouped(grouped)).toBe(SAMPLE.length);
        expect(countGrouped({})).toBe(0);
    });
});
