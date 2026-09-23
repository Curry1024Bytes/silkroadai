import 'server-only';
import { CHAT_FX, IMAGE_FX, computeRatios } from '@/lib/newapi/pricing-sync';
import { readSyncPrice } from '@/lib/newapi/catalog-sync-prices';
import {
    buildPublishPlan,
    dictionary,
    priceOptions,
    type PublishSource,
    type PublishState,
    type PublishBatchPlan,
} from './pricing-publish-plan';
import { buildCacheUniformPublishPlan, type CacheUniformPublishPlan } from './pricing-uniform-plan';
import { tieredDetails, EXPRESSION_KEY, tieredPriceOptions } from './pricing-tiered-plan';
import { PricingPublishError } from './pricing-publish-lock';
import {
    globalModelBaseInputSchema,
    type GlobalModelBaseInput,
    type GlobalModelPriceInfo,
} from './global-model-pricing-types';

export type GlobalModelPublishPlan = PublishBatchPlan | CacheUniformPublishPlan;

function activeMappings(state: PublishState, modelId: string) {
    const model = state.models.find((row) => row.id === modelId);
    if (!model) throw new PricingPublishError('model_not_found', '模型不存在。', 404);
    if (!model.enabled) throw new PricingPublishError('model_disabled', '模型已停用，不能发布全局基础价。', 409);
    const raw = dictionary(model.upstream_map, '模型渠道映射');
    const mappings = Object.entries(raw)
        .map(([tier, value]) => {
            if (!value || typeof value !== 'object' || Array.isArray(value))
                throw new PricingPublishError('pricing_mapping_invalid', '模型渠道映射不完整，请先修正模型配置。');
            const entry = value as { upstream_model?: unknown; channel_id?: unknown };
            if (typeof entry.upstream_model !== 'string' || !entry.upstream_model.trim())
                throw new PricingPublishError('pricing_mapping_invalid', '模型渠道映射缺少上游模型名。');
            if (!Number.isSafeInteger(entry.channel_id) || Number(entry.channel_id) <= 0)
                throw new PricingPublishError('pricing_mapping_invalid', '模型渠道映射缺少有效渠道。');
            const group = state.groups.find(
                (row) => row.tenant_id === model.tenant_id && row.key === tier && row.enabled,
            );
            if (!group) throw new PricingPublishError('pricing_tier_invalid', `档次「${tier}」未启用或未登记。`);
            return { tier, upstream_model: entry.upstream_model, channel_id: Number(entry.channel_id), group };
        })
        .sort((a, b) => a.tier.localeCompare(b.tier));
    if (!mappings.length) throw new PricingPublishError('pricing_mapping_invalid', '模型尚未登记任何启用档次。');
    const names = new Set(mappings.map((mapping) => mapping.upstream_model));
    if (names.size !== 1)
        throw new PricingPublishError(
            'pricing_global_ambiguous',
            '同一模型的启用档次映射到了多个上游模型，不能发布一个全局基础价；请先统一上游映射。',
        );
    return { model, mappings, upstream_model: mappings[0].upstream_model };
}

function infoForModel(state: PublishState, source: PublishSource, modelId: string): GlobalModelPriceInfo {
    const { model, upstream_model } = activeMappings(state, modelId);
    const options = priceOptions(source.options);
    const modes = dictionary(source.options['billing_setting.billing_mode'], 'billing_setting.billing_mode');
    const mode = modes[upstream_model];
    const display = {
        id: model.id,
        slug: model.slug,
        display_name: model.display_name,
        modality: model.modality,
        upstream_model,
    };
    if (mode === 'tiered_expr') {
        const expression = tieredPriceOptions(source.options)[EXPRESSION_KEY][upstream_model];
        if (typeof expression !== 'string')
            throw new PricingPublishError('pricing_tiered_invalid', '未读到模型的阶梯公式。');
        const details = tieredDetails(expression, 1);
        const rates = details.tiers[0].rates;
        const firstDefined = (key: 'cache_read' | 'cache_write' | 'cache_write_1h') =>
            details.tiers.find((tier) => tier.rates[key] !== null)?.rates[key] ?? null;
        return {
            ...display,
            billing_mode: 'tiered_expr',
            base_input_cny_per_1m: rates.input,
            base_output_cny_per_1m: rates.output,
            base_per_image_cny: null,
            base_cache_read_cny_per_1m: firstDefined('cache_read'),
            base_cache_write_cny_per_1m: firstDefined('cache_write'),
            base_cache_write_1h_cny_per_1m: firstDefined('cache_write_1h'),
        };
    }
    const modelPrice = options.ModelPrice[upstream_model];
    if (typeof modelPrice === 'number' && Number.isFinite(modelPrice)) {
        return {
            ...display,
            billing_mode: 'request',
            base_input_cny_per_1m: null,
            base_output_cny_per_1m: null,
            base_per_image_cny: modelPrice * IMAGE_FX,
            base_cache_read_cny_per_1m: null,
            base_cache_write_cny_per_1m: null,
            base_cache_write_1h_cny_per_1m: null,
        };
    }
    const inputRatio = options.ModelRatio[upstream_model];
    const outputRatio = options.CompletionRatio[upstream_model];
    if (typeof inputRatio !== 'number' || typeof outputRatio !== 'number')
        throw new PricingPublishError('pricing_global_missing', '模型的全局基础倍率尚未配置。');
    return {
        ...display,
        billing_mode: 'standard',
        base_input_cny_per_1m: inputRatio * CHAT_FX,
        base_output_cny_per_1m: inputRatio * CHAT_FX * outputRatio,
        base_per_image_cny: null,
        base_cache_read_cny_per_1m: null,
        base_cache_write_cny_per_1m: null,
        base_cache_write_1h_cny_per_1m: null,
    };
}

export function listGlobalModelPrices(state: PublishState, source: PublishSource, tenantId: string | null) {
    return state.models
        .filter((model) => model.tenant_id === tenantId && model.enabled)
        .map((model) => infoForModel(state, source, model.id))
        .sort((a, b) => a.display_name.localeCompare(b.display_name));
}

export function globalModelPriceInfo(state: PublishState, source: PublishSource, modelId: string) {
    return infoForModel(state, source, modelId);
}

/** Build one signed publication from the model's official base price. Every
 * active tier is derived from GroupRatio; no tier ratio or cost input is changed. */
export function buildGlobalModelPlan(
    state: PublishState,
    source: PublishSource,
    rawInput: GlobalModelBaseInput,
    now: number,
): GlobalModelPublishPlan {
    const input = globalModelBaseInputSchema.parse(rawInput);
    const { mappings, upstream_model } = activeMappings(state, input.model_id);
    const info = infoForModel(state, source, input.model_id);
    if (info.upstream_model !== upstream_model)
        throw new PricingPublishError('pricing_global_ambiguous', '模型上游映射已变化，请刷新后重试。');
    const ratios = priceOptions(source.options).GroupRatio;
    if (info.billing_mode === 'tiered_expr') {
        const first = mappings[0];
        const groupRatio = ratios[first.group.newapi_group];
        if (typeof groupRatio !== 'number' || !Number.isFinite(groupRatio) || groupRatio <= 0)
            throw new PricingPublishError('pricing_group_invalid', '关联档次的分组倍率缺失或无效。');
        const values = {
            input_cny_per_1m: input.base_input_cny_per_1m,
            output_cny_per_1m: input.base_output_cny_per_1m,
            per_image_cny: null,
            cost_cny_per_1m: null,
            ...(input.base_cache_read_cny_per_1m === undefined
                ? {}
                : { cache_read_cny_per_1m: input.base_cache_read_cny_per_1m }),
            ...(input.base_cache_write_cny_per_1m === undefined
                ? {}
                : { cache_write_cny_per_1m: input.base_cache_write_cny_per_1m }),
            ...(input.base_cache_write_1h_cny_per_1m === undefined
                ? {}
                : { cache_write_1h_cny_per_1m: input.base_cache_write_1h_cny_per_1m }),
        } as const;
        if (values.input_cny_per_1m === null || values.output_cny_per_1m === null)
            throw new PricingPublishError('pricing_global_missing', '阶梯模型需要完整的输入与输出官方基础价。');
        const plan = buildCacheUniformPublishPlan(
            state,
            source,
            [
                {
                    model_id: input.model_id,
                    tier: first.tier,
                    input_cny_per_1m: Number((values.input_cny_per_1m * groupRatio).toFixed(4)),
                    output_cny_per_1m: Number((values.output_cny_per_1m * groupRatio).toFixed(4)),
                    per_image_cny: null,
                    cost_cny_per_1m: null,
                    ...(values.cache_read_cny_per_1m === undefined
                        ? {}
                        : { cache_read_cny_per_1m: Number((values.cache_read_cny_per_1m * groupRatio).toFixed(12)) }),
                    ...(values.cache_write_cny_per_1m === undefined
                        ? {}
                        : { cache_write_cny_per_1m: Number((values.cache_write_cny_per_1m * groupRatio).toFixed(12)) }),
                    ...(values.cache_write_1h_cny_per_1m === undefined
                        ? {}
                        : {
                              cache_write_1h_cny_per_1m: Number(
                                  (values.cache_write_1h_cny_per_1m * groupRatio).toFixed(12),
                              ),
                          }),
                },
            ],
            now,
            undefined,
            input,
        );
        return {
            ...plan,
            global_model: true,
            global_input: input,
            warnings: [
                '这是模型级官方全局基础价，发布后会影响该模型所有已登记档次。',
                '各档次最终价格仅由 new-api 的 GroupRatio 推导，本次不会修改任何分组倍率或成本参数。',
                '发布将把现有按上下文长度分档的计费公式改为统一单价，原有长度阶梯会被移除。',
                ...plan.warnings,
            ],
        };
    }
    const first = mappings[0];
    const groupRatio = ratios[first.group.newapi_group];
    if (typeof groupRatio !== 'number' || !Number.isFinite(groupRatio) || groupRatio <= 0)
        throw new PricingPublishError('pricing_group_invalid', `档次「${first.tier}」的分组倍率缺失或无效。`);
    const target: PublishBatchPlan['target'] = {};
    let selectedInput: PublishBatchPlan['inputs'][number];
    if (info.billing_mode === 'request') {
        if (input.base_per_image_cny === null)
            throw new PricingPublishError('pricing_global_missing', '按次模型需要填写官方按次基础价。');
        const modelPrice = Number((input.base_per_image_cny! / IMAGE_FX).toFixed(6));
        if (input.base_per_image_cny! > 0 && modelPrice === 0)
            throw new PricingPublishError('pricing_precision', '按次基础价太小，换算后会变为免费。');
        target.ModelPrice = { [upstream_model]: modelPrice };
        selectedInput = {
            model_id: input.model_id,
            tier: first.tier,
            input_cny_per_1m: null,
            output_cny_per_1m: null,
            per_image_cny: input.base_per_image_cny * groupRatio,
            cost_cny_per_1m: null,
        };
    } else {
        if (input.base_input_cny_per_1m === null || input.base_output_cny_per_1m === null)
            throw new PricingPublishError('pricing_global_missing', 'Token 模型需要填写完整的官方输入与输出基础价。');
        if (
            input.base_cache_read_cny_per_1m !== undefined ||
            input.base_cache_write_cny_per_1m !== undefined ||
            input.base_cache_write_1h_cny_per_1m !== undefined
        )
            throw new PricingPublishError('pricing_global_cache_unsupported', '普通倍率模型不能单独配置缓存基础价。');
        const computed = computeRatios(input.base_input_cny_per_1m!, input.base_output_cny_per_1m!, 1);
        if (computed.model_ratio <= 0 || (input.base_output_cny_per_1m! > 0 && computed.completion_ratio <= 0))
            throw new PricingPublishError('pricing_precision', '官方基础价换算后会变为免费，请调整价格精度。');
        target.ModelRatio = { [upstream_model]: computed.model_ratio };
        target.CompletionRatio = { [upstream_model]: computed.completion_ratio };
        selectedInput = {
            model_id: input.model_id,
            tier: first.tier,
            input_cny_per_1m: input.base_input_cny_per_1m * groupRatio,
            output_cny_per_1m: input.base_output_cny_per_1m * groupRatio,
            per_image_cny: null,
            cost_cny_per_1m: null,
        };
    }
    const current = priceOptions(source.options);
    const next = {
        ...current,
        ...Object.fromEntries(
            Object.entries(target).map(([key, values]) => [
                key,
                { ...current[key as keyof typeof current], ...values },
            ]),
        ),
    };
    const selectedPrice = readSyncPrice(
        {
            modelRatio: next.ModelRatio,
            completionRatio: next.CompletionRatio,
            modelPrice: next.ModelPrice,
            groupRatio: next.GroupRatio,
        },
        upstream_model,
        first.group.newapi_group,
    );
    if (!selectedPrice.price)
        throw new PricingPublishError('pricing_unrepresentable', selectedPrice.reason ?? '无法换算档次价格。');
    selectedInput = { ...selectedInput, ...selectedPrice.price };
    const checked = buildPublishPlan(
        state,
        source,
        selectedInput,
        now,
        Object.fromEntries(Object.entries(target).map(([key, values]) => [key, values[upstream_model]])),
    );
    const rows = checked.rows.map((row) => {
        const calculated = readSyncPrice(
            {
                modelRatio: next.ModelRatio,
                completionRatio: next.CompletionRatio,
                modelPrice: next.ModelPrice,
                groupRatio: next.GroupRatio,
            },
            upstream_model,
            row.group,
        );
        if (!calculated.price)
            throw new PricingPublishError('pricing_unrepresentable', calculated.reason ?? '无法换算档次价格。');
        const current = state.prices
            .filter((price) => price.model_id === row.model_id && price.tier === row.tier)
            .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.id.localeCompare(a.id))[0];
        return { ...row, after: calculated.price, cost_cny_per_1m: current?.cost_cny_per_1m ?? null };
    });
    return {
        ...checked,
        version: 2,
        inputs: [selectedInput],
        upstream_models: [{ name: upstream_model, basis: checked.basis }],
        target,
        rows,
        global_model: true,
        global_input: input,
        warnings: [
            '这是模型级官方全局基础价，发布后会影响该模型所有已登记档次。',
            '各档次最终价格仅由 new-api 的 GroupRatio 推导，本次不会修改任何分组倍率或成本参数。',
            ...checked.warnings,
        ],
    };
}
