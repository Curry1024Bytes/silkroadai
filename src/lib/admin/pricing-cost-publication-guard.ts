import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalSync } from './newapi-sync-plan';
import { costMapping, type CostDb, type CostModel } from './pricing-cost-store';
import { calculateCostPricing, pricingCostConfigSchema } from './pricing-cost';
import type { PricingCostConfig, PricingCostSelection } from './pricing-cost-types';
import type { PricingPublishInput } from './pricing-publish-types';
import { PricingPublishError } from './pricing-publish-lock';
import type { AdminPrincipal } from './auth';
import { tenantScope } from './tenant-scope';

export interface CostBatchContext {
    selections: PricingCostSelection[];
    fingerprint: string;
}
export const pricingCostSelectionsSchema = z
    .array(
        z
            .object({
                rule_id: z.string().uuid(),
                revision: z.number().int().positive(),
                variant_key: z.string().min(1).max(80).optional(),
            })
            .strict(),
    )
    .min(1)
    .max(30)
    .refine((rows) => new Set(rows.map((row) => row.rule_id)).size === rows.length, '同一成本规则只能选择一次。');

function hash(value: unknown) {
    return createHash('sha256').update(canonicalSync(value)).digest('hex');
}

export function costPublicationInput(model: CostModel, tier: string, config: PricingCostConfig, variantKey?: string) {
    const calculation = calculateCostPricing(config);
    const input: PricingPublishInput = {
        model_id: model.id,
        tier,
        input_cny_per_1m: null,
        output_cny_per_1m: null,
        per_image_cny: null,
        cost_cny_per_1m: null,
    };
    if (config.basis === 'video' || model.modality === 'video')
        throw new PricingPublishError(
            'pricing_video_unsupported',
            '视频成本可保存和按秒试算；当前发布器尚不能核验视频时长与规格计费，请保留现有视频计费设置。',
        );
    if (config.basis === 'token') {
        if (variantKey) throw new PricingPublishError('pricing_cost_variant', 'Token 成本不使用图片或视频规格。', 400);
        if (config.token_rates.cache_write !== null)
            throw new PricingPublishError(
                'pricing_cache_unsupported',
                '缓存写入的独立时长报价尚未支持发布；成本仍可保存。',
            );
        if (config.token_rates.cache_read !== null)
            input.cache_read_cny_per_1m = calculation.lines.find((line) => line.key === 'cache_read')!.retail;
        input.input_cny_per_1m = calculation.lines.find((line) => line.key === 'input')?.retail ?? null;
        input.output_cny_per_1m = calculation.lines.find((line) => line.key === 'output')?.retail ?? null;
        if (input.input_cny_per_1m === null || input.input_cny_per_1m <= 0 || input.output_cny_per_1m === null)
            throw new PricingPublishError(
                'pricing_cost_incomplete',
                '发布 Token 价格需要完整的输入与输出成本，输入售价必须大于零。',
            );
    } else {
        const fixed = /^gpt-image-2-(1k|2k|4k)$/.exec(model.slug);
        if (config.variants.length !== 1)
            throw new PricingPublishError(
                'pricing_image_variants_unsupported',
                '同一模型的多规格报价可保存试算；发布需要为已配置的独立图片型号保留一条对应规格。',
            );
        const variant = config.variants[0];
        if (variantKey !== variant.key)
            throw new PricingPublishError('pricing_cost_variant', '请选择本次发布的图片规格。', 400);
        if (
            variant.minimum_units !== 1 ||
            variant.step_units !== 1 ||
            variant.audio !== 'any' ||
            variant.reference_video !== 'any'
        )
            throw new PricingPublishError(
                'pricing_image_units',
                '当前图片发布仅支持每张单价，不能发布最低张数、步长或音频/参考视频规则。',
            );
        if (fixed) {
            if (variant.resolution.trim().toLowerCase() !== fixed[1])
                throw new PricingPublishError(
                    'pricing_image_resolution',
                    `该图片型号只对应 ${fixed[1].toUpperCase()}，请修正成本规格。`,
                );
            input.pricing_mode = 'fixed_image';
        } else if (
            variant.resolution.trim() &&
            !['standard', 'default', 'any', '通用', '默认'].includes(variant.resolution.trim().toLowerCase())
        ) {
            throw new PricingPublishError(
                'pricing_image_resolution',
                '普通图片型号的按次价格不能表达指定分辨率，请使用已配置的独立分辨率型号。',
            );
        }
        input.per_image_cny = calculation.lines[0].retail;
    }
    // Preserve precise cost in the quote. The legacy catalog has only one 4-decimal
    // input/per-request cost column, which cannot represent a complete cost breakdown.
    return { input, lines: calculation.lines };
}

export async function resolvePricingCostSelection(
    db: CostDb,
    selections: PricingCostSelection[],
    admin?: AdminPrincipal,
) {
    const normalized = pricingCostSelectionsSchema.parse(selections).sort((a, b) => a.rule_id.localeCompare(b.rule_id));
    const [rules, groups] = await Promise.all([
        db.pricingCostRule.findMany({
            where: {
                id: { in: normalized.map((row) => row.rule_id) },
                ...(admin ? { model: tenantScope(admin) } : {}),
            },
            include: { model: true },
        }),
        db.channelGroup.findMany({ where: admin ? tenantScope(admin) : {} }),
    ]);
    const snapshots: unknown[] = [];
    const inputs: PricingPublishInput[] = [];
    const cost_rows = [];
    for (const selection of normalized) {
        const rule = rules.find((row) => row.id === selection.rule_id);
        if (!rule || rule.revision !== selection.revision)
            throw new PricingPublishError('pricing_cost_revision', '所选成本资料已更新或不存在，请刷新并重新预览。');
        const mapping = costMapping(rule.model, rule.tier, groups);
        if (mapping.channel_id !== rule.channel_id || mapping.upstream_model !== rule.upstream_model)
            throw new PricingPublishError(
                'pricing_cost_mapping_changed',
                '渠道或上游模型已更换，请核对新上游成本并重新保存后再发布。',
            );
        const config = pricingCostConfigSchema.parse(rule.config);
        const derived = costPublicationInput(rule.model, rule.tier, config, selection.variant_key);
        inputs.push(derived.input);
        cost_rows.push(
            ...derived.lines.map((line) => ({
                ...line,
                model_id: rule.model_id,
                tier: rule.tier,
                ...(selection.variant_key ? { variant_key: selection.variant_key } : {}),
            })),
        );
        snapshots.push({ selection, config, model_id: rule.model_id, tier: rule.tier, mapping });
    }
    return {
        inputs,
        cost_rows,
        context: { selections: normalized, fingerprint: hash(snapshots) } satisfies CostBatchContext,
    };
}

/** Re-evaluated under the existing publication lock before writes and activation. */
export async function assertPricingCostContext(db: CostDb, inputs: PricingPublishInput[], context: CostBatchContext) {
    const current = await resolvePricingCostSelection(db, context.selections);
    if (current.context.fingerprint !== context.fingerprint || hash(current.inputs) !== hash(inputs))
        throw new PricingPublishError(
            'pricing_cost_changed',
            '成本规则、倍率或所选规格已变化，发布已停止，请重新预览。',
        );
}
