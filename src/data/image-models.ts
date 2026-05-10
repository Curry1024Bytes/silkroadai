/**
 * Image-gen UI model lineup (PR-T2).
 *
 * Friendly customer-facing labels mapped to the canonical SKU id that
 * the /api/portal/image/generate handler accepts. Keep this in sync
 * with `src/lib/image-gen/models.ts:IMAGE_MODELS` (server-side
 * whitelist) — the `id` here MUST be a member of that whitelist or
 * the generate handler returns 400.
 *
 * Customer-facing label can be aliased (e.g. `Nano Banana` → routes to
 * `gemini-2.5-flash-image`); operator can rename labels here without
 * any backend / channel changes.
 *
 * Pricing in CNY = pricePerImageUsd × USD_TO_CNY_RATE (¥7). Numbers
 * mirror the server-side `pricePerImageUsd` so the cost preview the
 * customer sees matches the server's authoritative deduction within
 * the standard ¥7 / 1.5× markup math.
 */

export interface ImageModelOption {
    /** Routable model id sent to /api/portal/image/generate. Must match
     *  a row in `src/lib/image-gen/models.ts`. */
    id: string;
    /** Customer-facing display name. */
    label: string;
    /** Per-image USD price (post 1.5× markup, matches server). */
    pricePerImageUsd: number;
    /** Per-image CNY price (preview only — billing is server-side). */
    pricePerImageCny: number;
    /** One-line marketing tag. */
    blurb: string;
    /** Optional badge for the dropdown card (e.g. `推荐` / `旗舰`). */
    badge?: string;
}

const USD_TO_CNY_RATE = 7;

function cny(usd: number): number {
    return Math.round(usd * USD_TO_CNY_RATE * 100) / 100;
}

/** Order = display order in the dropdown. Default selection is the
 *  first entry (`Nano Banana`). Cheapest + most marketable name.
 *
 *  Price values mirror the server-side `_bootstrap/apply-pr-s-pricing.ts`
 *  PER_IMAGE_USD * markup. As of 2026-05-10 the Gemini family is at +10%
 *  markup (was +50%) and gpt-image-2 is at 0% markup (sub2api wholesale
 *  passthrough); see PR #55 for the live diff. */
export const IMAGE_MODEL_OPTIONS: ImageModelOption[] = [
    {
        id: 'gemini-2.5-flash-image',
        label: 'Nano Banana',
        pricePerImageUsd: 0.0429, // 0.039 × 1.1
        pricePerImageCny: cny(0.0429), // ¥0.30
        blurb: 'Google 2.5 Flash Image · 入门首选',
        badge: '推荐',
    },
    {
        id: 'gpt-image-2',
        label: 'GPT image-2',
        pricePerImageUsd: 0.04, // 0% markup — operator-decided cost-only retail
        pricePerImageCny: cny(0.04), // ¥0.28
        blurb: 'OpenAI · ChatGPT 风格 prompt',
    },
    {
        id: 'imagen-4.0-ultra-generate-001',
        label: 'Imagen 4 Ultra',
        pricePerImageUsd: 0.066, // 0.06 × 1.1
        pricePerImageCny: cny(0.066), // ¥0.46
        blurb: 'Google Imagen 4 · 高画质',
    },
    {
        id: 'gemini-3.1-flash-image-preview',
        label: 'Gemini 3.1 Flash Image',
        pricePerImageUsd: 0.11, // 0.10 × 1.1
        pricePerImageCny: cny(0.11), // ¥0.77
        blurb: 'Google · 中等成本',
    },
    {
        id: 'nano-banana-pro-preview',
        label: 'Nano Banana Pro',
        pricePerImageUsd: 0.2057, // 0.187 × 1.1
        pricePerImageCny: cny(0.2057), // ¥1.44
        blurb: 'Google 旗舰图像 · 最高画质',
        badge: '旗舰',
    },
];

export const DEFAULT_IMAGE_MODEL_ID = IMAGE_MODEL_OPTIONS[0].id;

export const IMAGE_SIZE_OPTIONS = [
    { id: '1024x1024', label: '正方形', sub: '1024×1024' },
    { id: '1024x1792', label: '竖屏', sub: '1024×1792' },
    { id: '1792x1024', label: '横屏', sub: '1792×1024' },
] as const;

export const IMAGE_COUNT_OPTIONS = [1, 2, 3, 4] as const;

export const PROMPT_MAX_CHARS = 1000;

export const SAMPLE_PROMPTS: string[] = [
    '赛博朋克风格的丝绸之路:沙漠、霓虹、骆驼商队',
    '一只戴着小皇冠的橘猫坐在故宫红墙前',
    '极简主义海报:抽象几何 · 暖色调 · 留白',
    '水彩风格的江南水乡 · 薄雾 · 黎明',
];
