/**
 * categorize + grouping unit tests.
 *
 * Fixtures use the REAL enabled-model names from new-api so the classifier
 * is pinned against production reality (Gemini / Seedance / gpt-image were
 * previously dumped into "Other" + misclassified as chat — this guards the
 * fix).
 */
import { describe, expect, it } from 'vitest';
import {
    categorizeByType,
    categorizeByVendor,
    classifyModels,
    groupByVendor,
    filterEntries,
    groupModels,
    filterGrouped,
    countGrouped,
    HIDDEN_MODELS,
    TYPE_ORDER,
    VENDOR_ORDER,
} from '@/lib/models/categorize';

/** The raw /api/channel/models_enabled list (includes the two denylisted
 *  names so the hide path is exercised). */
const REAL = [
    'claude-haiku-4-5',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'dreamina-seedance-2-0-1080p',
    'dreamina-seedance-2-0-1080p-ref',
    'dreamina-seedance-2-0-480p',
    'dreamina-seedance-2-0-720p',
    'dreamina-seedance-2-0-fast-720p',
    'gemini-2.5-flash-image',
    'gemini-3-pro-image-preview',
    'gemini-3-pro-image-preview-2k',
    'gemini-3.1-flash-image-preview',
    'gemini-3.5-flash',
    'gemini_3.0_pro_image_preview_4K',
    'gemini_3.1_flash_image_preview', // denylisted (duplicate spelling)
    'gpt-5.3-codex',
    'gpt-5.3-codex-spark', // denylisted (retired)
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.5',
    'gpt-image-2',
    'gpt-image-2-1k',
    'gpt-image-2-2k',
    'gpt-image-2-4k',
    'seedance-2.0-1080',
    'seedance-2.0-720',
];

/** What customer-facing surfaces actually show (denylist applied). */
const VISIBLE = REAL.filter((n) => !HIDDEN_MODELS.has(n));

describe('categorizeByType', () => {
    it('audio: whisper / tts → audio (priority 1)', () => {
        expect(categorizeByType('whisper-1')).toBe('audio');
        expect(categorizeByType('tts-1-hd')).toBe('audio');
        expect(categorizeByType('gpt-4o-mini-tts')).toBe('audio');
    });

    it('video: seedance / dreamina / sora / *-video → video', () => {
        expect(categorizeByType('seedance-2.0-720')).toBe('video');
        expect(categorizeByType('seedance-2.0-1080')).toBe('video');
        expect(categorizeByType('dreamina-seedance-2-0-1080p')).toBe('video');
        expect(categorizeByType('dreamina-seedance-2-0-fast-720p')).toBe('video');
        expect(categorizeByType('sora-2')).toBe('video');
        expect(categorizeByType('veo-3.1')).toBe('video');
    });

    it('image-gen: dall-e / flux / gpt-image / *-image / *_image_* → image-gen', () => {
        expect(categorizeByType('dall-e-3')).toBe('image-gen');
        expect(categorizeByType('flux-pro-1.1')).toBe('image-gen');
        expect(categorizeByType('black-forest-labs/FLUX.1-schnell')).toBe('image-gen');
        // gpt-image — the hyphenated-suffix variants previously leaked to chat
        expect(categorizeByType('gpt-image-2')).toBe('image-gen');
        expect(categorizeByType('gpt-image-2-1k')).toBe('image-gen');
        expect(categorizeByType('gpt-image-2-4k')).toBe('image-gen');
        // Gemini image — trailing -image AND the underscore 4K variant
        expect(categorizeByType('gemini-2.5-flash-image')).toBe('image-gen');
        expect(categorizeByType('gemini-3-pro-image-preview')).toBe('image-gen');
        expect(categorizeByType('gemini-3-pro-image-preview-2k')).toBe('image-gen');
        expect(categorizeByType('gemini_3.0_pro_image_preview_4K')).toBe('image-gen');
        expect(categorizeByType('gemini_3.1_flash_image_preview')).toBe('image-gen');
    });

    it('image-gen: "image" must be a standalone token — embedded substring stays chat', () => {
        // "imagereward" embeds "image" inside an alpha run → IMAGE_WORD must
        // NOT fire (and it has no "imagen" substring either).
        expect(categorizeByType('imagereward-v1')).toBe('chat');
    });

    it('embedding: embed / bge / m3e → embedding', () => {
        expect(categorizeByType('text-embedding-3-large')).toBe('embedding');
        expect(categorizeByType('BAAI/bge-large-zh-v1.5')).toBe('embedding');
        expect(categorizeByType('moka-ai/m3e-large')).toBe('embedding');
    });

    it('vision: vision / -vl- / gemini / gpt-4o / claude-opus|sonnet → vision', () => {
        expect(categorizeByType('gpt-4o')).toBe('vision');
        expect(categorizeByType('gemini-3.5-flash')).toBe('vision');
        expect(categorizeByType('claude-opus-4-8')).toBe('vision');
        expect(categorizeByType('claude-sonnet-4-6')).toBe('vision');
        expect(categorizeByType('Qwen/Qwen2.5-VL-72B-Instruct')).toBe('vision');
    });

    it('chat: everything else falls through to chat', () => {
        expect(categorizeByType('gpt-5.5')).toBe('chat');
        expect(categorizeByType('gpt-5.3-codex')).toBe('chat');
        expect(categorizeByType('claude-haiku-4-5')).toBe('chat');
        expect(categorizeByType('deepseek-chat')).toBe('chat');
    });

    it('edge: empty string → chat; case-insensitive', () => {
        expect(categorizeByType('')).toBe('chat');
        expect(categorizeByType('Whisper-1')).toBe('audio');
        expect(categorizeByType('GPT-IMAGE-2')).toBe('image-gen');
        expect(categorizeByType('SEEDANCE-2.0')).toBe('video');
    });
});

describe('categorizeByVendor', () => {
    it('OpenAI: gpt-* / chatgpt / o1-3-4 / gpt-image', () => {
        expect(categorizeByVendor('gpt-5.5')).toBe('OpenAI');
        expect(categorizeByVendor('gpt-5.3-codex')).toBe('OpenAI');
        expect(categorizeByVendor('gpt-image-2-4k')).toBe('OpenAI');
        expect(categorizeByVendor('o3-mini')).toBe('OpenAI');
        expect(categorizeByVendor('chatgpt-4o-latest')).toBe('OpenAI');
    });

    it('Anthropic: claude-*', () => {
        expect(categorizeByVendor('claude-opus-4-8')).toBe('Anthropic');
        expect(categorizeByVendor('claude-haiku-4-5')).toBe('Anthropic');
        expect(categorizeByVendor('claude-fable-5')).toBe('Anthropic');
    });

    it('Google: gemini (all separator styles) / imagen / veo / gemma', () => {
        expect(categorizeByVendor('gemini-3.5-flash')).toBe('Google');
        expect(categorizeByVendor('gemini-2.5-flash-image')).toBe('Google');
        expect(categorizeByVendor('gemini_3.0_pro_image_preview_4K')).toBe('Google');
        expect(categorizeByVendor('imagen-3')).toBe('Google');
        expect(categorizeByVendor('veo-3.1')).toBe('Google');
        expect(categorizeByVendor('gemma-2-27b')).toBe('Google');
    });

    it('ByteDance: seedance / dreamina / doubao', () => {
        expect(categorizeByVendor('seedance-2.0-720')).toBe('ByteDance');
        expect(categorizeByVendor('dreamina-seedance-2-0-1080p')).toBe('ByteDance');
        expect(categorizeByVendor('doubao-pro-32k')).toBe('ByteDance');
    });

    it('long-tail open-source vendors still classify', () => {
        expect(categorizeByVendor('deepseek-v4-flash')).toBe('DeepSeek');
        expect(categorizeByVendor('Qwen/Qwen2.5-72B-Instruct')).toBe('Qwen');
        expect(categorizeByVendor('glm-4-plus')).toBe('Zhipu');
        expect(categorizeByVendor('kimi-latest')).toBe('Moonshot');
        expect(categorizeByVendor('hunyuan-pro')).toBe('Tencent');
        expect(categorizeByVendor('minimax-text-01')).toBe('MiniMax');
        expect(categorizeByVendor('flux-pro-1.1')).toBe('Black Forest Labs');
    });

    it('Other: unknown vendor / empty falls through', () => {
        expect(categorizeByVendor('llama3-70b')).toBe('Other');
        expect(categorizeByVendor('')).toBe('Other');
    });

    it('REAL catalog only ever resolves to the 4 vendors we serve (zero Other)', () => {
        const vendors = new Set(REAL.map(categorizeByVendor));
        expect(vendors.has('Other')).toBe(false);
        expect([...vendors].sort()).toEqual(['Anthropic', 'ByteDance', 'Google', 'OpenAI']);
    });
});

describe('classifyModels (vendor-first primary)', () => {
    it('dedups, counts vendors, sorts vendor → type → name', () => {
        const r = classifyModels(REAL);
        expect(r.totalModels).toBe(VISIBLE.length);
        expect(r.vendorCount).toBe(4);

        // First section is OpenAI, last served vendor block is ByteDance.
        expect(r.entries[0].vendor).toBe('OpenAI');
        expect(r.entries[r.entries.length - 1].vendor).toBe('ByteDance');

        // Within OpenAI, chat entries precede image-gen entries (TYPE_ORDER).
        const openai = r.entries.filter((e) => e.vendor === 'OpenAI');
        const firstImageIdx = openai.findIndex((e) => e.type === 'image-gen');
        const lastChatIdx = openai.map((e) => e.type).lastIndexOf('chat');
        expect(lastChatIdx).toBeLessThan(firstImageIdx);
    });

    it('dedups identical raw names', () => {
        const r = classifyModels(['gpt-5.5', 'gpt-5.5', 'claude-opus-4-8']);
        expect(r.totalModels).toBe(2);
    });

    it('empty input → empty', () => {
        const r = classifyModels([]);
        expect(r).toEqual({ entries: [], totalModels: 0, vendorCount: 0 });
    });
});

describe('groupByVendor', () => {
    it('one section per vendor, in VENDOR_ORDER, with type sub-buckets', () => {
        const { entries } = classifyModels(REAL);
        const sections = groupByVendor(entries);

        expect(sections.map((s) => s.vendor)).toEqual(['OpenAI', 'Anthropic', 'Google', 'ByteDance']);

        // Section totals reconcile with the VISIBLE fixture (denylist applied).
        const expected = (v: string) => VISIBLE.filter((n) => categorizeByVendor(n) === v).length;
        const byVendor = Object.fromEntries(sections.map((s) => [s.vendor, s]));
        expect(byVendor.OpenAI.total).toBe(expected('OpenAI'));
        expect(byVendor.Anthropic.total).toBe(expected('Anthropic'));
        expect(byVendor.Google.total).toBe(expected('Google'));
        expect(byVendor.ByteDance.total).toBe(expected('ByteDance'));

        // OpenAI splits into chat + image-gen sub-buckets, in TYPE_ORDER.
        expect(byVendor.OpenAI.types.map((t) => t.type)).toEqual(['chat', 'image-gen']);
        // ByteDance is video-only.
        expect(byVendor.ByteDance.types.map((t) => t.type)).toEqual(['video']);
    });

    it('totals reconcile with the flat entry count', () => {
        const { entries } = classifyModels(REAL);
        const sections = groupByVendor(entries);
        const sum = sections.reduce((acc, s) => acc + s.total, 0);
        expect(sum).toBe(entries.length);
    });
});

describe('filterEntries', () => {
    const { entries } = classifyModels(REAL);

    it('empty query → same reference', () => {
        expect(filterEntries(entries, '')).toBe(entries);
        expect(filterEntries(entries, '   ')).toBe(entries);
    });

    const countVendor = (v: string) => VISIBLE.filter((n) => categorizeByVendor(n) === v).length;

    it('matches model name (case-insensitive)', () => {
        const r = filterEntries(entries, 'GEMINI');
        expect(r.length).toBe(countVendor('Google'));
        expect(r.every((m) => m.vendor === 'Google')).toBe(true);
    });

    it('matches English vendor name', () => {
        expect(filterEntries(entries, 'anthropic').length).toBe(countVendor('Anthropic'));
    });

    it('matches Chinese vendor descriptor (字节)', () => {
        const r = filterEntries(entries, '字节');
        expect(r.length).toBe(countVendor('ByteDance'));
        expect(r.every((m) => m.vendor === 'ByteDance')).toBe(true);
    });

    it('matches Chinese type label (视频)', () => {
        const r = filterEntries(entries, '视频');
        expect(r.every((m) => m.type === 'video')).toBe(true);
        expect(r.length).toBeGreaterThan(0);
    });

    it('zero matches → empty array', () => {
        expect(filterEntries(entries, 'nonsense-zzzzz')).toEqual([]);
    });
});

describe('HIDDEN_MODELS denylist', () => {
    it('contains the two operator-curated names', () => {
        expect(HIDDEN_MODELS.has('gemini_3.1_flash_image_preview')).toBe(true);
        expect(HIDDEN_MODELS.has('gpt-5.3-codex-spark')).toBe(true);
    });

    it('classifyModels (page) excludes every denylisted name', () => {
        const ids = new Set(classifyModels(REAL).entries.map((e) => e.shortName));
        for (const hidden of HIDDEN_MODELS) expect(ids.has(hidden)).toBe(false);
        // The canonical (hyphen) gemini twin and the kept codex stay visible.
        expect(ids.has('gemini-3.1-flash-image-preview')).toBe(true);
        expect(ids.has('gpt-5.3-codex')).toBe(true);
    });

    it('groupModels (chat picker) also excludes denylisted names', () => {
        const { grouped } = groupModels(REAL);
        const all = Object.values(grouped).flatMap((tb) => Object.values(tb ?? {}).flat());
        const ids = new Set(all.map((m) => m!.shortName));
        for (const hidden of HIDDEN_MODELS) expect(ids.has(hidden)).toBe(false);
    });

    it('hiding is presentation-only — the pure classifiers still resolve a hidden name', () => {
        expect(categorizeByType('gemini_3.1_flash_image_preview')).toBe('image-gen');
        expect(categorizeByVendor('gemini_3.1_flash_image_preview')).toBe('Google');
        expect(categorizeByVendor('gpt-5.3-codex-spark')).toBe('OpenAI');
    });
});

describe('stable contracts', () => {
    it('TYPE_ORDER and VENDOR_ORDER pin the display order', () => {
        expect(TYPE_ORDER).toEqual(['chat', 'vision', 'image-gen', 'video', 'audio', 'embedding']);
        expect(VENDOR_ORDER[0]).toBe('OpenAI');
        expect(VENDOR_ORDER[1]).toBe('Anthropic');
        expect(VENDOR_ORDER[2]).toBe('Google');
        expect(VENDOR_ORDER[3]).toBe('ByteDance');
        expect(VENDOR_ORDER[VENDOR_ORDER.length - 1]).toBe('Other');
    });
});

// ── Legacy type→vendor view (still used by the Chat UI picker) ──────────────
describe('groupModels (legacy, Chat UI picker)', () => {
    it('produces nested type → vendor → entries[] structure', () => {
        const r = groupModels(['gpt-4o', 'gpt-5.5', 'claude-opus-4-8', 'dall-e-3', 'deepseek-chat']);
        expect(r.vendorCount).toBe(3);
        expect(r.grouped.chat?.OpenAI).toHaveLength(1); // gpt-5.5
        expect(r.grouped.chat?.DeepSeek).toHaveLength(1); // deepseek-chat
        expect(r.grouped.vision?.OpenAI).toHaveLength(1); // gpt-4o
        expect(r.grouped.vision?.Anthropic).toHaveLength(1); // claude-opus
        expect(r.grouped['image-gen']?.OpenAI).toHaveLength(1); // dall-e-3
    });

    it('filterGrouped + countGrouped still work', () => {
        const { grouped } = groupModels(['gpt-5.5', 'claude-opus-4-8', 'deepseek-chat']);
        expect(countGrouped(grouped)).toBe(3);
        expect(countGrouped(filterGrouped(grouped, 'deepseek'))).toBe(1);
        expect(filterGrouped(grouped, '')).toBe(grouped);
    });
});
