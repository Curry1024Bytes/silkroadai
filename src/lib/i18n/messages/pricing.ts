/**
 * Public /pricing price sheet (`src/app/pricing/page.tsx`). Tier labels come
 * from `ChannelGroup.display_name` (operator data, not translated here).
 */
import { defineMessages } from '../index';
import type { VendorName } from '@/lib/models/categorize';

export const pricingMessages = defineMessages(
    {
        meta: {
            title: '模型价格 — Silk Road AI',
            description:
                'Silk Road AI 模型价格总表:Claude / GPT / Gemini 等按百万 token 计费,生图模型按张计费,全部人民币标价,按档次(号池 / 官方稳定 / 专属)分列。',
        },
        back: '返回',
        title: '模型价格',
        intro: {
            a: '全部为人民币标价:对话模型按 ',
            perToken: '¥ / 百万 token',
            b: '(输入 / 输出分列)计费,生图模型按 ',
            perImage: '¥ / 张',
            c: ' 计费。同一模型的不同「档次」对应不同上游线路(号池 / 官方稳定 / 专属等),在',
            keysLink: '密钥管理',
            d: '创建 API Key 时选择。价格数据与计费系统同源实时读取;完整模型清单见',
            modelsLink: '/models',
            e: '。',
        },
        specialBanner: (tiers: string[]) => `已按您的专属倍率显示价格(专属档次:${tiers.join('、')}),与实际扣费一致。`,
        loadError: '当前无法获取价格表,请稍后重试。',
        footer: (n: number) =>
            `共 ${n} 个已标价模型。部分长尾模型(开源系 / 视频等)未列入本表,以实际用量账单为准;如需批量或企业价,请联系我们。`,
        vendor: {
            modelCount: (n: number) => `${n} 个模型`,
            /** Vendor subtitles — zh mirrors `VENDOR_META[*].zh` in categorize.ts. */
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
            specialBadge: '专属价',
        },
    },
    {
        meta: {
            title: 'Model Pricing — Silk Road AI',
            description:
                'Silk Road AI price sheet: Claude / GPT / Gemini and more billed per million tokens, image models billed per image, all prices in CNY, listed per tier (pool / official stable / custom).',
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
            d: '. Prices are read live from the same catalog the billing meter uses; the full model list is at ',
            modelsLink: '/models',
            e: '.',
        },
        specialBanner: (tiers: string[]) =>
            `Prices shown with your custom rate applied (custom tiers: ${tiers.join(', ')}) — identical to what you are charged.`,
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
            specialBadge: 'Custom rate',
        },
    },
);

export type PricingMessages = (typeof pricingMessages)['zh'];
