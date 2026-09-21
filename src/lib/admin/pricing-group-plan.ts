import 'server-only';
import { CHAT_FX, IMAGE_FX } from '@/lib/newapi/pricing-sync';
import type { NewApiRuntimePricing, NewApiRuntimePricingModel } from '@/lib/newapi/client';
import type { CostBatchContext } from './pricing-cost-publication-guard';
import { PricingPublishError } from './pricing-publish-lock';
import {
    buildPublishPlan,
    dictionary,
    fingerprint,
    sourceGuard,
    type PublishSource,
    type PublishState,
    type PublicationWriteKey,
} from './pricing-publish-plan';
import {
    EXPRESSION_KEY,
    TIERED_PRICE_KEYS,
    tieredDetails,
    tieredModelName,
    tieredPriceOptions,
    type TieredPriceOptions,
} from './pricing-tiered-plan';
import { buildCacheUniformPublishPlan } from './pricing-uniform-plan';
import type {
    PricingPublishInput,
    PricingPublishPreview,
    PricingPublishPreviewRow,
    TieredPricingDetails,
} from './pricing-publish-types';

/** A new signed intent: the selected group owns its multiplier. Legacy V1–V5
 * jobs retain model-global semantics and are never reinterpreted on recovery. */
export interface GroupPublishPlan {
    version: 6;
    strategy: 'group';
    inputs: PricingPublishInput[];
    upstream_model: string;
    upstream_models: Array<{ name: string; basis: 'token' | 'request' }>;
    tenant_id: string | null;
    basis: 'token' | 'request';
    rows: Array<PricingPublishPreviewRow & { cost_cny_per_1m: number | null }>;
    warnings: string[];
    baseline: TieredPriceOptions;
    target: Partial<Record<PublicationWriteKey, Record<string, number | string>>>;
    source_guard: string;
    catalog_guard: string;
    units: { chat_fx: number; image_fx: number; quota_per_usd: number };
    cost_context: CostBatchContext;
    runtime_baseline: NewApiRuntimePricing;
    unchanged: boolean;
    customer_overrides: NonNullable<PricingPublishPreview['customer_overrides']>;
    customer_request_overrides: NonNullable<PricingPublishPreview['customer_request_overrides']>;
}

export function groupSourceGuard(source: PublishSource) {
    return fingerprint({
        source: sourceGuard(source),
        cache: ['CacheRatio', 'CreateCacheRatio'].map((key) => [
            key,
            Object.hasOwn(source.options, key),
            Object.hasOwn(source.options, key) ? dictionary(source.options[key], key) : null,
        ]),
    });
}

function same(a: number, b: number) {
    return a === b || (b !== 0 && Math.abs(a - b) <= Math.abs(b) * 1e-10);
}

/**
 * new-api stores the shared model ratios at a fixed decimal precision. A
 * group quote is derived from the official model price and the selected
 * GroupRatio, so converting that quote back can differ by one stored unit
 * even when it represents the same shared base. Treat only that storage
 * quantization as equal; a real base-price change must still be rejected when
 * the model is used by another group.
 */
function equivalentSharedValue(key: string, old: unknown, next: unknown): boolean {
    if (old === next) return true;
    if (typeof old !== 'number' || typeof next !== 'number' || !Number.isFinite(old) || !Number.isFinite(next))
        return false;
    const quantum = key === 'ModelRatio' ? 1e-6 : key === 'CompletionRatio' ? 1e-4 : key === 'ModelPrice' ? 1e-6 : 0;
    return quantum > 0 && Math.abs(old - next) <= quantum / 2 + Math.max(Math.abs(old), Math.abs(next)) * 1e-12;
}

function fail(code: string, message: string): never {
    throw new PricingPublishError(code, message);
}

function plainDetails(
    input: number,
    output: number,
    cached: number | null,
    write: number | null,
): TieredPricingDetails {
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
                rates: { input, output, cache_read: cached, cache_write: write, cache_write_1h: null },
            },
        ],
    };
}

function ratioDetails(
    model: NewApiRuntimePricingModel,
    ratio: number,
    modelRatio = model.model_ratio,
    completion = model.completion_ratio,
) {
    const input = modelRatio * CHAT_FX * ratio;
    const precision = (value: number) => Number(value.toFixed(12));
    return plainDetails(
        precision(input),
        precision(input * completion),
        model.cache_ratio === undefined ? null : precision(input * model.cache_ratio),
        model.create_cache_ratio === undefined ? null : precision(input * model.create_cache_ratio),
    );
}

function sameExpression(a: string, b: string) {
    // A different tier label does not change the tariff. Branch boundaries do.
    const rates = (value: string) =>
        tieredDetails(value, 1).tiers.map((tier) => ({
            min_input_tokens: tier.min_input_tokens,
            max_input_tokens: tier.max_input_tokens,
            min_inclusive: tier.min_inclusive,
            max_inclusive: tier.max_inclusive,
            rates: tier.rates,
        }));
    return fingerprint(rates(a)) === fingerprint(rates(b));
}

export function buildGroupPublishPlan(
    state: PublishState,
    source: PublishSource,
    inputs: PricingPublishInput[],
    now: number,
    context: CostBatchContext,
    runtime: NewApiRuntimePricing,
): GroupPublishPlan {
    const scope = context.group_scope;
    if (
        !scope ||
        !inputs.length ||
        inputs.length > 30 ||
        !Number.isFinite(scope.retail_ratio) ||
        scope.retail_ratio <= 0
    )
        fail('pricing_group_invalid', '请选择一个完整档次，并填写有效的统一售价倍率；每批最多 30 个模型。');
    const owners = state.groups.filter((group) => group.enabled && group.newapi_group === scope.newapi_group);
    const group = owners[0];
    if (owners.length !== 1 || group.key !== scope.tier)
        fail('pricing_group_invalid', 'new-api 分组未唯一归属于所选档次，请刷新后重试。');
    const liveChannels = source.channels.filter(
        (channel) => channel.status === 1 && channel.groups.includes(group.newapi_group),
    );
    if (!liveChannels.length || liveChannels.some((channel) => !group.newapi_channel_ids.includes(channel.id)))
        fail('pricing_group_mapping', '该分组存在未登记或不可用渠道，请先同步完整渠道归属。');
    const names = [...new Set(liveChannels.flatMap((channel) => channel.models))].sort();
    const selectedNames = inputs.map((input) => {
        const model = state.models.find((item) => item.id === input.model_id);
        if (!model || !model.enabled || model.tenant_id !== group.tenant_id || input.tier !== group.key)
            fail('pricing_group_selection', '整组定价只能选择该档次下已启用的模型。');
        return tieredModelName(state, input);
    });
    if (
        new Set(selectedNames).size !== selectedNames.length ||
        fingerprint([...selectedNames].sort()) !== fingerprint(names)
    )
        fail('pricing_group_incomplete', '分组模型清单已变化或尚未完整登记，必须包含该分组全部可用模型后再发布。');
    const baseline = tieredPriceOptions(source.options);
    const oldRatio = baseline.GroupRatio[group.newapi_group];
    if (typeof oldRatio !== 'number' || !Number.isFinite(oldRatio) || oldRatio <= 0)
        fail('pricing_group_invalid', '当前分组倍率缺失或无效，请先核对 new-api。');
    const target: GroupPublishPlan['target'] = {};
    const rows: GroupPublishPlan['rows'] = [];
    const overrides: GroupPublishPlan['customer_overrides'] = [];
    const requestOverrides: GroupPublishPlan['customer_request_overrides'] = [];
    const modelTypes: GroupPublishPlan['upstream_models'] = [];
    let units: GroupPublishPlan['units'] | undefined;
    // Targets are calculated from the selected group's NEW multiplier. This is
    // essential: keeping the old multiplier would change every other group.
    const quoteSource = {
        ...source,
        options: {
            ...source.options,
            GroupRatio: { ...baseline.GroupRatio, [group.newapi_group]: scope.retail_ratio },
        },
    };
    for (const [index, input] of inputs.entries()) {
        const name = selectedNames[index];
        const running = runtime.models.find((model) => model.model_name === name);
        if (!running) fail('pricing_runtime_missing', `未读到 ${name} 的实际计费，请刷新后重试。`);
        const isExpression = baseline['billing_setting.billing_mode'][name] === 'tiered_expr';
        const plainInput = { ...input };
        delete plainInput.cache_read_cny_per_1m;
        delete plainInput.cache_write_cny_per_1m;
        delete plainInput.cache_write_1h_cny_per_1m;
        const single = isExpression
            ? buildCacheUniformPublishPlan(state, quoteSource, [input], now)
            : buildPublishPlan(state, quoteSource, plainInput, now);
        units = single.units;
        modelTypes.push({ name, basis: single.basis });
        const desired =
            single.version === 5
                ? single.target
                : Object.fromEntries(Object.entries(single.target).map(([key, value]) => [key, { [name]: value }]));
        const externalGroups = new Set(
            source.channels
                .filter((channel) => channel.status === 1 && channel.models.includes(name))
                .flatMap((channel) => channel.groups)
                .filter((item) => item !== group.newapi_group),
        );
        for (const [rawKey, values] of Object.entries(desired)) {
            const key = rawKey as PublicationWriteKey;
            const next = values[name];
            const old = baseline[key as keyof TieredPriceOptions]?.[name];
            const equivalent =
                key === EXPRESSION_KEY && typeof old === 'string' && typeof next === 'string'
                    ? sameExpression(old, next)
                    : equivalentSharedValue(key, old, next);
            if (externalGroups.size && !equivalent)
                fail(
                    'pricing_group_shared_base',
                    `${name} 与其他分组共享基础价格，当前报价会改变其他分组；请先核对基础价。`,
                );
            // Preserve an equivalent existing formula, including its label, so
            // other groups and acknowledged/no-op jobs have no unnecessary write.
            target[key] = { ...target[key], [name]: equivalent ? (old as string | number) : next };
        }
        const selectedRows = single.rows.filter((row) => row.group === group.newapi_group);
        if (selectedRows.length !== 1 || selectedRows[0].model_id !== input.model_id)
            fail('pricing_group_ambiguous', `${name} 在该档次存在多个目录映射，请先核对。`);
        const row = selectedRows[0];
        for (const key of ['input_cny_per_1m', 'output_cny_per_1m', 'per_image_cny'] as const) {
            const wanted = input[key],
                actual = row.after[key];
            if (wanted === null ? actual !== null : actual === null || !same(actual, wanted))
                fail('pricing_group_precision', `${name} 的实际单价与填写目标不一致，请调整基础报价精度。`);
        }
        let beforeDetails: TieredPricingDetails | undefined;
        let afterDetails: TieredPricingDetails | undefined;
        if (isExpression) {
            beforeDetails = tieredDetails(String(baseline[EXPRESSION_KEY][name]), oldRatio);
            afterDetails = tieredDetails(String(target[EXPRESSION_KEY]![name]), scope.retail_ratio);
        } else if (single.basis === 'token') {
            beforeDetails = ratioDetails(running, oldRatio);
            afterDetails = ratioDetails(
                running,
                scope.retail_ratio,
                Number(target.ModelRatio![name]),
                Number(target.CompletionRatio![name]),
            );
            for (const key of ['cache_read', 'cache_write', 'cache_write_1h'] as const) {
                const wanted = input[`${key}_cny_per_1m`];
                if (
                    wanted !== undefined &&
                    (afterDetails.tiers[0].rates[key] === null || !same(afterDetails.tiers[0].rates[key]!, wanted))
                )
                    fail(
                        'pricing_group_cache_mismatch',
                        `${name} 的缓存报价与 new-api 当前缓存倍率不一致，请核对缓存基础价。`,
                    );
            }
        }
        const currentPrice = state.prices
            .filter((price) => price.model_id === input.model_id && price.tier === input.tier)
            .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.id.localeCompare(a.id))[0];
        rows.push({
            ...row,
            // Group cost rules hold the full cost breakdown separately. A null
            // legacy estimate must not erase the last catalog reference cost.
            cost_cny_per_1m: input.cost_cny_per_1m ?? currentPrice?.cost_cny_per_1m ?? null,
            ...(beforeDetails ? { before_details: beforeDetails, after_details: afterDetails } : {}),
        });
        {
            const byRatio = new Map<number, number>();
            for (const value of Object.values(baseline.GroupGroupRatio)) {
                const custom = dictionary(value, 'GroupGroupRatio')[group.newapi_group];
                if (custom === undefined) continue;
                if (typeof custom !== 'number' || !Number.isFinite(custom) || custom < 0)
                    fail('pricing_override_invalid', '客户专属倍率无效。');
                byRatio.set(custom, (byRatio.get(custom) ?? 0) + 1);
            }
            for (const [ratio, count] of byRatio) {
                if (single.basis === 'request') {
                    requestOverrides.push({
                        model_id: input.model_id,
                        model_name: row.model_name,
                        group: group.newapi_group,
                        ratio,
                        public_ratio: scope.retail_ratio,
                        count,
                        before_per_image_cny: Number(
                            (Number(baseline.ModelPrice[name]) * IMAGE_FX * ratio).toFixed(12),
                        ),
                        after_per_image_cny: Number((Number(target.ModelPrice![name]) * IMAGE_FX * ratio).toFixed(12)),
                    });
                    continue;
                }
                overrides.push({
                    model_id: input.model_id,
                    model_name: row.model_name,
                    group: group.newapi_group,
                    ratio,
                    public_ratio: scope.retail_ratio,
                    count,
                    before: isExpression
                        ? tieredDetails(String(baseline[EXPRESSION_KEY][name]), ratio)
                        : ratioDetails(running, ratio),
                    after: isExpression
                        ? tieredDetails(String(target[EXPRESSION_KEY]![name]), ratio)
                        : ratioDetails(
                              running,
                              ratio,
                              Number(target.ModelRatio![name]),
                              Number(target.CompletionRatio![name]),
                          ),
                });
            }
        }
    }
    // One group entry only. No unselected group, override or billing mode writes.
    target.GroupRatio = { [group.newapi_group]: scope.retail_ratio };
    const plan: GroupPublishPlan = {
        version: 6,
        strategy: 'group',
        inputs,
        upstream_model: selectedNames.join(', '),
        upstream_models: modelTypes,
        tenant_id: group.tenant_id,
        basis: modelTypes[0].basis,
        rows,
        baseline,
        target,
        source_guard: groupSourceGuard(source),
        catalog_guard: fingerprint(state),
        units: units!,
        cost_context: context,
        runtime_baseline: runtime,
        customer_overrides: overrides,
        customer_request_overrides: requestOverrides,
        unchanged: Object.entries(target).every(([key, values]) =>
            Object.entries(values!).every(([name, value]) => baseline[key as keyof TieredPriceOptions][name] === value),
        ),
        warnings: [
            '本次统一设置所选档次全部模型的售价倍率，其他分组售价保持不变。',
            '客户按各模型输入、输出与缓存单价计费，单价不随输入长度变化。',
            '所有配置核验一致后才更新目录；多个配置写入期间可能短暂使用过渡价格。',
            ...(overrides.length || requestOverrides.length ? ['客户专属倍率保持不变，仍按下列专属价格计费。'] : []),
        ],
    };
    assertGroupRuntime(runtime, plan, false);
    return plan;
}

/** Only our owned entries may be at old or target values during recovery. */
export function assertRecoverableGroupOptions(current: TieredPriceOptions, plan: GroupPublishPlan) {
    for (const key of TIERED_PRICE_KEYS) {
        const expected = { ...plan.baseline[key] };
        for (const [name, target] of Object.entries(plan.target[key as PublicationWriteKey] ?? {})) {
            const value = current[key][name];
            if (value !== expected[name] && value !== target)
                fail('pricing_conflict', '分组价格出现其他修改，已停止发布。');
            if (Object.hasOwn(current[key], name)) expected[name] = value;
            else delete expected[name];
        }
        if (fingerprint(expected) !== fingerprint(current[key]))
            fail('pricing_conflict', '其他分组或模型价格已变化，已停止发布。');
    }
}

/** Runtime cache propagation must finish for EVERY model before activation. */
export function assertGroupRuntime(runtime: NewApiRuntimePricing, plan: GroupPublishPlan, target: boolean) {
    const scope = plan.cost_context.group_scope!;
    const ratio = target ? scope.retail_ratio : plan.baseline.GroupRatio[scope.newapi_group];
    if (runtime.group_ratio[scope.newapi_group] !== ratio) throw new Error('Group runtime pricing has not converged');
    for (const { name, basis } of plan.upstream_models) {
        const current = runtime.models.find((model) => model.model_name === name);
        const old = plan.runtime_baseline.models.find((model) => model.model_name === name)!;
        if (
            !current ||
            !current.enable_groups.includes(scope.newapi_group) ||
            current.quota_type !== (basis === 'token' ? 0 : 1)
        )
            throw new Error('Group runtime model has not converged');
        for (const other of current.enable_groups) {
            if (other !== scope.newapi_group && runtime.group_ratio[other] !== plan.runtime_baseline.group_ratio[other])
                throw new Error('Other group runtime changed');
        }
        if (plan.baseline['billing_setting.billing_mode'][name] === 'tiered_expr') {
            const expr = target ? plan.target[EXPRESSION_KEY]?.[name] : plan.baseline[EXPRESSION_KEY][name];
            if (current.billing_mode !== 'tiered_expr' || current.billing_expr !== expr)
                throw new Error('Group expression has not converged');
        } else {
            if (
                current.billing_mode === 'tiered_expr' ||
                current.cache_ratio !== old.cache_ratio ||
                current.create_cache_ratio !== old.create_cache_ratio
            )
                throw new Error('Group cache rules changed');
            if (basis === 'request') {
                const expected = target ? plan.target.ModelPrice?.[name] : plan.baseline.ModelPrice[name];
                if (!equivalentSharedValue('ModelPrice', current.model_price, expected))
                    throw new Error('Group image pricing has not converged');
            } else {
                const expectedModelRatio = target ? plan.target.ModelRatio?.[name] : plan.baseline.ModelRatio[name];
                const expectedCompletionRatio = target ? plan.target.CompletionRatio?.[name] : old.completion_ratio;
                if (
                    !equivalentSharedValue('ModelRatio', current.model_ratio, expectedModelRatio) ||
                    !equivalentSharedValue('CompletionRatio', current.completion_ratio, expectedCompletionRatio)
                )
                    throw new Error('Group model pricing has not converged');
            }
        }
    }
}
