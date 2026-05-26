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

/** Vendor 分类 — W8 D7(2026-05-26)替代旧的 endpoint 分类。国外厂商前排展示。 */
export type ImageVendor = 'OpenAI' | 'Google' | 'SiliconFlow' | 'Other';

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
    /** Vendor 厂商分类(W8 D7 加入,替代 endpoint 分类)。 */
    vendor: ImageVendor;
    /** Foreign vs. domestic — foreign brands display first per operator
     *  decision(2026-05-26)。 */
    foreign: boolean;
}

const USD_TO_CNY_RATE = 7;

function cny(usd: number): number {
    return Math.round(usd * USD_TO_CNY_RATE * 100) / 100;
}

/** Order = display order in the dropdown. Default selection is the
 *  first entry (`Nano Banana`). Cheapest + most marketable name.
 *
 *  Price math (2026-05-22 修订):
 *    Gemini 家族 = wholesale_USD × 1.5 (¥1.5 抵官方 $1 规则,operator 2026-05-22 决策)
 *    gpt-image-2 = 维持 0% markup 不动(等 operator 决定是否纳入 ChatGPT 一档 ¥0.5/$1)
 *
 *  Wholesale USD 数字来自 _bootstrap/apply-pr-s-pricing.ts(PR-S, 2026-05-10)。
 *  对应后端 new-api global ModelRatio 通过 scripts/apply-new-pricing-global-2026-05-22.mjs
 *  同步更新(× 1.5/7 = × 0.2143 公式)。 */
// W8 D7(2026-05-26)重构:按厂商(vendor)分类,国外前排。
// 顺序 = 客户在下拉里看到的从上到下顺序。OpenAI 首选 → Google 系 → 后续国内系。
export const IMAGE_MODEL_OPTIONS: ImageModelOption[] = [
    // ── OpenAI(国外旗舰)──
    {
        id: 'gpt-image-2',
        label: 'GPT image-2',
        pricePerImageUsd: 0.04,
        pricePerImageCny: cny(0.04), // ¥0.28
        blurb: 'OpenAI · GPT-5 多模态图像生成',
        badge: '推荐',
        vendor: 'OpenAI',
        foreign: true,
    },
    // ── Google(国外)──
    {
        id: 'gemini-2.5-flash-image',
        label: 'Nano Banana',
        pricePerImageUsd: 0.00836, // 0.039 × 1.5/7
        pricePerImageCny: cny(0.00836), // ¥0.06
        blurb: 'Google 2.5 Flash Image · 入门首选',
        vendor: 'Google',
        foreign: true,
    },
    {
        id: 'gemini-3.1-flash-image-preview',
        label: 'Gemini 3.1 Flash Image',
        pricePerImageUsd: 0.02143, // 0.10 × 1.5/7
        pricePerImageCny: cny(0.02143), // ¥0.15
        blurb: 'Google · 高速 · 中等成本',
        vendor: 'Google',
        foreign: true,
    },
    {
        id: 'imagen-4.0-ultra-generate-001',
        label: 'Imagen 4 Ultra',
        pricePerImageUsd: 0.01286, // 0.06 × 1.5/7
        pricePerImageCny: cny(0.01286), // ¥0.09
        blurb: 'Google Imagen 4 · 高画质',
        vendor: 'Google',
        foreign: true,
    },
    {
        id: 'nano-banana-pro-preview',
        label: 'Nano Banana Pro',
        pricePerImageUsd: 0.04007, // 0.187 × 1.5/7
        pricePerImageCny: cny(0.04007), // ¥0.28
        blurb: 'Google 旗舰图像 · 最高画质',
        badge: '旗舰',
        vendor: 'Google',
        foreign: true,
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
