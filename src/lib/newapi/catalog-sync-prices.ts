import 'server-only';
import { CHAT_FX, IMAGE_FX, retailFromRatios } from './pricing-sync';
import { advancedSyncPrice, syncDictionary } from './catalog-sync-advanced';
import {
    parseCatalogBillingDetails,
    scaleCatalogBillingDetails,
    type CatalogBillingDetails,
} from '@/lib/models/catalog-pricing-details';

/** Global new-api options, read once by the caller. Never use channel.model_ratio here. */
export interface RawSyncPrices {
    modelRatio: unknown;
    completionRatio: unknown;
    modelPrice: unknown;
    groupRatio: unknown;
    billingMode?: unknown;
    billingExpr?: unknown;
    imageResolutionPrice?: unknown;
    taskBillingPricing?: unknown;
    scheduledDiscount?: unknown;
    pluginBillingExpr?: unknown;
    cacheRatio?: unknown;
    createCacheRatio?: unknown;
}

export function syncPricesFromOptions(options: Record<string, unknown>): RawSyncPrices {
    return {
        modelRatio: options.ModelRatio,
        completionRatio: options.CompletionRatio,
        modelPrice: options.ModelPrice,
        groupRatio: options.GroupRatio,
        billingMode: options['billing_setting.billing_mode'],
        billingExpr: options['billing_setting.billing_expr'],
        imageResolutionPrice: options.ImageResolutionPrice,
        taskBillingPricing: options['billing_setting.task_billing_pricing'],
        scheduledDiscount: options['billing_setting.scheduled_discount'],
        pluginBillingExpr: options['billing_setting.plugin_billing_expr'],
        cacheRatio: options.CacheRatio,
        createCacheRatio: options.CreateCacheRatio,
    };
}

export interface SyncRetailPrice {
    input_cny_per_1m: number | null;
    output_cny_per_1m: number | null;
    /** Existing catalog column for fixed request prices; basis determines the displayed unit. */
    per_image_cny: number | null;
    billing_details?: CatalogBillingDetails | null;
}

export interface SyncPriceResult {
    price: SyncRetailPrice | null;
    reason: string | null;
    basis: 'token' | 'request' | 'second' | null;
}

type ParsedDictionary = { dictionary: Record<string, unknown>; reason: null } | { dictionary: null; reason: string };
type ParsedNumber = { value: number; reason: null } | { value: null; reason: string };

function parseDictionary(raw: unknown, option: string): ParsedDictionary {
    if (raw == null || raw === '') return { dictionary: null, reason: `未读取到 new-api ${option} 配置` };
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            return { dictionary: null, reason: `new-api ${option} 不是有效的 JSON 对象` };
        }
    }
    if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        (Object.getPrototypeOf(parsed) !== Object.prototype && Object.getPrototypeOf(parsed) !== null)
    ) {
        return { dictionary: null, reason: `new-api ${option} 不是有效的配置对象` };
    }
    return { dictionary: parsed as Record<string, unknown>, reason: null };
}

function readNumber(dictionary: Record<string, unknown>, key: string, option: string): ParsedNumber {
    if (!Object.hasOwn(dictionary, key)) return { value: null, reason: `new-api ${option} 缺少「${key}」` };
    const value = dictionary[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return { value: null, reason: `new-api ${option}「${key}」必须是非负有限数字` };
    }
    return { value, reason: null };
}

function unavailable(reason: string, basis: SyncPriceResult['basis'] = null): SyncPriceResult {
    return { price: null, reason, basis };
}

// CatalogPrice uses Decimal(12, 4). Reject overflow and positive prices rounded to free.
function validCatalogAmount(amount: number, positiveBeforeRounding: boolean): boolean {
    return (
        Number.isFinite(amount) && amount >= 0 && amount <= 99_999_999.9999 && (!positiveBeforeRounding || amount > 0)
    );
}

/**
 * Read standard retail prices for the exact model and new-api group, without I/O or mutations.
 * An explicit ModelPrice takes precedence over token ratios, including zero. Otherwise both
 * ModelRatio and CompletionRatio are required; missing values never imply a free price or 1x.
 * Model names do not determine the billing basis: token-priced image models stay token-priced.
 * User-specific GroupGroupRatio adjustments are intentionally outside the standard catalog.
 */
export function readSyncPrice(raw: RawSyncPrices, model: string, group: string): SyncPriceResult {
    if (!model.trim()) return unavailable('缺少 new-api 模型名');
    if (!group.trim()) return unavailable('缺少 new-api 分组名');

    // A failed ModelPrice read cannot safely be treated as an absent per-request price.
    const modelPrices = parseDictionary(raw.modelPrice, 'ModelPrice');
    if (modelPrices.dictionary === null) return unavailable(modelPrices.reason);
    const basis = Object.hasOwn(modelPrices.dictionary, model) ? 'request' : 'token';

    const groupRatios = parseDictionary(raw.groupRatio, 'GroupRatio');
    if (groupRatios.dictionary === null) return unavailable(groupRatios.reason, basis);
    const groupRatio = readNumber(groupRatios.dictionary, group, 'GroupRatio');
    if (groupRatio.value === null) return unavailable(groupRatio.reason, basis);

    const advanced = advancedSyncPrice(raw, model, groupRatio.value);
    if (advanced) return advanced;

    if (basis === 'request') {
        const modelPrice = readNumber(modelPrices.dictionary, model, 'ModelPrice');
        if (modelPrice.value === null) return unavailable(modelPrice.reason, basis);
        if (!Number.isFinite(IMAGE_FX) || IMAGE_FX <= 0) return unavailable('按次价格换算配置无效', basis);
        const amount = Number((modelPrice.value * IMAGE_FX * groupRatio.value).toFixed(4));
        if (!validCatalogAmount(amount, modelPrice.value > 0 && groupRatio.value > 0)) {
            return unavailable('按次价格超出目录可保存的范围或精度', basis);
        }
        return {
            price: { input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: amount },
            reason: null,
            basis,
        };
    }

    const modelRatios = parseDictionary(raw.modelRatio, 'ModelRatio');
    if (modelRatios.dictionary === null) return unavailable(modelRatios.reason, basis);
    const completionRatios = parseDictionary(raw.completionRatio, 'CompletionRatio');
    if (completionRatios.dictionary === null) return unavailable(completionRatios.reason, basis);
    const modelRatio = readNumber(modelRatios.dictionary, model, 'ModelRatio');
    if (modelRatio.value === null) return unavailable(modelRatio.reason, basis);
    const completionRatio = readNumber(completionRatios.dictionary, model, 'CompletionRatio');
    if (completionRatio.value === null) return unavailable(completionRatio.reason, basis);
    if (!Number.isFinite(CHAT_FX) || CHAT_FX <= 0) return unavailable('Token 价格换算配置无效', basis);

    const price = retailFromRatios(modelRatio.value, completionRatio.value, groupRatio.value);
    const positiveInput = modelRatio.value > 0 && groupRatio.value > 0;
    if (
        !validCatalogAmount(price.input_cny_per_1m, positiveInput) ||
        !validCatalogAmount(price.output_cny_per_1m, positiveInput && completionRatio.value > 0)
    ) {
        return unavailable('Token 价格超出目录可保存的范围或精度', basis);
    }
    try {
        const cache = syncDictionary(raw.cacheRatio, 'CacheRatio');
        const create = syncDictionary(raw.createCacheRatio, 'CreateCacheRatio');
        const optionalRate = (values: Record<string, unknown>): number | null => {
            if (!Object.hasOwn(values, model)) return null;
            const value = readNumber(values, model, 'CacheRatio/CreateCacheRatio');
            if (value.value === null) throw new Error(value.reason);
            return modelRatio.value! * CHAT_FX * value.value;
        };
        const cacheRead = optionalRate(cache),
            cacheWrite = optionalRate(create);
        const details =
            cacheRead === null && cacheWrite === null
                ? null
                : scaleCatalogBillingDetails(
                      parseCatalogBillingDetails({
                          version: 1,
                          mode: 'tiered_token',
                          unit: 'cny_per_million_tokens',
                          semantics: 'whole_request',
                          tiers: [
                              {
                                  name: 'uniform',
                                  min_input_tokens: null,
                                  max_input_tokens: null,
                                  min_inclusive: false,
                                  max_inclusive: false,
                                  rates: {
                                      input: modelRatio.value * CHAT_FX,
                                      output: modelRatio.value * CHAT_FX * completionRatio.value,
                                      cache_read: cacheRead,
                                      cache_write: cacheWrite,
                                      cache_write_1h: null,
                                  },
                              },
                          ],
                      })!,
                      groupRatio.value,
                  );
        return {
            price: { ...price, per_image_cny: null, ...(details ? { billing_details: details } : {}) },
            reason: null,
            basis,
        };
    } catch {
        return unavailable('缓存计费价格无效或超出目录精度', basis);
    }
}
