/**
 * Whitelist of image generation models the portal exposes via the
 * /api/portal/image/generate handler (PR-T1 Phase 3).
 *
 * Why a whitelist? new-api routes by name → channel.models, so any
 * SKU operator adds elsewhere becomes implicitly callable by the
 * customer-facing OpenAI SDK. For the portal-managed image gen UI we
 * want a curated set with known cost-per-image so we can:
 *   - show a cost preview in the UI before submit
 *   - reject unknown models with a clean 400 (vs upstream 503)
 *   - keep the price floor explicit during onboarding
 *
 * Prices match `_bootstrap/apply-pr-s-pricing.ts:PER_IMAGE_USD` after
 * the PR-S 1.5× markup is applied. If those server-side ratios drift,
 * the cost preview in the UI drifts but billing is still authoritative
 * (new-api real ModelPrice deduct). Drift tolerance: ±10% acceptable
 * for UI; >10% requires a refresh here. Pure data, safe to import
 * client-side or server-side.
 */

/**
 * Vendor classification (W8 D7 2026-05-26 重构 — 替代旧的 endpoint 分类)。
 * 国外厂商前排展示(foreign=true),国内厂商后排。Backend 不再按 endpoint
 * 分类路由 — generate route 会智能 fallback(先 chat/completions,失败的
 * "wrong endpoint" signal 才 fallback 到 /v1/images/generations)。
 */
export type ImageVendor = 'OpenAI' | 'Google' | 'SiliconFlow' | 'Other';

export interface ImageModelInfo {
    /** Wire model name (matches `model_name` in new-api channel.models). */
    id: string;
    /** Display name on UI. */
    label: string;
    /** Human-readable per-image USD price. */
    pricePerImageUsd: number;
    /** Short marketing blurb for cards. */
    blurb: string;
    /** Vendor classification for grouping in UI. */
    vendor: ImageVendor;
    /** Foreign vs. domestic — foreign brands display first per operator
     *  decision (2026-05-26). */
    foreign: boolean;
    /**
     * Target Gemini output resolution (W8 D8, 2026-06-04). When set, the
     * generate route MUST call the upstream via the native Gemini
     * `/v1beta/models/{id}:generateContent` endpoint with
     * `generationConfig.imageConfig.imageSize` = this value — that is the
     * ONLY request shape Channel 17 (nexaxis) honors for higher
     * resolution. The OpenAI-compatible /v1/chat/completions path silently
     * drops the hint and Google falls back to its 1408×768 (~1K) default,
     * which is what these SKUs were (wrongly) returning while billed at
     * 2K/4K. See docs/W8-D8-NEXAXIS-IMAGE-RESOLUTION.md.
     *
     * Only set on SKUs whose billing assumes >1K output. 1K-tier SKUs
     * (gemini-2.5-flash-image, which physically caps at 1408×768) and
     * non-Gemini SKUs (gpt-image-2, Imagen) leave this undefined and keep
     * their existing chat/completions → images/generations path.
     */
    geminiImageSize?: '2K' | '4K';
    /**
     * Skip the /v1/chat/completions attempt and dispatch straight to
     * /v1/images/generations (2026-06-15). The czeq upstream behind ch36 is
     * images-API-only and answers /v1/chat/completions with HTTP 200 + a polite
     * text ("画图请使用画图端点") instead of an image or a wrong-endpoint error —
     * so the route's auto-fallback can't fire and the empty body would surface
     * as a bogus content_filter 400. Set on images-API-only SKUs (gpt-image-2).
     */
    imagesApiOnly?: boolean;
}

// 顺序 = UI 展示顺序(国外前排,OpenAI 旗舰首选,然后 Google 系)
// Price values match `_bootstrap/apply-pr-s-pricing.ts` PER_IMAGE_USD.
// W8 D7(2026-05-26):旧 apiPath 字段去除,后端改 smart auto-fallback。
export const IMAGE_MODELS: ImageModelInfo[] = [
    // ── 国外:OpenAI ──
    {
        id: 'gpt-image-2',
        // Legacy preview price only; live routing/group and authoritative charge
        // are resolved from new-api at request time.
        label: 'GPT Image 2',
        pricePerImageUsd: 0.00714, // = ¥0.05 / 7, matches new-api ModelPrice
        blurb: 'OpenAI · GPT-5 多模态图像生成',
        vendor: 'OpenAI',
        foreign: true,
        imagesApiOnly: true,
    },
    // ── 国外:Google ──
    {
        id: 'gemini-2.5-flash-image',
        label: 'Nano Banana',
        pricePerImageUsd: 0.0429,
        blurb: 'Google 2.5 Flash Image · 入门首选',
        vendor: 'Google',
        foreign: true,
    },
    {
        id: 'gemini-3.1-flash-image-preview',
        label: 'Gemini 3.1 Flash Image',
        pricePerImageUsd: 0.11,
        blurb: 'Google · 高速生图 · 中等成本',
        vendor: 'Google',
        foreign: true,
        geminiImageSize: '2K', // billed 2K; flash caps at 2K (4K → upstream 503)
    },
    {
        id: 'gemini-3-pro-image-preview',
        label: 'Gemini 3 Pro Image',
        pricePerImageUsd: 0.2057,
        blurb: 'Google 旗舰图像 · Nano Banana Pro',
        vendor: 'Google',
        foreign: true,
        geminiImageSize: '4K', // billed 4K; Nano Banana Pro supports 1K/2K/4K
    },
    {
        id: 'nano-banana-pro-preview',
        label: 'Nano Banana Pro',
        pricePerImageUsd: 0.2057,
        blurb: 'Google 旗舰图像 (alias)',
        vendor: 'Google',
        foreign: true,
        geminiImageSize: '4K', // alias of gemini-3-pro-image-preview
    },
    {
        id: 'imagen-4.0-ultra-generate-001',
        label: 'Imagen 4 Ultra',
        pricePerImageUsd: 0.066,
        blurb: 'Google Imagen 4 Ultra · 高画质',
        vendor: 'Google',
        foreign: true,
    },
];

export const IMAGE_MODEL_IDS = IMAGE_MODELS.map((m) => m.id);

export const IMAGE_SIZES = ['1024x1024', '1024x1792', '1792x1024'] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

export const IMAGE_COUNT_MIN = 1;
export const IMAGE_COUNT_MAX = 4;

/** Lookup helper. Returns undefined for unknown ids. */
export function findImageModel(id: string): ImageModelInfo | undefined {
    return IMAGE_MODELS.find((m) => m.id === id);
}

/**
 * Map a portal `size` selection to a Gemini `imageConfig.aspectRatio`.
 * The native Gemini image API controls pixel count via `imageSize`
 * ("2K"/"4K") and shape via `aspectRatio` — they are orthogonal, so the
 * customer's aspect choice survives the resolution bump (W8 D8). Falls
 * back to a square 1:1 for anything unexpected.
 */
export function sizeToAspectRatio(size: string): string {
    switch (size) {
        case '1024x1792':
            return '9:16'; // portrait
        case '1792x1024':
            return '16:9'; // landscape
        case '1024x1024':
        default:
            return '1:1';
    }
}
