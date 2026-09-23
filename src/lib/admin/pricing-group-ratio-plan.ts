import 'server-only';
import { CHAT_FX, IMAGE_FX } from '@/lib/newapi/pricing-sync';
import type { NewApiRuntimePricing, NewApiRuntimePricingModel } from '@/lib/newapi/client';
import { PricingPublishError } from './pricing-publish-lock';
import { dictionary, fingerprint, sourceGuard, type PublishSource, type PublishState } from './pricing-publish-plan';
import {
    EXPRESSION_KEY,
    TIERED_PRICE_KEYS,
    tieredDetails,
    tieredPriceOptions,
    type TieredPriceOptions,
} from './pricing-tiered-plan';
import type {
    PricingPublishInput,
    PricingPublishPreview,
    PricingPublishPreviewRow,
    TieredPricingDetails,
} from './pricing-publish-types';

/**
 * A group change is deliberately a very small publication intent. The only
 * remote value this plan can write is GroupRatio; model base ratios and billing
 * expressions remain the global model configuration.
 */
export interface GroupRatioPublishPlan {
    version: 7;
    strategy: 'group_ratio';
    inputs: PricingPublishInput[];
    upstream_model: string;
    upstream_models: Array<{ name: string; basis: 'token' | 'request' }>;
    tenant_id: string | null;
    basis: 'token' | 'request';
    rows: Array<PricingPublishPreviewRow & { cost_cny_per_1m: number | null }>;
    warnings: string[];
    baseline: TieredPriceOptions;
    target: { GroupRatio: Record<string, number> };
    source_guard: string;
    catalog_guard: string;
    units: { chat_fx: number; image_fx: number; quota_per_usd: number };
    runtime_baseline: NewApiRuntimePricing;
    unchanged: boolean;
    customer_overrides: NonNullable<PricingPublishPreview['customer_overrides']>;
    customer_request_overrides: NonNullable<PricingPublishPreview['customer_request_overrides']>;
    group: { id: string; key: string; newapi_group: string; target_ratio: number };
}

function fail(code: string, message: string): never {
    throw new PricingPublishError(code, message);
}

function ratioDetails(model: NewApiRuntimePricingModel, ratio: number): TieredPricingDetails {
    const input = Number((model.model_ratio * CHAT_FX * ratio).toFixed(12));
    const precision = (value: number) => Number(value.toFixed(12));
    return {
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
                    input,
                    output: precision(input * model.completion_ratio),
                    cache_read: model.cache_ratio === undefined ? null : precision(input * model.cache_ratio),
                    cache_write:
                        model.create_cache_ratio === undefined ? null : precision(input * model.create_cache_ratio),
                    cache_write_1h: null,
                },
            },
        ],
    };
}

function latestPrice(state: PublishState, modelId: string, tier: string) {
    return state.prices
        .filter((price) => price.model_id === modelId && price.tier === tier)
        .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.id.localeCompare(a.id))[0];
}

function mappingFor(model: PublishState['models'][number], tier: string) {
    const map = dictionary(model.upstream_map, '模型渠道映射');
    const entry = dictionary(map[tier], '档次映射');
    if (typeof entry.upstream_model !== 'string' || !entry.upstream_model.trim())
        fail('pricing_mapping_invalid', '模型渠道映射不完整，请先更新模型目录。');
    return entry.upstream_model;
}

function groupGuard(source: PublishSource) {
    return fingerprint({
        source: sourceGuard(source),
        cache: ['CacheRatio', 'CreateCacheRatio'].map((key) => [
            key,
            Object.hasOwn(source.options, key),
            Object.hasOwn(source.options, key) ? dictionary(source.options[key], key) : null,
        ]),
    });
}

/** Build a GroupRatio-only intent from every currently routable model in one tier. */
export function buildGroupRatioPublishPlan(
    state: PublishState,
    source: PublishSource,
    groupId: string,
    targetRatio: number,
    now: number,
    runtime: NewApiRuntimePricing,
    units: { chat_fx: number; image_fx: number; quota_per_usd: number },
): GroupRatioPublishPlan {
    if (!Number.isFinite(targetRatio) || targetRatio <= 0 || targetRatio > 10_000)
        fail('pricing_group_ratio_invalid', '档次倍率必须是大于 0 的有限数字。');
    const group = state.groups.find((row) => row.id === groupId);
    if (!group || !group.enabled) fail('pricing_group_not_found', '档次不存在或已停用。');
    const liveChannels = source.channels.filter(
        (channel) => channel.status === 1 && channel.groups.includes(group.newapi_group),
    );
    if (!liveChannels.length || liveChannels.some((channel) => !group.newapi_channel_ids.includes(channel.id)))
        fail('pricing_group_mapping', '该档次的启用渠道尚未完整登记，请先同步渠道归属。');
    const names = [...new Set(liveChannels.flatMap((channel) => channel.models))].sort();
    if (!names.length || names.length > 30) fail('pricing_group_size', '该档次没有可用模型或超过 30 个模型。');
    const models = names.map((name) => {
        const matches = state.models.filter((model) => {
            if (!model.enabled || model.tenant_id !== group.tenant_id) return false;
            try {
                return mappingFor(model, group.key) === name;
            } catch {
                return false;
            }
        });
        if (matches.length !== 1) fail('pricing_group_selection', `${name} 在该档次没有唯一的 Portal 模型映射。`);
        return { name, model: matches[0] };
    });
    const baseline = tieredPriceOptions(source.options);
    const oldRatio = baseline.GroupRatio[group.newapi_group];
    if (typeof oldRatio !== 'number' || !Number.isFinite(oldRatio) || oldRatio <= 0)
        fail('pricing_group_ratio_invalid', '当前档次倍率缺失或无效，请先核对 new-api。');
    const modes = dictionary(source.options['billing_setting.billing_mode'], 'billing_setting.billing_mode');
    const rows: GroupRatioPublishPlan['rows'] = [];
    const inputs: PricingPublishInput[] = [];
    const upstreamModels: GroupRatioPublishPlan['upstream_models'] = [];
    let firstBasis: 'token' | 'request' = 'token';
    for (const { name, model } of models) {
        const running = runtime.models.find((item) => item.model_name === name);
        if (!running) fail('pricing_runtime_missing', `未读到 ${name} 的实际计费，请刷新后重试。`);
        if (!running.enable_groups.includes(group.newapi_group))
            fail('pricing_group_mapping', `${name} 尚未在该 new-api 档次启用。`);
        const mode = modes[name];
        const basis: 'token' | 'request' = mode === 'tiered_expr' || running.quota_type === 0 ? 'token' : 'request';
        if (upstreamModels.length === 0) firstBasis = basis;
        upstreamModels.push({ name, basis });
        const beforePrice = latestPrice(state, model.id, group.key);
        const isExpression = mode === 'tiered_expr';
        let before: PricingPublishPreviewRow['before'];
        let after: PricingPublishPreviewRow['after'];
        let beforeDetails: TieredPricingDetails | undefined;
        let afterDetails: TieredPricingDetails | undefined;
        if (isExpression) {
            const expr = baseline[EXPRESSION_KEY][name];
            if (typeof expr !== 'string') fail('pricing_options_invalid', `${name} 缺少阶梯计费公式。`);
            beforeDetails = tieredDetails(expr, oldRatio);
            afterDetails = tieredDetails(expr, targetRatio);
            const oldRates = beforeDetails.tiers[0].rates;
            const rates = afterDetails.tiers[0].rates;
            before = {
                input_cny_per_1m: Number(oldRates.input.toFixed(4)),
                output_cny_per_1m: Number(oldRates.output.toFixed(4)),
                per_image_cny: null,
            };
            after = {
                input_cny_per_1m: Number(rates.input.toFixed(4)),
                output_cny_per_1m: Number(rates.output.toFixed(4)),
                per_image_cny: null,
            };
        } else if (basis === 'request') {
            const modelPrice = baseline.ModelPrice[name];
            if (typeof modelPrice !== 'number') fail('pricing_options_invalid', `${name} 缺少按次基础价。`);
            before = {
                input_cny_per_1m: null,
                output_cny_per_1m: null,
                per_image_cny: Number((modelPrice * IMAGE_FX * oldRatio).toFixed(4)),
            };
            after = {
                input_cny_per_1m: null,
                output_cny_per_1m: null,
                per_image_cny: Number((modelPrice * IMAGE_FX * targetRatio).toFixed(4)),
            };
        } else {
            beforeDetails = ratioDetails(running, oldRatio);
            afterDetails = ratioDetails(running, targetRatio);
            const oldRates = beforeDetails.tiers[0].rates;
            const rates = afterDetails.tiers[0].rates;
            before = {
                input_cny_per_1m: Number(oldRates.input.toFixed(4)),
                output_cny_per_1m: Number(oldRates.output.toFixed(4)),
                per_image_cny: null,
            };
            after = {
                input_cny_per_1m: Number(rates.input.toFixed(4)),
                output_cny_per_1m: Number(rates.output.toFixed(4)),
                per_image_cny: null,
            };
        }
        const input: PricingPublishInput = {
            model_id: model.id,
            tier: group.key,
            ...after,
            cost_cny_per_1m: beforePrice?.cost_cny_per_1m ?? null,
            ...(afterDetails?.tiers[0].rates.cache_read === null
                ? {}
                : { cache_read_cny_per_1m: afterDetails?.tiers[0].rates.cache_read }),
            ...(afterDetails?.tiers[0].rates.cache_write === null
                ? {}
                : { cache_write_cny_per_1m: afterDetails?.tiers[0].rates.cache_write }),
            ...(afterDetails?.tiers[0].rates.cache_write_1h === null
                ? {}
                : { cache_write_1h_cny_per_1m: afterDetails?.tiers[0].rates.cache_write_1h }),
        };
        inputs.push(input);
        rows.push({
            model_id: model.id,
            model_name: model.display_name,
            tier: group.key,
            group: group.newapi_group,
            before,
            after,
            cost_cny_per_1m: input.cost_cny_per_1m,
            ...(beforeDetails ? { before_details: beforeDetails, after_details: afterDetails } : {}),
        });
    }
    const target = { GroupRatio: { [group.newapi_group]: targetRatio } };
    const plan: GroupRatioPublishPlan = {
        version: 7,
        strategy: 'group_ratio',
        inputs,
        upstream_model: upstreamModels.map((model) => model.name).join(', '),
        upstream_models: upstreamModels,
        tenant_id: group.tenant_id,
        basis: firstBasis,
        rows,
        warnings: [
            '本次只更新所选档次的 GroupRatio；模型官方基础价、ModelRatio、CompletionRatio 和计费公式保持不变。',
            '该倍率会影响此档次下全部已启用模型，其他档次不变。',
            ...(targetRatio === oldRatio ? ['当前档次倍率已经是目标值；确认后只核验并更新 Portal 目录。'] : []),
        ],
        baseline,
        target,
        source_guard: groupGuard(source),
        catalog_guard: fingerprint(state),
        units,
        runtime_baseline: runtime,
        unchanged: targetRatio === oldRatio,
        customer_overrides: [],
        customer_request_overrides: [],
        group: { id: group.id, key: group.key, newapi_group: group.newapi_group, target_ratio: targetRatio },
    };
    return plan;
}

export function assertRecoverableGroupRatioOptions(current: TieredPriceOptions, plan: GroupRatioPublishPlan) {
    for (const key of TIERED_PRICE_KEYS) {
        const expected = { ...plan.baseline[key] };
        if (key === 'GroupRatio') {
            const group = plan.group.newapi_group;
            const before = plan.baseline.GroupRatio[group];
            const target = plan.group.target_ratio;
            const observed = current.GroupRatio[group];
            if (observed !== before && observed !== target)
                fail('pricing_conflict', 'new-api 分组倍率已被其他操作修改。');
            expected[group] = observed;
        }
        // Only the selected GroupRatio entry may be either its signed old
        // value or target. All other groups, model prices and expressions
        // remain exactly at the signed baseline.
        if (fingerprint(expected) !== fingerprint(current[key]))
            fail('pricing_conflict', 'new-api 分组或其他价格配置已变化。');
    }
}

export function assertGroupRatioRuntime(runtime: NewApiRuntimePricing, plan: GroupRatioPublishPlan, target: boolean) {
    const ratio = target ? plan.group.target_ratio : plan.baseline.GroupRatio[plan.group.newapi_group];
    if (runtime.group_ratio[plan.group.newapi_group] !== ratio)
        throw new Error('Group runtime ratio has not converged');
    for (const { name } of plan.upstream_models) {
        const current = runtime.models.find((model) => model.model_name === name);
        const old = plan.runtime_baseline.models.find((model) => model.model_name === name);
        if (!current || !old || !current.enable_groups.includes(plan.group.newapi_group))
            throw new Error('Group runtime model has not converged');
        if (
            current.model_ratio !== old.model_ratio ||
            current.completion_ratio !== old.completion_ratio ||
            current.model_price !== old.model_price ||
            current.billing_expr !== old.billing_expr
        )
            throw new Error('Global model pricing changed during group update');
    }
}
