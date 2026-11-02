/**
 * Public /pricing price sheet (`src/app/pricing/page.tsx`). Tier labels come
 * from `ChannelGroup.display_name` (operator data, not translated here).
 * Brand comes from `public-config` (never hard-coded here).
 */
import { BRAND_NAME } from '@/lib/public-config';
import type { VendorName } from '@/lib/models/categorize';
import { defineMessages } from '../index';

export const pricingMessages = defineMessages(
    {
        meta: {
            title: `模型价格 — ${BRAND_NAME}`,
            description: `${BRAND_NAME} 模型价格总表:Claude / GPT / Gemini 等按百万 token 计费,生图模型按张计费,全部人民币标价,按档次(号池 / 官方稳定 / 专属)分列。`,
        },
        back: '返回',
        title: '模型价格',
        /** Parts of one sentence around two <strong> and two links; spaces live inside the parts. */
        intro: {
            a: '全部为人民币标价:对话模型按 ',
            perToken: '¥ / 百万 token',
            b: '(输入 / 输出分列)计费,生图模型按 ',
            perImage: '¥ / 张',
            c: ' 计费。 同一模型的不同「档次」对应不同上游线路(号池 / 官方稳定 / 专属等),在 ',
            keysLink: '密钥管理',
            d: ' 创建 API Key 时选择。这里展示已保存的目录价格；完整模型清单见 ',
            modelsLink: '/models',
            e: '。',
        },
        specialBanner: '已按您的专属倍率显示价格',
        loadError: '当前无法获取价格表,请稍后重试。',
        footer: (n: number) =>
            `共 ${n} 个已标价模型。部分长尾模型(开源系 / 视频等)未列入本表, 以实际用量账单为准;如需批量或企业价,请联系我们。`,
        vendor: {
            modelCount: (n: number) => `${n} 个模型`,
            /** Vendor subtitles — zh mirrors `VENDOR_META[*].zh` in categorize.ts (the page renders that directly for zh). */
            sub: {
                OpenAI: 'GPT · Codex · 图像',
                Anthropic: 'Claude 系列',
                Google: 'Gemini',
                ByteDance: '字节跳动 · Seedance',
                DeepSeek: '深度求索',
                Qwen: '阿里通义千问',
                Zhipu: '智谱 AI',
                Moonshot: '月之暗面 Kimi',
                Tencent: '腾讯混元',
                MiniMax: 'MiniMax',
                'Black Forest Labs': 'FLUX',
                Other: '其他',
            } satisfies Record<VendorName, string>,
        },
        table: {
            model: '模型',
            tier: '档次',
            input: '输入 ¥/1M',
            output: '输出 ¥/1M',
            image: '生图 ¥/张',
            multiplier: '有效倍率',
            specialBadge: '专属价',
        },
        /** Second line in the tier cell when a row carries structured billing details. */
        billingHint: {
            media: '详细计费规则见下方',
            uniform: '统一单价 · 不随输入长度变化',
            tiered: '阶梯计费 · 此行显示首档',
        },
        tiered: {
            introUniform: '所有输入长度均使用以下单价。单位：元／百万 token。',
            introTiered: '按完整输入长度选择一档，整次请求按该档计费；不是分段累进。以下均为 ¥ / 百万 token。',
            aria: (tierLabel: string, uniform: boolean) => `${tierLabel}${uniform ? '统一单价' : '完整阶梯价格'}`,
            condition: '适用条件',
            input: '输入',
            output: '输出',
            cacheRead: '缓存读取',
            cacheWrite: '缓存写入',
            cacheWrite1h: '缓存写入 1 小时',
            notListed: '未单列',
        },
    },
    {
        meta: {
            title: `Model Pricing — ${BRAND_NAME}`,
            description: `${BRAND_NAME} price sheet: Claude / GPT / Gemini and more billed per million tokens, image models billed per image, all prices in CNY, listed per tier (pool / official stable / custom).`,
        },
        back: 'Back',
        title: 'Model pricing',
        intro: {
            a: 'All prices are in CNY: chat models are billed in ',
            perToken: '¥ per 1M tokens',
            b: ' (input / output listed separately), image models in ',
            perImage: '¥ per image',
            c: '. Different tiers of the same model map to different upstream routes (pool / official stable / custom); pick one when creating an API key under ',
            keysLink: 'API Keys',
            d: '. Prices shown here are the saved catalog prices; the full model list is at ',
            modelsLink: '/models',
            e: '.',
        },
        specialBanner: 'Prices shown with your custom rate applied',
        loadError: 'The price sheet is temporarily unavailable. Please try again later.',
        footer: (n: number) =>
            `${n} priced models in total. Some long-tail models (open-source / video) are not listed here — your usage statement is authoritative. Contact us for volume or enterprise pricing.`,
        vendor: {
            modelCount: (n: number) => `${n} model${n === 1 ? '' : 's'}`,
            sub: {
                OpenAI: 'GPT · Codex · Image',
                Anthropic: 'Claude family',
                Google: 'Gemini',
                ByteDance: 'ByteDance · Seedance',
                DeepSeek: 'DeepSeek',
                Qwen: 'Alibaba Qwen',
                Zhipu: 'Zhipu AI',
                Moonshot: 'Moonshot Kimi',
                Tencent: 'Tencent Hunyuan',
                MiniMax: 'MiniMax',
                'Black Forest Labs': 'FLUX',
                Other: 'Other',
            } satisfies Record<VendorName, string>,
        },
        table: {
            model: 'Model',
            tier: 'Tier',
            input: 'Input ¥/1M',
            output: 'Output ¥/1M',
            image: 'Image ¥/each',
            multiplier: 'Effective multiplier',
            specialBadge: 'Custom rate',
        },
        billingHint: {
            media: 'Full billing rules below',
            uniform: 'Uniform rate · same at every input length',
            tiered: 'Tiered pricing · this row shows the first tier',
        },
        tiered: {
            introUniform: 'These rates apply at every input length. Unit: ¥ per 1M tokens.',
            introTiered:
                'One tier is chosen by the full input length and the whole request is billed at that tier; it is not progressive. All prices in ¥ per 1M tokens.',
            aria: (tierLabel: string, uniform: boolean) =>
                `${tierLabel} ${uniform ? 'uniform rates' : 'full tiered pricing'}`,
            condition: 'Condition',
            input: 'Input',
            output: 'Output',
            cacheRead: 'Cache read',
            cacheWrite: 'Cache write',
            cacheWrite1h: 'Cache write (1 h)',
            notListed: 'Not listed',
        },
    },
);

export type PricingMessages = (typeof pricingMessages)['zh'];
