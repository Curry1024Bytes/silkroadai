/**
 * W6 D3 — Model categorization for the public /models page.
 *
 * Two orthogonal classifiers:
 *   - `categorizeByType` — what the model DOES (chat / vision / audio /
 *     embedding / image-gen). Checked in priority order so multi-modal
 *     names land in the most specific bucket (e.g. `gpt-4o-mini-tts`
 *     → audio, not vision).
 *   - `categorizeByVendor` — who built it. Prefix / substring match on
 *     well-known vendor signals.
 *
 * Source data: the raw string list returned by new-api
 * `GET /api/channel/models_enabled`. Includes both W3 D2.5 short names
 * (`deepseek-v4-flash`) and HuggingFace-style canonical names
 * (`Pro/deepseek-ai/DeepSeek-V3.1`). Both are visible in the UI.
 *
 * `groupModels` produces the double-level structure consumed by the page:
 *   typeName → vendorName → ModelEntry[]
 *
 * NOT here: pricing, model capabilities (context window, etc.). Those
 * are deferred to a future batch when new-api exposes the data.
 */

export type TypeName = 'chat' | 'vision' | 'audio' | 'embedding' | 'image-gen';

/** Display order — chat first (most common), image-gen last (most novelty). */
export const TYPE_ORDER: readonly TypeName[] = ['chat', 'vision', 'audio', 'embedding', 'image-gen'] as const;

export const TYPE_LABEL: Record<TypeName, string> = {
    chat: '对话模型',
    vision: '视觉理解',
    audio: '音频(语音 / 语音合成)',
    embedding: '向量嵌入',
    'image-gen': '图像生成',
};

export type VendorName =
    | 'OpenAI'
    | 'Anthropic'
    | 'DeepSeek'
    | 'Qwen'
    | 'Zhipu'
    | 'Moonshot'
    | 'Tencent'
    | 'MiniMax'
    | 'Black Forest Labs'
    | 'Other';

/** Display order — major Western vendors first, then Chinese vendors,
 *  then niche / Other last. */
export const VENDOR_ORDER: readonly VendorName[] = [
    'OpenAI',
    'Anthropic',
    'DeepSeek',
    'Qwen',
    'Zhipu',
    'Moonshot',
    'Tencent',
    'MiniMax',
    'Black Forest Labs',
    'Other',
] as const;

export interface ModelEntry {
    /** Customer-facing primary name. Today this is just the raw new-api
     *  string; if a future API exposes a curated short name we'll plumb it
     *  in here. */
    shortName: string;
    /** Full canonical name as new-api stores it. Today identical to
     *  shortName because the channel's `model_mapping` is one-way (rewrite
     *  short → canonical for upstream forwarding) and `models_enabled`
     *  returns whatever's in `channel.models`. We expose this slot anyway
     *  so the UI can show a separate canonical line later without a
     *  schema change. */
    canonicalName: string;
    type: TypeName;
    vendor: VendorName;
}

/** Type-classification rules. Order matters — first match wins. Specific
 *  modalities (audio / image / embedding / vision) are checked before
 *  the chat fallback. */
export function categorizeByType(modelName: string): TypeName {
    const n = modelName.toLowerCase();

    // Audio first — `gpt-4o-mini-tts` should NOT land in vision.
    if (n.includes('whisper') || n.includes('tts')) return 'audio';

    // Image-gen — explicit signals before any vision/chat fallback.
    if (
        n.includes('dall-e') ||
        n.includes('sora') ||
        n.includes('flux') ||
        // Avoid matching "imagenet" / "image-input" — narrow to clear
        // image-generation signals at the model name level.
        /(^|[\/-])image(-gen|gen|-1|2|3|-pre|-edit)/.test(n)
    ) {
        return 'image-gen';
    }

    // Embedding
    if (n.includes('embed') || n.includes('bge') || n.includes('m3e')) {
        return 'embedding';
    }

    // Vision / multimodal
    if (
        n.includes('vision') ||
        n.includes('-vl-') ||
        n.includes('-vl/') ||
        // Multimodal flagships
        n.includes('gpt-4o') ||
        n.includes('claude-opus') ||
        n.includes('claude-sonnet')
    ) {
        return 'vision';
    }

    return 'chat';
}

/** Vendor-classification rules. Order matters — match the most specific
 *  signal first. `Other` is the fallback.
 *
 *  Implementation note: plain string checks beat a single mega-regex here.
 *  Regex with `(^|[\/-])` boundary alternations is easy to get subtly wrong
 *  (zero-width `^` interacting with character-class), and the model names
 *  are short — readability wins over a single-pass scan. */
export function categorizeByVendor(modelName: string): VendorName {
    const n = modelName.toLowerCase();

    // OpenAI family — chat (gpt-/o1/o3/o4/chatgpt) + branded products
    // (dall-e/sora/whisper/tts-/text-embedding-). Brief lists the chat
    // signals; the branded extensions cover OpenAI's audio/image/embed
    // models that would otherwise fall to Other.
    if (
        n.startsWith('gpt-') ||
        n.startsWith('chatgpt') ||
        n.startsWith('dall-e') ||
        n.startsWith('sora') ||
        n.startsWith('whisper') ||
        n.startsWith('text-embedding') ||
        n.startsWith('tts-') ||
        n.startsWith('o1-') ||
        n === 'o1' ||
        n.startsWith('o3-') ||
        n === 'o3' ||
        n.startsWith('o4-') ||
        n === 'o4' ||
        // Vendor-prefixed copies under HF/SiliconFlow style routing rarely
        // exist for OpenAI models, but guard for `openai/` direct.
        n.startsWith('openai/')
    ) {
        return 'OpenAI';
    }

    if (n.includes('claude')) return 'Anthropic';
    if (n.includes('deepseek')) return 'DeepSeek';
    if (n.includes('qwen')) return 'Qwen';

    if (n.includes('glm') || n.includes('zai-org/') || n.includes('chatglm')) {
        return 'Zhipu';
    }

    if (n.includes('kimi') || n.includes('moonshot')) return 'Moonshot';
    if (n.includes('hunyuan')) return 'Tencent';
    if (n.includes('minimax')) return 'MiniMax';
    if (n.includes('flux')) return 'Black Forest Labs';

    return 'Other';
}

/**
 * Group raw model names into the type × vendor structure consumed by
 * the page. Stable + deterministic:
 *   - Outer keys ordered by `TYPE_ORDER`.
 *   - Vendor keys ordered by `VENDOR_ORDER`.
 *   - Models within a vendor ordered alphabetically.
 *
 * Empty buckets are NOT pre-populated — only types/vendors that actually
 * have models appear in the output. Callers iterating in display order
 * should walk `TYPE_ORDER` / `VENDOR_ORDER` and skip missing keys.
 */
export type GroupedModels = Partial<Record<TypeName, Partial<Record<VendorName, ModelEntry[]>>>>;

export interface GroupModelsResult {
    grouped: GroupedModels;
    totalModels: number;
    /** Number of distinct vendors observed. Used in the page header copy
     *  ("我们当前接入了 N 个模型,涵盖 X 个厂商"). */
    vendorCount: number;
}

export function groupModels(rawModelNames: string[]): GroupModelsResult {
    const seenVendors = new Set<VendorName>();
    const grouped: GroupedModels = {};

    // Dedup raw names defensively — new-api very occasionally returns
    // duplicates when channels overlap (W3 D2.5 model_mapping rebuild
    // appends short names too). Set keeps the first-seen ordering.
    const uniqueNames = Array.from(new Set(rawModelNames));

    for (const name of uniqueNames) {
        const type = categorizeByType(name);
        const vendor = categorizeByVendor(name);
        seenVendors.add(vendor);

        const entry: ModelEntry = {
            shortName: name,
            canonicalName: name,
            type,
            vendor,
        };

        let typeBucket = grouped[type];
        if (!typeBucket) {
            typeBucket = {};
            grouped[type] = typeBucket;
        }
        let vendorBucket = typeBucket[vendor];
        if (!vendorBucket) {
            vendorBucket = [];
            typeBucket[vendor] = vendorBucket;
        }
        vendorBucket.push(entry);
    }

    // Alphabetical sort within each vendor bucket — case-insensitive so
    // `Pro/foo` sits next to `foo` rather than miles away.
    for (const type of Object.keys(grouped) as TypeName[]) {
        const typeBucket = grouped[type]!;
        for (const vendor of Object.keys(typeBucket) as VendorName[]) {
            typeBucket[vendor]!.sort((a, b) => a.shortName.localeCompare(b.shortName, 'en', { sensitivity: 'base' }));
        }
    }

    return {
        grouped,
        totalModels: uniqueNames.length,
        vendorCount: seenVendors.size,
    };
}

/**
 * Filter the grouped structure by a free-form query (case-insensitive).
 * Matches against shortName, canonicalName, OR vendor name. Empty types
 * and empty vendors are pruned from the output so the UI only iterates
 * surviving buckets.
 *
 * Pure function — no React deps — so the component can call it from a
 * useMemo and tests can call it directly without rendering.
 */
export function filterGrouped(grouped: GroupedModels, rawQuery: string): GroupedModels {
    const q = rawQuery.trim().toLowerCase();
    if (!q) return grouped;

    const out: GroupedModels = {};
    for (const type of Object.keys(grouped) as TypeName[]) {
        const typeBucket = grouped[type]!;
        const filteredTypeBucket: Partial<Record<VendorName, ModelEntry[]>> = {};
        for (const vendor of Object.keys(typeBucket) as VendorName[]) {
            const matches = typeBucket[vendor]!.filter(
                (m) =>
                    m.shortName.toLowerCase().includes(q) ||
                    m.canonicalName.toLowerCase().includes(q) ||
                    vendor.toLowerCase().includes(q),
            );
            if (matches.length > 0) {
                filteredTypeBucket[vendor] = matches;
            }
        }
        if (Object.keys(filteredTypeBucket).length > 0) {
            out[type] = filteredTypeBucket;
        }
    }
    return out;
}

/** Convenience: total entries inside a `GroupedModels`. */
export function countGrouped(grouped: GroupedModels): number {
    let n = 0;
    for (const typeBucket of Object.values(grouped)) {
        for (const entries of Object.values(typeBucket ?? {})) {
            n += entries?.length ?? 0;
        }
    }
    return n;
}
