import 'server-only';
import { parseTieredPricingExpression } from '@/lib/admin/pricing-tiered-expression';
import { IMAGE_FX } from './pricing-sync';
import {
    parseCatalogBillingDetails,
    scaleCatalogBillingDetails,
    type CatalogBillingDetails,
} from '@/lib/models/catalog-pricing-details';
import type { RawSyncPrices, SyncPriceResult } from './catalog-sync-prices';

export function syncDictionary(raw: unknown, name: string): Record<string, unknown> {
    if (raw === undefined) return {};
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${name} 配置格式无效`);
    return parsed as Record<string, unknown>;
}
const own = (dict: Record<string, unknown>, key: string) => (Object.hasOwn(dict, key) ? dict[key] : undefined);

/** The supported image expression is a complete linear tier, never executable code or a partial match. */
function componentExpression(expression: string): CatalogBillingDetails {
    if (/\bcc(?:1h)?\b/.test(expression)) throw new Error('图片表达式包含不支持的缓存写入项');
    // Reuse the bounded, exact-decimal grammar. These aliases are only a parsing projection;
    // no expression is executed or written back to new-api.
    const projected = expression.replace(/\bimg_cr\b/g, 'cc1h').replace(/\bimg\b/g, 'cc');
    const parsed = parseTieredPricingExpression(projected);
    if (parsed.tiers.length !== 1) throw new Error('图片表达式暂不支持分档');
    const values = parsed.tiers[0].rates;
    return parseCatalogBillingDetails({
        version: 1,
        mode: 'component_token',
        unit: 'cny_per_million_tokens',
        rates: {
            input: values.input,
            output: values.output,
            cache_read: values.cache_read,
            image_input: values.cache_write,
            image_cache_read: values.cache_write_1h,
        },
    })!;
}

export function advancedSyncPrice(raw: RawSyncPrices, model: string, groupRatio: number): SyncPriceResult | null {
    try {
        const mode = own(syncDictionary(raw.billingMode, 'billing_mode'), model);
        const image = own(syncDictionary(raw.imageResolutionPrice, 'ImageResolutionPrice'), model);
        const task = own(syncDictionary(raw.taskBillingPricing, 'task_billing_pricing'), model);
        const discount = own(syncDictionary(raw.scheduledDiscount, 'scheduled_discount'), model);
        const plugins = syncDictionary(raw.pluginBillingExpr, 'plugin_billing_expr');
        if (Object.keys(plugins).some((key) => key.endsWith(`::${model}`)))
            throw new Error('模型配置了渠道专属表达式，目录暂不能表示多个不同计费规则');
        if (
            mode !== undefined &&
            !['ratio', 'tiered_expr', 'image_resolution', 'per-second', 'per-request'].includes(String(mode))
        )
            throw new Error(`暂不支持的计费方式：${String(mode)}`);
        let details: CatalogBillingDetails;
        let basis: SyncPriceResult['basis'];
        if (mode === 'tiered_expr') {
            const expression = own(syncDictionary(raw.billingExpr, 'billing_expr'), model);
            if (typeof expression !== 'string' || !expression.trim()) throw new Error('阶梯计费表达式缺失');
            if (/\bimg(?:_cr)?\b/.test(expression)) details = componentExpression(expression);
            else
                details = parseCatalogBillingDetails({
                    version: 1,
                    mode: 'tiered_token',
                    unit: 'cny_per_million_tokens',
                    semantics: 'whole_request',
                    tiers: parseTieredPricingExpression(expression).tiers,
                })!;
            basis = 'token';
        } else if (image !== undefined || mode === 'image_resolution') {
            const prices = syncDictionary(image ?? null, 'ImageResolutionPrice');
            if (
                !['1K', '2K', '4K'].every((key) => Object.hasOwn(prices, key)) ||
                Object.keys(prices).some((key) => !['1K', '2K', '4K'].includes(key))
            )
                throw new Error('图片分辨率价格必须包含 1K、2K、4K');
            details = parseCatalogBillingDetails({
                version: 1,
                mode: 'media',
                unit: 'cny_per_image',
                default_price: null,
                resolution_prices: prices,
            })!;
            basis = 'request';
        } else if (task !== undefined || mode === 'per-second' || mode === 'per-request') {
            const config = task === undefined ? null : syncDictionary(task, 'task_billing_pricing');
            const taskMode = config?.mode ?? mode;
            if (!['per-second', 'per-request'].includes(String(taskMode))) throw new Error('视频计费单位缺失');
            if (config && mode !== undefined && mode !== 'ratio' && mode !== taskMode)
                throw new Error('视频计费单位与价格配置不一致');
            const prices = syncDictionary(raw.modelPrice, 'ModelPrice');
            const defaultPrice = config ? (config.default_price ?? null) : (own(prices, model) ?? null);
            details = parseCatalogBillingDetails({
                version: 1,
                mode: 'media',
                unit: taskMode === 'per-second' ? 'cny_per_second' : 'cny_per_request',
                default_price: defaultPrice,
                resolution_prices: config?.resolution_prices ?? {},
            })!;
            basis = taskMode === 'per-second' ? 'second' : 'request';
        } else {
            if (discount && typeof discount === 'object' && 'enabled' in discount && discount.enabled === true)
                throw new Error('此计费方式的限时折扣暂不能同步');
            return null;
        }
        if (discount !== undefined) {
            const d = syncDictionary(discount, 'scheduled_discount');
            if (typeof d.enabled !== 'boolean') throw new Error('限时折扣配置无效');
            if (d.enabled) {
                if (details.mode !== 'media') throw new Error('此计费方式的限时折扣暂不能同步');
                details = parseCatalogBillingDetails({
                    ...details,
                    scheduled_discount: {
                        start: d.start,
                        end: d.end,
                        timezone: 'Asia/Shanghai',
                        multiplier: d.discount,
                    },
                })!;
            }
        }
        if (!Number.isFinite(IMAGE_FX) || IMAGE_FX <= 0) throw new Error('价格换算配置无效');
        details = scaleCatalogBillingDetails(details, groupRatio * IMAGE_FX);
        const input = details.mode === 'tiered_token' ? Number(details.tiers[0].rates.input.toFixed(4)) : null;
        const output = details.mode === 'tiered_token' ? Number(details.tiers[0].rates.output.toFixed(4)) : null;
        if (
            details.mode === 'tiered_token' &&
            [input!, output!].some(
                (value, i) =>
                    value > 99_999_999.9999 || (value === 0 && details.tiers[0].rates[i ? 'output' : 'input'] > 0),
            )
        )
            throw new Error('阶梯首档价格超出目录范围或精度');
        return {
            basis,
            reason: null,
            price: {
                input_cny_per_1m: input,
                output_cny_per_1m: output,
                per_image_cny: null,
                billing_details: details,
            },
        };
    } catch (error) {
        // No partial interpretation, expression evaluation, or fallback to obsolete scalar options.
        return {
            basis: null,
            price: null,
            reason: error instanceof Error ? `计费规则无法同步：${error.message}` : '计费规则无法同步',
        };
    }
}

export function syncModelModality(raw: RawSyncPrices, model: string, fallback: string): string {
    try {
        if (Object.hasOwn(syncDictionary(raw.imageResolutionPrice, 'ImageResolutionPrice'), model)) return 'image';
        if (Object.hasOwn(syncDictionary(raw.taskBillingPricing, 'task_billing_pricing'), model)) return 'video';
        const mode = own(syncDictionary(raw.billingMode, 'billing_mode'), model);
        if (mode === 'per-second' || /^video-|^wan-/i.test(model)) return 'video';
    } catch {
        /* The price reader reports invalid metadata and prevents publication. */
    }
    return fallback;
}
