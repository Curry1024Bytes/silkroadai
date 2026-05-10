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
 * Which upstream new-api endpoint a model expects.
 *   - `images/generations`  POST /v1/images/generations  body { model, prompt,
 *                           n, size, response_format }; response shape =
 *                           `{ data: [{ b64_json }] }`. Used by OpenAI-style
 *                           image-gen SKUs (gpt-image-2) + Google Imagen.
 *   - `chat/completions`    POST /v1/chat/completions  body { model, messages };
 *                           response shape = `choices[0].message.content` is
 *                           markdown text with `data:image/<mime>;base64,...`
 *                           inline. Used by Google's Gemini-class image
 *                           models (Nano Banana / 3.1-flash-image / 3-pro-image).
 *
 * Trying to call a Gemini image model via /v1/images/generations returns
 * `{"error":{"code":"convert_request_failed","message":"not supported model
 * for image generation, only imagen models are supported"}}` — confirmed
 * live 2026-05-09.
 */
export type ImageApiPath = 'images/generations' | 'chat/completions';

export interface ImageModelInfo {
    /** Wire model name (matches `model_name` in /api/pricing). */
    id: string;
    /** Display name on UI. */
    label: string;
    /** Human-readable per-image USD price after PR-S markup. */
    pricePerImageUsd: number;
    /** Short marketing blurb for cards. */
    blurb: string;
    /** Which new-api endpoint to forward to. Default `images/generations`
     *  (the OpenAI-shaped surface); override to `chat/completions` for
     *  Gemini-family image models. */
    apiPath: ImageApiPath;
}

// Price values match `_bootstrap/apply-pr-s-pricing.ts` PER_IMAGE_USD ×
// markup as of 2026-05-10 (PR #55 — Gemini family +10%, gpt-image-2 0%).
export const IMAGE_MODELS: ImageModelInfo[] = [
    {
        id: 'gemini-2.5-flash-image',
        label: 'Nano Banana',
        pricePerImageUsd: 0.0429, // 0.039 × 1.1
        blurb: 'Google 2.5 Flash Image · 入门首选',
        apiPath: 'chat/completions',
    },
    {
        id: 'gemini-3.1-flash-image-preview',
        label: 'Gemini 3.1 Flash Image',
        pricePerImageUsd: 0.11, // 0.10 × 1.1
        blurb: 'Google · 高速生图 · 中等成本',
        apiPath: 'chat/completions',
    },
    {
        id: 'gemini-3-pro-image-preview',
        label: 'Gemini 3 Pro Image',
        pricePerImageUsd: 0.2057, // 0.187 × 1.1
        blurb: 'Google 旗舰图像 · Nano Banana Pro',
        apiPath: 'chat/completions',
    },
    {
        id: 'nano-banana-pro-preview',
        label: 'Nano Banana Pro',
        pricePerImageUsd: 0.2057, // alias of -3-pro-image
        blurb: 'Google 旗舰图像 (alias)',
        apiPath: 'chat/completions',
    },
    {
        id: 'imagen-4.0-ultra-generate-001',
        label: 'Imagen 4 Ultra',
        pricePerImageUsd: 0.066, // 0.06 × 1.1
        blurb: 'Google Imagen 4 Ultra · 高画质',
        apiPath: 'images/generations',
    },
    {
        id: 'gpt-image-2',
        label: 'GPT Image 2',
        pricePerImageUsd: 0.04, // 0% markup — sub2api subscription arbitrage
        blurb: 'OpenAI · 兼容 chat 风格 prompt',
        apiPath: 'images/generations',
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
