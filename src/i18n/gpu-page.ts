/**
 * /gpu page i18n strings (W7 PR-P).
 *
 * Shape `Map<string, { zh: string; en?: string }>` — i18n hook for the
 * future global locale switch. Today every consumer reads `.zh`; when
 * the en pass lands, components either:
 *   - Read `entry.en ?? entry.zh` so missing translations gracefully
 *     fall back to Chinese, or
 *   - The locale-aware helper `t(id, locale)` (added with the locale
 *     switch in a later PR) does the lookup centrally.
 *
 * String IDs use snake_case for grep-ability. Group IDs by section
 * prefix so search-and-replace stays scoped (e.g. all hero strings
 * under `hero_*`, all flow strings under `flow_*`).
 *
 * NOT in this file:
 *   - SKU pricing or specs (those live in `src/data/gpu-pricing.ts`,
 *     same i18n hook there if/when needed).
 *   - SEO meta strings — those are in the page's `metadata` export
 *     directly, since Next reads them at build/SSR time, not at
 *     render time.
 */

export interface GpuPageString {
    zh: string;
    en?: string;
}

export const GPU_PAGE_STRINGS: Record<string, GpuPageString> = {
    // ─── Hero ────────────────────────────────────────────────────────
    hero_title: { zh: '专属 GPU 算力 · 从 H100 到 B300' },
    hero_subtitle: { zh: '为模型训练 / 高吞吐推理 / AI 创业团队定制' },
    hero_cta: { zh: '加微信询价' },
    hero_cta_hint: { zh: '微信号' },

    // ─── Section: 三档卡片 ───────────────────────────────────────────
    pricing_section_title: { zh: 'GPU 卡型与起租区间' },
    pricing_section_subtitle: { zh: '所有报价含机房 / 电力 / 7×24 运维。集群 / 长期租赁有专属合同价,详情面议。' },
    pricing_card_arch_label: { zh: '架构' },
    pricing_card_memory_label: { zh: '显存' },
    pricing_card_lease_term_label: { zh: '起租期' },
    pricing_card_quantity_label: { zh: '起租量' },
    pricing_card_monthly_unit: { zh: '月' },
    pricing_card_from: { zh: '起' },
    pricing_card_use_cases_label: { zh: '适用场景' },
    pricing_card_cta: { zh: '加微信详谈' },

    // ─── Section: 服务流程 ───────────────────────────────────────────
    flow_section_title: { zh: '服务流程' },
    flow_section_subtitle: { zh: '4 步从询价到上线' },

    // ─── Section: 资源优势 ───────────────────────────────────────────
    advantages_section_title: { zh: '为什么选 Silk Road AI' },

    // ─── Section: 适用客户 ───────────────────────────────────────────
    customers_section_title: { zh: '适用客户' },
    customers_section_subtitle: { zh: '从 AI 创业团队到企业 R&D — 弹性租期 / 卡型组合按需调整。' },

    // ─── Section: 联系方式 ───────────────────────────────────────────
    contact_section_title: { zh: '联系我们' },
    contact_wechat_label: { zh: '微信' },
    contact_email_label: { zh: '邮箱' },
    contact_back_to_landing: { zh: '← 返回首页' },
};

/**
 * Type-safe accessor. Throws at startup-time if the id doesn't exist
 * (catches typos at SSR). Returns `.zh` today; the future locale
 * switch can replace this with `entry[locale] ?? entry.zh`.
 */
export function t(id: keyof typeof GPU_PAGE_STRINGS): string {
    const entry = GPU_PAGE_STRINGS[id];
    if (!entry) {
        throw new Error(`[gpu-page i18n] unknown string id: ${String(id)}`);
    }
    return entry.zh;
}
