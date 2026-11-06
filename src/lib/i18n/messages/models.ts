/**
 * /models + /workspace/models — the portal shell around the vendored model
 * plaza and the portal-written price cells inside it (`plaza-prices.tsx`,
 * `model-prices.tsx`). The plaza itself translates through its own i18next
 * resources; page metadata lives in `common.ts` (`models.*`).
 *
 * `summary` maps the fixed Chinese labels produced by
 * `src/lib/models/catalog-price-summary.ts` (shared with /pricing and admin,
 * so it keeps emitting Chinese) to the display language. Unknown labels
 * (operator-defined tier names, resolution keys such as `720p`) pass
 * through unchanged.
 */
import { defineMessages } from '../index';

export const modelsMessages = defineMessages(
    {
        catalog: {
            heading: '模型广场',
            loadFailed: '当前无法获取模型清单与价格，请稍后重试。',
        },
        prices: {
            summaryAria: (tier: string | null) => `${tier ?? '当前分组'}价格摘要`,
            tierAria: (tier: string) => `${tier}价格`,
            perThousandTokens: '元 / 千 token',
            perToken: (unit: 'K' | 'M') => `/ ${unit === 'K' ? '千' : '百万'} token`,
            unpriced: '未定价',
            detailsIntro: '人民币报价 · 使用对应分组的 API Key 调用',
            noTierQuote: '当前分组无可用报价',
            dialogIntro: '完整价格 · 使用对应分组的 API Key 调用',
            closeDetails: '关闭价格详情',
            tieredIntro: '单位：元 / 百万 token。按完整输入长度选档，整次请求使用该档价格。',
            perMillionTokens: '元 / 百万 token',
            perImage: '张',
            perRequest: '次',
            input: '输入',
            output: '输出',
            cacheRead: '缓存读取',
            cacheWrite: '缓存写入',
            cacheWrite5m: '缓存写入 / 5 分钟',
            cacheWrite1h: '缓存写入 / 1 小时',
        },
        summary: {} as Record<string, string>,
    },
    {
        catalog: {
            heading: 'Model Plaza',
            loadFailed: 'Models and prices are unavailable right now. Please try again later.',
        },
        prices: {
            summaryAria: (tier: string | null) => `${tier ?? 'Current group'} price summary`,
            tierAria: (tier: string) => `${tier} prices`,
            perThousandTokens: 'CNY / 1K tokens',
            perToken: (unit: 'K' | 'M') => `/ ${unit === 'K' ? '1K' : '1M'} tokens`,
            unpriced: 'Not priced',
            detailsIntro: 'Prices in CNY · call with an API key from the matching group',
            noTierQuote: 'No price available for this group',
            dialogIntro: 'Full pricing · call with an API key from the matching group',
            closeDetails: 'Close price details',
            tieredIntro:
                'Unit: CNY / 1M tokens. The tier is chosen by the full input length, and the whole request is billed at that tier.',
            perMillionTokens: 'CNY / 1M tokens',
            perImage: 'image',
            perRequest: 'request',
            input: 'Input',
            output: 'Output',
            cacheRead: 'Cache read',
            cacheWrite: 'Cache write',
            cacheWrite5m: 'Cache write / 5 min',
            cacheWrite1h: 'Cache write / 1 hour',
        },
        summary: {
            '元 / 张': 'CNY / image',
            '元 / 次': 'CNY / request',
            '元 / 秒': 'CNY / second',
            '元 / 百万 token': 'CNY / 1M tokens',
            价格: 'Price',
            文本输入: 'Text input',
            输入: 'Input',
            输出: 'Output',
            常规价: 'Regular price',
            默认规格: 'Default spec',
            '图片输入另计，完整价格见详情': 'Image input billed separately; see details for full pricing',
            分时优惠与完整规格见详情: 'See details for off-peak discounts and every spec',
            更多规格价格见详情: 'See details for other specs',
            其他输入长度价格见详情: 'See details for other input lengths',
            '另含 token 计费，完整价格见详情': 'Token charges also apply; see details for full pricing',
            无参考视频: 'no reference video',
            有参考视频: 'with reference video',
            其他分辨率和参考视频的价格见详情: 'See details for other resolutions and reference video',
        } as Record<string, string>,
    },
);

export type ModelsMessages = (typeof modelsMessages)['zh'];

/**
 * Display a label from `catalog-price-summary.ts` in the current language.
 * Composite conditions (`常规价 · 720p`) are translated segment by segment;
 * anything without an entry is returned as-is.
 */
export function translateSummaryLabel(m: ModelsMessages, label: string): string {
    const direct = m.summary[label];
    if (direct !== undefined) return direct;
    if (!label.includes(' · ')) return label;
    return label
        .split(' · ')
        .map((part) => m.summary[part] ?? part)
        .join(' · ');
}
