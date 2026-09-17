import 'server-only';
import { IMAGE_FX } from '@/lib/newapi/pricing-sync';
import type { CostBatchContext } from './pricing-cost-publication-guard';
import { PricingPublishError } from './pricing-publish-lock';
import type { PublishSource, PublishState } from './pricing-publish-plan';
import type { PricingPublishInput } from './pricing-publish-types';
import {
    buildTieredPublishPlan,
    EXPRESSION_KEY,
    tieredDetails,
    tieredProbeInput,
    type TieredPublishPlan,
} from './pricing-tiered-plan';
import { uniformTokenPricingExpression } from './pricing-tiered-expression';

/** V3 keeps its historical preserve-tier semantics. V4 is a separate signed
 * intent so queued legacy jobs can never silently become uniform tariffs. */
export interface UniformPublishPlan extends Omit<TieredPublishPlan, 'version'> {
    version: 4;
    strategy: 'uniform_token';
}

export function buildUniformPublishPlan(
    state: PublishState,
    source: PublishSource,
    inputs: PricingPublishInput[],
    now: number,
    context?: CostBatchContext,
): UniformPublishPlan {
    if (inputs.length !== 1)
        throw new PricingPublishError(
            'pricing_uniform_batch',
            '请每次预览一个模型档次，系统会列出所有关联档次的影响。',
        );
    const input = inputs[0];
    if (
        input.input_cny_per_1m === null ||
        !Number.isFinite(input.input_cny_per_1m) ||
        input.input_cny_per_1m <= 0 ||
        input.output_cny_per_1m === null ||
        !Number.isFinite(input.output_cny_per_1m) ||
        input.output_cny_per_1m < 0 ||
        input.per_image_cny !== null ||
        input.pricing_mode === 'fixed_image'
    )
        throw new PricingPublishError('pricing_basis_change', '请填写完整的输入与输出售价。');

    // Validate the complete existing source, topology, unsupported variables,
    // shared groups, tenant, future prices and units with a read-only current-price
    // probe. V3's proportional target is never used as the new publication intent.
    const probe = tieredProbeInput(state, source, input.model_id, input.tier);
    const checked = buildTieredPublishPlan(state, source, [probe], now);
    if (probe.cache_read_cny_per_1m !== undefined && input.cache_read_cny_per_1m === undefined)
        throw new PricingPublishError('pricing_uniform_cache', '请填写缓存读取基础价，系统才能完整发布该模型的售价。');
    const selected = checked.rows.find((row) => row.model_id === input.model_id && row.tier === input.tier)!;
    const ratio = Number(checked.baseline.GroupRatio[selected.group]);
    const expression = uniformTokenPricingExpression(
        {
            input: input.input_cny_per_1m,
            output: input.output_cny_per_1m,
            cache_read: input.cache_read_cny_per_1m ?? null,
        },
        ratio,
        IMAGE_FX,
    );
    const actual = tieredDetails(expression, ratio).tiers[0].rates;
    const exact = (a: number | null, b: number | null) =>
        a === null || b === null ? a === b : a === b || (b !== 0 && Math.abs(a - b) <= Math.abs(b) * 1e-10);
    if (
        !exact(actual.input, input.input_cny_per_1m) ||
        !exact(actual.output, input.output_cny_per_1m) ||
        !exact(actual.cache_read, input.cache_read_cny_per_1m ?? null)
    )
        throw new PricingPublishError('pricing_uniform_precision', '目标售价超出可核验精度，请调整后重新预览。');

    const rows = checked.rows.map((row) => {
        const after = tieredDetails(expression, Number(checked.baseline.GroupRatio[row.group]));
        const rates = after.tiers[0].rates;
        for (const price of [rates.input, rates.output]) {
            if (price > 99_999_999.9999 || (price > 0 && Number(price.toFixed(4)) === 0))
                throw new PricingPublishError('pricing_uniform_precision', '关联档次价格超出目录可保存范围。');
        }
        return {
            ...row,
            cost_cny_per_1m:
                row.model_id === input.model_id && row.tier === input.tier
                    ? (input.cost_cny_per_1m ?? row.cost_cny_per_1m)
                    : row.cost_cny_per_1m,
            after_details: after,
            after: {
                input_cny_per_1m: Number(rates.input.toFixed(4)),
                output_cny_per_1m: Number(rates.output.toFixed(4)),
                per_image_cny: null,
            },
        };
    });
    const unchanged = expression === checked.baseline[EXPRESSION_KEY][checked.upstream_model];
    return {
        ...checked,
        version: 4,
        strategy: 'uniform_token',
        inputs,
        rows,
        target: { [EXPRESSION_KEY]: { [checked.upstream_model]: expression } },
        unchanged,
        customer_overrides: checked.customer_overrides.map((override) => ({
            ...override,
            after: tieredDetails(expression, override.ratio),
        })),
        warnings: [
            '客户按本次输入、输出和缓存读取单价计费，单价不随上下文长度变化。上游倍率仅用于成本试算。',
            '本次更新该模型的客户计费价格，不修改分组倍率；所有渠道中使用同一模型名的请求会共同受影响。',
            '发布期间请只在 Portal 改价，避免同时在 new-api 后台或脚本中修改计费配置。',
            ...(checked.customer_overrides.length
                ? ['客户专属倍率替代公共分组倍率，下方已单独列出其价格；专属倍率本身保持不变。']
                : []),
            ...(unchanged ? ['new-api 当前计费已经与目标一致；确认后将核验并更新 Portal 目录，不重复改价。'] : []),
        ],
        ...(context ? { cost_context: context } : {}),
    };
}
