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

import type { Locale } from '@/lib/i18n';

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
    /** One-line marketing tag (Chinese — site default). */
    blurb: string;
    /** English edition of `blurb` (i18n). Pick with `imageModelBlurb()`. */
    blurbEn: string;
    /** Optional badge for the dropdown card (e.g. `推荐` / `旗舰`). */
    badge?: string;
    /** English edition of `badge`. Pick with `imageModelBadge()`. */
    badgeEn?: string;
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
 *  GPT image-2 已切到 API Key 专用的 1K/2K/4K 固定价 SKU;本 Studio 仍有可变
 *  size 控件,不能在这里暴露它们,否则会制造档位/尺寸冲突。等 Studio 改为档位绑定后再单独接入。
 *
 *  Wholesale USD 数字来自 _bootstrap/apply-pr-s-pricing.ts(PR-S, 2026-05-10)。
 *  对应后端 new-api global ModelRatio 通过 scripts/apply-new-pricing-global-2026-05-22.mjs
 *  同步更新(× 1.5/7 = × 0.2143 公式)。 */
// W8 D7(2026-05-26)按厂商(vendor)分类,国外前排。
// 当前 Studio 只展示可与其独立 size 控件兼容的 Google 系模型。
export const IMAGE_MODEL_OPTIONS: ImageModelOption[] = [
    // ── Google(国外)── ¥0.5/$1
    {
        id: 'gemini-2.5-flash-image',
        label: 'Nano Banana',
        pricePerImageUsd: 0.00279, // 0.039 × 0.5/7
        pricePerImageCny: cny(0.00279), // ¥0.02
        blurb: 'Google 2.5 Flash Image · 入门首选',
        blurbEn: 'Google 2.5 Flash Image · best starter pick',
        vendor: 'Google',
        foreign: true,
    },
    {
        id: 'gemini-3.1-flash-image-preview',
        label: 'Gemini 3.1 Flash Image',
        pricePerImageUsd: 0.00714, // 0.10 × 0.5/7
        pricePerImageCny: cny(0.00714), // ¥0.05
        blurb: 'Google · 高速 · 中等成本',
        blurbEn: 'Google · fast · mid-range cost',
        vendor: 'Google',
        foreign: true,
    },
    {
        id: 'imagen-4.0-ultra-generate-001',
        label: 'Imagen 4 Ultra',
        pricePerImageUsd: 0.00429, // 0.06 × 0.5/7
        pricePerImageCny: cny(0.00429), // ¥0.03
        blurb: 'Google Imagen 4 · 高画质',
        blurbEn: 'Google Imagen 4 · high fidelity',
        vendor: 'Google',
        foreign: true,
    },
    {
        id: 'nano-banana-pro-preview',
        label: 'Nano Banana Pro',
        pricePerImageUsd: 0.01336, // 0.187 × 0.5/7
        pricePerImageCny: cny(0.01336), // ¥0.09
        blurb: 'Google 旗舰图像 · 最高画质',
        blurbEn: 'Google flagship image model · top quality',
        badge: '旗舰',
        badgeEn: 'Flagship',
        vendor: 'Google',
        foreign: true,
    },
];

export const DEFAULT_IMAGE_MODEL_ID = IMAGE_MODEL_OPTIONS[0].id;

export const IMAGE_SIZE_OPTIONS = [
    { id: '1024x1024', label: '正方形', labelEn: 'Square', sub: '1024×1024' },
    { id: '1024x1792', label: '竖屏', labelEn: 'Portrait', sub: '1024×1792' },
    { id: '1792x1024', label: '横屏', labelEn: 'Landscape', sub: '1792×1024' },
] as const;

export const IMAGE_COUNT_OPTIONS = [1, 2, 3, 4] as const;

export const PROMPT_MAX_CHARS = 1000;

export const SAMPLE_PROMPTS: string[] = [
    '赛博朋克风格的丝绸之路:沙漠、霓虹、骆驼商队',
    '一只戴着小皇冠的橘猫坐在故宫红墙前',
    '极简主义海报:抽象几何 · 暖色调 · 留白',
    '水彩风格的江南水乡 · 薄雾 · 黎明',
];

/** English edition of `SAMPLE_PROMPTS` (same count / order). */
export const SAMPLE_PROMPTS_EN: string[] = [
    'A cyberpunk Silk Road: desert, neon lights, a camel caravan',
    'An orange cat wearing a tiny crown, sitting in front of the red walls of the Forbidden City',
    'Minimalist poster: abstract geometry · warm palette · generous white space',
    'A watercolor Jiangnan water town · thin mist · dawn',
];

// ── Locale pickers (i18n) ─────────────────────────────────────────────
// The Chinese fields above are the source of truth (existing tests assert
// them); these helpers choose the English edition when the site locale is
// `en`. Kept here so the data file owns both editions of every string.

export function imageModelBlurb(m: ImageModelOption, locale: Locale): string {
    return locale === 'en' ? m.blurbEn : m.blurb;
}

export function imageModelBadge(m: ImageModelOption, locale: Locale): string | undefined {
    return locale === 'en' ? m.badgeEn : m.badge;
}

export function imageSizeLabel(s: (typeof IMAGE_SIZE_OPTIONS)[number], locale: Locale): string {
    return locale === 'en' ? s.labelEn : s.label;
}

export function samplePrompts(locale: Locale): string[] {
    return locale === 'en' ? SAMPLE_PROMPTS_EN : SAMPLE_PROMPTS;
}
