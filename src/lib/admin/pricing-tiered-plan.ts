import 'server-only';
import type { CostBatchContext } from './pricing-cost-publication-guard';
import type { PricingPublishInput, PricingPublishPreview, TieredPricingDetails } from './pricing-publish-types';
import {
    buildPublishPlan,
    dictionary,
    fingerprint,
    priceOptions,
    sourceGuard,
    type PublishPlan,
    type PublishSource,
    type PublishState,
    type PriceOptions,
} from './pricing-publish-plan';
import { PricingPublishError } from './pricing-publish-lock';
import { IMAGE_FX } from '@/lib/newapi/pricing-sync';
import { parseTieredPricingExpression, scaleTieredPricingExpression } from './pricing-tiered-expression';

export const EXPRESSION_KEY = 'billing_setting.billing_expr' as const;
export const TIERED_PRICE_KEYS = [
    'ModelRatio',
    'CompletionRatio',
    'ModelPrice',
    'GroupRatio',
    EXPRESSION_KEY,
    'billing_setting.billing_mode',
    'GroupGroupRatio',
] as const;
export type TieredPriceOptions = PriceOptions & Record<(typeof TIERED_PRICE_KEYS)[number], Record<string, unknown>>;
export interface TieredPublishPlan extends Omit<PublishPlan, 'version' | 'input' | 'target' | 'baseline'> {
    version: 3;
    inputs: PricingPublishInput[];
    upstream_models: Array<{ name: string; basis: 'token' }>;
    baseline: TieredPriceOptions;
    target: { [EXPRESSION_KEY]: Record<string, string> };
    cost_context?: CostBatchContext;
    unchanged: boolean;
    customer_overrides: NonNullable<PricingPublishPreview['customer_overrides']>;
}

export function tieredPriceOptions(options: Record<string, unknown>): TieredPriceOptions {
    return Object.fromEntries(
        TIERED_PRICE_KEYS.map((key) => [key, dictionary(options[key], key)]),
    ) as TieredPriceOptions;
}

export function tieredModelName(state: PublishState, input: PricingPublishInput): string {
    const model = state.models.find((row) => row.id === input.model_id);
    const map = dictionary(model?.upstream_map, '模型渠道映射');
    const entry = dictionary(map[input.tier], '档次映射');
    if (typeof entry.upstream_model !== 'string')
        throw new PricingPublishError('pricing_mapping_invalid', '上游模型映射不完整。');
    return entry.upstream_model;
}

export function isTieredInput(state: PublishState, source: PublishSource, input: PricingPublishInput) {
    const modes = dictionary(source.options['billing_setting.billing_mode'], 'billing_setting.billing_mode');
    return modes[tieredModelName(state, input)] === 'tiered_expr';
}

export function tieredDetails(expression: string, groupRatio: number): TieredPricingDetails {
    const parsed = parseTieredPricingExpression(expression);
    const rate = (value: number | null) => {
        if (value === null) return null;
        // Expression v1 coefficients are currency/1M, not ModelRatio quota/token.
        const result = Number((value * groupRatio * IMAGE_FX).toFixed(12));
        if (!Number.isFinite(result) || result < 0 || (value > 0 && groupRatio > 0 && result === 0))
            throw new PricingPublishError('pricing_tiered_precision', '阶梯价超出可核验精度，不能发布为零或无效价格。');
        return result;
    };
    return {
        version: 1,
        mode: 'tiered_token',
        unit: 'cny_per_million_tokens',
        semantics: 'whole_request',
        tiers: parsed.tiers.map((tier) => ({
            ...tier,
            rates: Object.fromEntries(
                Object.entries(tier.rates).map(([key, value]) => [key, rate(value)]),
            ) as TieredPricingDetails['tiers'][number]['rates'],
        })),
    };
}

function sameNumber(a: number, b: number) {
    if (a === 0 || b === 0) return a === b;
    return Math.abs(a - b) <= Math.abs(b) * 1e-10;
}

export function tieredProbeInput(
    state: PublishState,
    source: PublishSource,
    modelId: string,
    tier: string,
): PricingPublishInput {
    const probe = {
        model_id: modelId,
        tier,
        input_cny_per_1m: 1,
        output_cny_per_1m: 1,
        per_image_cny: null,
        cost_cny_per_1m: null,
    };
    const name = tieredModelName(state, probe);
    const model = state.models.find((row) => row.id === modelId)!;
    const group = state.groups.find((row) => row.tenant_id === model.tenant_id && row.key === tier && row.enabled);
    const ratio = priceOptions(source.options).GroupRatio[group?.newapi_group ?? ''];
    const expr = dictionary(source.options[EXPRESSION_KEY], EXPRESSION_KEY)[name];
    if (typeof expr !== 'string' || typeof ratio !== 'number' || ratio <= 0)
        throw new PricingPublishError('pricing_tiered_invalid', '阶梯公式或分组倍率缺失。');
    const base = tieredDetails(expr, ratio).tiers[0].rates;
    return {
        ...probe,
        input_cny_per_1m: base.input,
        output_cny_per_1m: base.output,
        ...(base.cache_read === null ? {} : { cache_read_cny_per_1m: base.cache_read }),
    };
}

/** Absolute first-tier targets scale every original tier together, never flattening
 * thresholds or multiplying an already published retail price a second time. */
export function buildTieredPublishPlan(
    state: PublishState,
    source: PublishSource,
    inputs: PricingPublishInput[],
    now: number,
    context?: CostBatchContext,
): TieredPublishPlan {
    if (
        inputs.some(
            (input) => input.cache_write_cny_per_1m !== undefined || input.cache_write_1h_cny_per_1m !== undefined,
        )
    )
        throw new PricingPublishError(
            'pricing_cache_write_unsupported',
            '历史发布任务不支持新增缓存写入价格，请重新预览。',
        );
    return buildTieredPlanInternal(state, source, inputs, now, context, false);
}

/** Current-price validation only; the returned proportional target is never published.
 * Legacy V3/V4 callers keep the original restrictions and signed plan semantics. */
export function buildCacheUniformSourceProbe(
    state: PublishState,
    source: PublishSource,
    inputs: PricingPublishInput[],
    now: number,
): TieredPublishPlan {
    return buildTieredPlanInternal(state, source, inputs, now, undefined, true);
}

function buildTieredPlanInternal(
    state: PublishState,
    source: PublishSource,
    inputs: PricingPublishInput[],
    now: number,
    context: CostBatchContext | undefined,
    cacheUniformProbe: boolean,
): TieredPublishPlan {
    if (process.env.BILLING_SOURCE === 'portal')
        throw new PricingPublishError(
            'pricing_tiered_billing_source',
            '阶梯发布需要由 new-api 计费；Portal 本地计费尚不能结算这些阶梯。',
        );
    if (inputs.length !== 1)
        throw new PricingPublishError(
            'pricing_tiered_batch',
            '阶梯计费请每次单独预览一个模型档次；预览会列出所有关联档次的影响。',
        );
    const input = inputs[0];
    const name = tieredModelName(state, input);
    const baseline = tieredPriceOptions(source.options);
    if (baseline['billing_setting.billing_mode'][name] !== 'tiered_expr')
        throw new PricingPublishError('pricing_tiered_invalid', '模型已不再使用阶梯计费，请重新预览。');
    const expression = baseline[EXPRESSION_KEY][name];
    if (typeof expression !== 'string') throw new PricingPublishError('pricing_tiered_invalid', '未读到实际阶梯公式。');
    let parsed: ReturnType<typeof parseTieredPricingExpression>;
    try {
        parsed = parseTieredPricingExpression(expression);
    } catch {
        throw new PricingPublishError(
            'pricing_tiered_unsupported',
            '该动态公式含尚不支持的计费条件。成本可保存；发布前需完整适配该公式。',
        );
    }
    if (
        !cacheUniformProbe &&
        parsed.tiers.some((tier) => (tier.rates.cache_read !== null) !== (parsed.tiers[0].rates.cache_read !== null))
    )
        throw new PricingPublishError(
            'pricing_tiered_unsupported',
            '不同档位的缓存计费变量不一致，当前向导尚不能完整表示该公式。',
        );
    if (
        !cacheUniformProbe &&
        parsed.tiers.some((tier) => tier.rates.cache_write !== null || tier.rates.cache_write_1h !== null)
    )
        throw new PricingPublishError(
            'pricing_cache_write_unsupported',
            '此公式还包含缓存写入时长计费，当前向导尚不能完整报价。',
        );
    if (
        input.input_cny_per_1m === null ||
        input.input_cny_per_1m <= 0 ||
        input.output_cny_per_1m === null ||
        input.per_image_cny !== null ||
        input.pricing_mode === 'fixed_image'
    )
        throw new PricingPublishError('pricing_basis_change', '阶梯模型需要完整输入与输出售价。');
    if (Object.hasOwn(baseline.ModelPrice, name))
        throw new PricingPublishError('pricing_tiered_ambiguous', '模型同时配置按次价格，请先核对实际计费配置。');
    const model = state.models.find((row) => row.id === input.model_id)!;
    const group = state.groups.find(
        (row) => row.tenant_id === model.tenant_id && row.key === input.tier && row.enabled,
    );
    const ratio = baseline.GroupRatio[group?.newapi_group ?? ''];
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0)
        throw new PricingPublishError('pricing_group_invalid', '分组倍率缺失或无效。');
    const currentBase = tieredDetails(expression, ratio).tiers[0].rates;
    if (currentBase.input <= 0)
        throw new PricingPublishError('pricing_tiered_invalid', '首档输入价必须大于零，才能安全按倍率定价。');
    const factor = input.input_cny_per_1m / currentBase.input;
    if (!sameNumber(currentBase.output * factor, input.output_cny_per_1m))
        throw new PricingPublishError(
            'pricing_tiered_proportions',
            '所填输入、输出基础价与 new-api 首档比例不符，请重新查询并核对基础价。',
        );
    if (currentBase.cache_read !== null) {
        if (
            input.cache_read_cny_per_1m === undefined ||
            !sameNumber(currentBase.cache_read * factor, input.cache_read_cny_per_1m)
        )
            throw new PricingPublishError(
                'pricing_tiered_cache',
                '该模型有缓存读取计费，请填写与首档比例一致的缓存基础价后再预览。',
            );
    } else if (input.cache_read_cny_per_1m !== undefined)
        throw new PricingPublishError('pricing_tiered_cache', '当前公式没有缓存读取单独计费，不能额外添加缓存价格。');
    const nextExpression = sameNumber(factor, 1)
        ? expression
        : scaleTieredPricingExpression(expression, input.input_cny_per_1m, currentBase.input);
    const nextBase = tieredDetails(nextExpression, ratio).tiers[0].rates;
    if (
        !sameNumber(nextBase.input, input.input_cny_per_1m) ||
        !sameNumber(nextBase.output, input.output_cny_per_1m) ||
        (input.cache_read_cny_per_1m !== undefined && !sameNumber(nextBase.cache_read!, input.cache_read_cny_per_1m))
    )
        throw new PricingPublishError('pricing_tiered_precision', '目标价超出表达式精度，请调整后重新预览。');
    // Reuse existing topology, tenant, channel, units, future-price and shared-model
    // validation. The ordinary temporary plan is never stored or written.
    const plainInput = { ...input };
    delete plainInput.cache_read_cny_per_1m;
    delete plainInput.cache_write_cny_per_1m;
    delete plainInput.cache_write_1h_cny_per_1m;
    const meta = dictionary(source.options.CompletionRatioMeta, 'CompletionRatioMeta');
    const validationSource: PublishSource = {
        ...source,
        options: {
            ...source.options,
            'billing_setting.billing_mode': { ...baseline['billing_setting.billing_mode'], [name]: 'standard' },
            CompletionRatioMeta: {
                ...meta,
                [name]: { ratio: input.output_cny_per_1m / input.input_cny_per_1m, locked: false },
            },
        },
    };
    const ordinary = buildPublishPlan(state, validationSource, plainInput, now);
    const rows = ordinary.rows.map((row) => {
        const groupRatio = baseline.GroupRatio[row.group];
        if (typeof groupRatio !== 'number' || !Number.isFinite(groupRatio) || groupRatio <= 0)
            throw new PricingPublishError('pricing_group_invalid', '关联分组倍率无效。');
        const before = tieredDetails(expression, groupRatio),
            after = tieredDetails(nextExpression, groupRatio);
        // Scalars stay backward-compatible base-tier prices; JSON retains complete precision.
        const base = after.tiers[0].rates;
        for (const price of [base.input, base.output]) {
            if (price > 99_999_999.9999 || (price > 0 && Number(price.toFixed(4)) === 0))
                throw new PricingPublishError('pricing_tiered_precision', '关联档次首档价格超出目录可保存范围。');
        }
        const oldCost = state.prices
            .filter((price) => price.model_id === row.model_id && price.tier === row.tier)
            .sort(
                (a, b) => b.effective_from.localeCompare(a.effective_from) || b.id.localeCompare(a.id),
            )[0]?.cost_cny_per_1m;
        return {
            ...row,
            cost_cny_per_1m: row.cost_cny_per_1m ?? oldCost ?? null,
            before_details: before,
            after_details: after,
            after: {
                input_cny_per_1m: Number(base.input.toFixed(4)),
                output_cny_per_1m: Number(base.output.toFixed(4)),
                per_image_cny: null,
            },
        };
    });
    const overrides = new Map<string, NonNullable<PricingPublishPreview['customer_overrides']>[number]>();
    for (const value of Object.values(baseline.GroupGroupRatio)) {
        const byGroup = dictionary(value, 'GroupGroupRatio');
        for (const groupName of new Set(rows.map((row) => row.group))) {
            if (!Object.hasOwn(byGroup, groupName)) continue;
            const customRatio = byGroup[groupName];
            if (typeof customRatio !== 'number' || !Number.isFinite(customRatio) || customRatio < 0)
                throw new PricingPublishError('pricing_override_invalid', '客户专属倍率无效，无法完整核对影响。');
            const key = JSON.stringify([groupName, customRatio]);
            const existing = overrides.get(key);
            if (existing) existing.count++;
            else
                overrides.set(key, {
                    group: groupName,
                    ratio: customRatio,
                    public_ratio: Number(baseline.GroupRatio[groupName]),
                    count: 1,
                    before: tieredDetails(expression, customRatio),
                    after: tieredDetails(nextExpression, customRatio),
                });
        }
    }
    return {
        version: 3,
        inputs,
        upstream_model: name,
        upstream_models: [{ name, basis: 'token' }],
        tenant_id: ordinary.tenant_id,
        basis: 'token',
        rows,
        baseline,
        target: { [EXPRESSION_KEY]: { [name]: nextExpression } },
        source_guard: sourceGuard(source),
        catalog_guard: fingerprint(state),
        units: ordinary.units,
        unchanged: nextExpression === expression,
        customer_overrides: [...overrides.values()],
        warnings: [
            '根据完整输入长度选择一个档位，整次请求按该档位计费；保留原有边界、档名和缓存读取规则。',
            '本次只更新该模型的整份阶梯公式，不修改分组倍率。所有渠道中使用同一上游模型名的请求会共同受影响。',
            '发布期间请只在 Portal 改价，避免同时在 new-api 后台或脚本中修改计费配置。',
            ...(overrides.size ? ['客户专属倍率替代公共分组倍率，下方已单独列出其价格；专属倍率本身保持不变。'] : []),
            ...(nextExpression === expression
                ? ['new-api 当前计费已经与目标一致；确认后将核验并补齐 Portal 的阶梯目录，不重复改价。']
                : []),
        ],
        ...(context ? { cost_context: context } : {}),
    };
}

export function assertRecoverableTieredOptions(
    current: TieredPriceOptions,
    plan: Pick<TieredPublishPlan, 'baseline' | 'target' | 'upstream_model'>,
) {
    for (const key of TIERED_PRICE_KEYS) {
        const expected = { ...plan.baseline[key] };
        if (key === EXPRESSION_KEY) {
            const name = plan.upstream_model;
            const actual = current[key][name];
            if (actual !== expected[name] && actual !== plan.target[key][name])
                throw new PricingPublishError('pricing_conflict', '阶梯公式出现其他修改，已停止发布。');
            expected[name] = actual;
        }
        if (fingerprint(current[key]) !== fingerprint(expected))
            throw new PricingPublishError('pricing_conflict', '分组、阶梯模式或其他价格配置已变化，已停止发布。');
    }
}
