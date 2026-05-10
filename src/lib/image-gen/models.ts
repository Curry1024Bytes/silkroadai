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

export interface ImageModelInfo {
    /** Wire model name (matches `model_name` in /api/pricing). */
    id: string;
    /** Display name on UI. */
    label: string;
    /** Human-readable per-image USD price after PR-S markup. */
    pricePerImageUsd: number;
    /** Short marketing blurb for cards. */
    blurb: string;
}

export const IMAGE_MODELS: ImageModelInfo[] = [
    // PR-T2 prep: re-added gemini-2.5-flash-image (canonical Google name,
    // no `-preview` suffix; the W7 PR-S 2.5 cleanup dropped it because
    // no channel routed it). Operator added it to channel 4 for /image
    // launch; ratio re-applied + verified live (quota=58,500 = $0.0585 × 1M).
    {
        id: 'gemini-2.5-flash-image',
        label: 'Nano Banana',
        pricePerImageUsd: 0.0585,
        blurb: 'Google 2.5 Flash Image · 入门首选',
    },
    {
        id: 'gemini-3.1-flash-image-preview',
        label: 'Gemini 3.1 Flash Image',
        pricePerImageUsd: 0.15,
        blurb: 'Google · 高速生图 · 中等成本',
    },
    {
        id: 'gemini-3-pro-image-preview',
        label: 'Gemini 3 Pro Image',
        pricePerImageUsd: 0.2805,
        blurb: 'Google 旗舰图像 · Nano Banana Pro',
    },
    {
        id: 'nano-banana-pro-preview',
        label: 'Nano Banana Pro',
        pricePerImageUsd: 0.2805,
        blurb: 'Google 旗舰图像 (alias)',
    },
    {
        id: 'imagen-4.0-ultra-generate-001',
        label: 'Imagen 4 Ultra',
        pricePerImageUsd: 0.09,
        blurb: 'Google Imagen 4 Ultra · 高画质',
    },
    {
        id: 'gpt-image-2',
        label: 'GPT Image 2',
        pricePerImageUsd: 0.06,
        blurb: 'OpenAI · 兼容 chat 风格 prompt',
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
