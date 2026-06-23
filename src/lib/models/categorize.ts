/**
 * Model categorization for the public /models page.
 *
 * Two orthogonal classifiers:
 *   - `categorizeByVendor` — WHO built it. This is the page's PRIMARY axis:
 *     the catalog is grouped vendor-first so each vendor appears exactly
 *     once (OpenAI / Anthropic / Google / ByteDance / …) instead of being
 *     scattered across every capability section.
 *   - `categorizeByType` — what the model DOES (chat / vision / image-gen /
 *     video / audio / embedding). Used as a light SECONDARY grouping inside
 *     each vendor and as a per-card badge. Checked in priority order so a
 *     multi-modal name lands in the most specific bucket (e.g.
 *     `gpt-4o-mini-tts` → audio, `gemini-2.5-flash-image` → image-gen).
 *
 * Source data: the raw string list returned by new-api
 * `GET /api/channel/models_enabled` (whatever is in each `channel.models`).
 *
 * Public API surface:
 *   - `classifyModels(raw)`  → flat, sorted `ModelEntry[]` (page primary).
 *   - `groupByVendor(entries)` / `filterEntries(entries, q)` → pure helpers
 *     the client component uses to render + search the vendor-first view.
 *   - `groupModels(raw)` / `filterGrouped` / `countGrouped` → the legacy
 *     type→vendor structure, kept because the Chat UI model picker
 *     (`src/lib/chat/models.ts`) still consumes it.
 *
 * NOT here: pricing, context window, etc. Deferred until new-api exposes it.
 */

export type TypeName = 'chat' | 'vision' | 'image-gen' | 'video' | 'audio' | 'embedding';

/** Display order — conversational first, then generative, then the
 *  long-tail utility modalities. */
export const TYPE_ORDER: readonly TypeName[] = ['chat', 'vision', 'image-gen', 'video', 'audio', 'embedding'] as const;

/** Section-level label (sub-headers inside a vendor block). */
export const TYPE_LABEL: Record<TypeName, string> = {
    chat: '对话模型',
    vision: '视觉理解',
    'image-gen': '图像生成',
    video: '视频生成',
    audio: '音频(语音 / 合成)',
    embedding: '向量嵌入',
};

/** Short chip label for the per-card type badge. */
export const TYPE_BADGE: Record<TypeName, string> = {
    chat: '对话',
    vision: '视觉',
    'image-gen': '图像',
    video: '视频',
    audio: '音频',
    embedding: '嵌入',
};

export type VendorName =
    | 'OpenAI'
    | 'Anthropic'
    | 'Google'
    | 'ByteDance'
    | 'DeepSeek'
    | 'Qwen'
    | 'Zhipu'
    | 'Moonshot'
    | 'Tencent'
    | 'MiniMax'
    | 'Black Forest Labs'
    | 'Other';

/** Display order — the vendors we actually serve lead, then the
 *  forward-compat long tail (SiliconFlow open-source vendors), Other last. */
export const VENDOR_ORDER: readonly VendorName[] = [
    'OpenAI',
    'Anthropic',
    'Google',
    'ByteDance',
    'DeepSeek',
    'Qwen',
    'Zhipu',
    'Moonshot',
    'Tencent',
    'MiniMax',
    'Black Forest Labs',
    'Other',
] as const;

/** Per-vendor presentation metadata for the section header — a monogram
 *  initial and an optional Chinese descriptor. Kept on-brand (no rainbow of
 *  per-vendor colors): the navy monogram + structure carries the grouping. */
export const VENDOR_META: Record<VendorName, { initial: string; zh?: string }> = {
    OpenAI: { initial: 'O', zh: 'GPT · Codex · 图像' },
    Anthropic: { initial: 'A', zh: 'Claude 系列' },
    Google: { initial: 'G', zh: 'Gemini' },
    ByteDance: { initial: 'B', zh: '字节跳动 · Seedance' },
    DeepSeek: { initial: 'D', zh: '深度求索' },
    Qwen: { initial: 'Q', zh: '阿里通义千问' },
    Zhipu: { initial: 'Z', zh: '智谱 AI' },
    Moonshot: { initial: 'M', zh: '月之暗面 Kimi' },
    Tencent: { initial: 'T', zh: '腾讯混元' },
    MiniMax: { initial: 'M', zh: 'MiniMax' },
    'Black Forest Labs': { initial: 'F', zh: 'FLUX' },
    Other: { initial: '·', zh: '其他' },
};

export interface ModelEntry {
    /** Customer-facing primary name = the exact wire name to pass as
     *  `model`. Today identical to `canonicalName`. */
    shortName: string;
    /** Full canonical name as new-api stores it. Slot kept so the UI can
     *  show a separate canonical line later without a schema change. */
    canonicalName: string;
    type: TypeName;
    vendor: VendorName;
}

/** "image" as a standalone token — matches `-image`, `image-`, `_image_`,
 *  `gpt-image-2`, `gemini_3.0_pro_image_preview_4K`, but NOT `imagenet`. */
const IMAGE_WORD = /(^|[^a-z])image([^a-z]|$)/;

/** Type-classification rules. Order matters — first match wins. Specific
 *  modalities are checked before the chat fallback. */
export function categorizeByType(modelName: string): TypeName {
    const n = modelName.toLowerCase();

    // Audio first — `gpt-4o-mini-tts` should NOT land in vision.
    if (n.includes('whisper') || n.includes('tts')) return 'audio';

    // Video — before image-gen so `…-video` / `seedance` don't get caught
    // by a stray image signal.
    if (
        n.includes('seedance') ||
        n.includes('dreamina') ||
        n.includes('sora') ||
        n.includes('veo') ||
        n.includes('kling') ||
        n.includes('hailuo') ||
        n.includes('runway') ||
        n.includes('cogvideo') ||
        n.includes('mochi') ||
        n.includes('wanx') ||
        n.includes('video')
    ) {
        return 'video';
    }

    // Image generation — explicit brands + the bounded `image` token.
    if (
        n.includes('dall-e') ||
        n.includes('flux') ||
        n.includes('midjourney') ||
        n.includes('imagen') ||
        n.includes('stable-diffusion') ||
        n.includes('sdxl') ||
        n.includes('sd3') ||
        IMAGE_WORD.test(n)
    ) {
        return 'image-gen';
    }

    // Embedding
    if (n.includes('embed') || n.includes('bge') || n.includes('m3e')) {
        return 'embedding';
    }

    // Vision / multimodal — Gemini (non-image, already filtered above) and
    // the multimodal flagships accept image input.
    if (
        n.includes('vision') ||
        n.includes('-vl-') ||
        n.includes('-vl/') ||
        n.includes('gemini') ||
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
 *  The model names are short — readability wins over a single-pass scan. */
export function categorizeByVendor(modelName: string): VendorName {
    const n = modelName.toLowerCase();

    // OpenAI family — chat (gpt-/o1/o3/o4/chatgpt) + branded products
    // (dall-e/sora/whisper/tts-/text-embedding-/gpt-image-).
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
        n.startsWith('openai/')
    ) {
        return 'OpenAI';
    }

    if (n.includes('claude')) return 'Anthropic';

    // Google — Gemini / Imagen / Veo / Gemma / PaLM.
    if (
        n.includes('gemini') ||
        n.includes('imagen') ||
        n.includes('veo') ||
        n.startsWith('gemma') ||
        n.includes('palm')
    ) {
        return 'Google';
    }

    // ByteDance — Seedance / Dreamina (即梦) video, Doubao (豆包).
    if (n.includes('seedance') || n.includes('dreamina') || n.includes('seedream') || n.includes('doubao')) {
        return 'ByteDance';
    }

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

// ───────────────────────────────────────────────────────────────────────────
// Catalog denylist — presentation-only.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Models hidden from EVERY customer-facing surface — the public /models page
 * AND the /chat model picker. These names are still routable through new-api,
 * so anyone passing them to the raw API keeps working; we just don't advertise
 * them. Exact wire-name match (the names new-api returns verbatim).
 *
 * Curated by the operator (2026-06-21):
 *   - `gemini_3.1_flash_image_preview` — duplicate spelling of the canonical
 *     `gemini-3.1-flash-image-preview` (underscore vs hyphen).
 *   - `gpt-5.3-codex-spark` — retired from the public catalog.
 *
 * To fully remove a model (make it uncallable) it must be dropped from the
 * new-api channel `models` list — that is an operator action, not a portal one.
 */
export const HIDDEN_MODELS: ReadonlySet<string> = new Set(['gemini_3.1_flash_image_preview', 'gpt-5.3-codex-spark']);

/** Drop denylisted names from a raw model-name list (dedup-friendly). */
function withoutHidden(names: string[]): string[] {
    return names.filter((n) => !HIDDEN_MODELS.has(n));
}

// ───────────────────────────────────────────────────────────────────────────
// Vendor-first view (page primary) — flat classified list + pure grouping.
// ───────────────────────────────────────────────────────────────────────────

export interface ClassifyResult {
    /** All entries, de-duped + sorted by VENDOR_ORDER → TYPE_ORDER → name. */
    entries: ModelEntry[];
    totalModels: number;
    /** Number of distinct vendors observed — header copy ("N 个模型,X 个厂商"). */
    vendorCount: number;
}

/**
 * Classify + de-dup + sort a raw model-name list into a flat `ModelEntry[]`.
 * The flat shape is intentionally simple so the client component owns the
 * grouping/filtering (cheap — the catalog is a few dozen entries).
 */
export function classifyModels(rawModelNames: string[]): ClassifyResult {
    const unique = withoutHidden(Array.from(new Set(rawModelNames)));
    const seenVendors = new Set<VendorName>();

    const entries: ModelEntry[] = unique.map((name) => {
        const type = categorizeByType(name);
        const vendor = categorizeByVendor(name);
        seenVendors.add(vendor);
        return { shortName: name, canonicalName: name, type, vendor };
    });

    const vIdx = (v: VendorName) => VENDOR_ORDER.indexOf(v);
    const tIdx = (t: TypeName) => TYPE_ORDER.indexOf(t);
    entries.sort(
        (a, b) =>
            vIdx(a.vendor) - vIdx(b.vendor) ||
            tIdx(a.type) - tIdx(b.type) ||
            a.shortName.localeCompare(b.shortName, 'en', { sensitivity: 'base' }),
    );

    return { entries, totalModels: unique.length, vendorCount: seenVendors.size };
}

export interface VendorTypeBucket {
    type: TypeName;
    entries: ModelEntry[];
}

export interface VendorSection {
    vendor: VendorName;
    total: number;
    /** Type sub-groups in TYPE_ORDER; only non-empty buckets present. */
    types: VendorTypeBucket[];
}

/**
 * Group a flat (already-sorted) entry list into vendor sections, each with
 * type sub-buckets. Walks VENDOR_ORDER / TYPE_ORDER so output is stable and
 * deterministic; empty vendors/types are omitted.
 */
export function groupByVendor(entries: ModelEntry[]): VendorSection[] {
    const byVendor = new Map<VendorName, ModelEntry[]>();
    for (const e of entries) {
        const list = byVendor.get(e.vendor);
        if (list) list.push(e);
        else byVendor.set(e.vendor, [e]);
    }

    const sections: VendorSection[] = [];
    for (const vendor of VENDOR_ORDER) {
        const list = byVendor.get(vendor);
        if (!list || list.length === 0) continue;
        const types: VendorTypeBucket[] = [];
        for (const type of TYPE_ORDER) {
            const ofType = list.filter((m) => m.type === type);
            if (ofType.length > 0) types.push({ type, entries: ofType });
        }
        sections.push({ vendor, total: list.length, types });
    }
    return sections;
}

/**
 * Filter a flat entry list by a free-form query (case-insensitive). Matches
 * model name, vendor (English + Chinese descriptor), or type (Chinese label
 * + short badge) so a customer can search "字节" / "视频" / "gemini" alike.
 */
export function filterEntries(entries: ModelEntry[], rawQuery: string): ModelEntry[] {
    const q = rawQuery.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
        (m) =>
            m.shortName.toLowerCase().includes(q) ||
            m.canonicalName.toLowerCase().includes(q) ||
            m.vendor.toLowerCase().includes(q) ||
            (VENDOR_META[m.vendor].zh ?? '').toLowerCase().includes(q) ||
            TYPE_LABEL[m.type].toLowerCase().includes(q) ||
            TYPE_BADGE[m.type].toLowerCase().includes(q),
    );
}

// ───────────────────────────────────────────────────────────────────────────
// Legacy type→vendor view — retained for the Chat UI model picker.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Type→vendor nested structure. Kept for `src/lib/chat/models.ts`, which
 * collapses the chat+vision buckets into the picker list. The /models page
 * itself no longer uses this — it consumes `classifyModels` + `groupByVendor`.
 */
export type GroupedModels = Partial<Record<TypeName, Partial<Record<VendorName, ModelEntry[]>>>>;

export interface GroupModelsResult {
    grouped: GroupedModels;
    totalModels: number;
    vendorCount: number;
}

export function groupModels(rawModelNames: string[]): GroupModelsResult {
    const seenVendors = new Set<VendorName>();
    const grouped: GroupedModels = {};

    const uniqueNames = withoutHidden(Array.from(new Set(rawModelNames)));

    for (const name of uniqueNames) {
        const type = categorizeByType(name);
        const vendor = categorizeByVendor(name);
        seenVendors.add(vendor);

        const entry: ModelEntry = { shortName: name, canonicalName: name, type, vendor };

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

/** Filter the legacy grouped structure by a free-form query. */
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
