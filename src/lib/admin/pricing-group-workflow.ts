import 'server-only';
import { z } from 'zod';
import type { PricingGroupCatalog } from './pricing-group-types';
import type { PricingCostSelection } from './pricing-cost-types';
import { getCostQuoteDisplay, pricingCostConfigSchema } from './pricing-cost';
import type { CostRuleSave } from './pricing-cost-store';
import { PricingPublishError } from './pricing-publish-lock';
import type { PricingCostGroupScope } from './pricing-cost-publication-guard';

export const pricingGroupSettingsSchema = z
    .object({
        currency: z.enum(['cny', 'credits']),
        credits_per_cny: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
        upstream_multiplier: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
        retail_multiplier: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .strict()
    .superRefine((value, ctx) => {
        if (value.currency === 'cny' && value.credits_per_cny !== 1)
            ctx.addIssue({ code: 'custom', path: ['credits_per_cny'], message: '人民币基础报价的兑换比例应为 1。' });
        if (value.retail_multiplier < value.upstream_multiplier)
            ctx.addIssue({ code: 'custom', path: ['retail_multiplier'], message: '售价倍率不能低于上游倍率。' });
    });
export const pricingGroupDraftSchema = z
    .object({
        model_id: z.string().uuid(),
        expected_revision: z.number().int().positive().max(2_147_483_646).nullable(),
        config: pricingCostConfigSchema,
        variant_key: z.string().min(1).max(80).optional(),
    })
    .strict();
export type PricingGroupDraft = z.infer<typeof pricingGroupDraftSchema>;
export type PricingGroupSettings = z.infer<typeof pricingGroupSettingsSchema>;

/** GroupRatio applies to every model: accepting a partial selection would also
 * change the unselected models, so coverage is always checked server-side. */
export function assertGroupCoverage(catalog: PricingGroupCatalog, modelIds: string[]) {
    if (!catalog.models.length)
        throw new PricingPublishError('pricing_group_empty', '该 new-api 分组当前没有可用模型。');
    if (catalog.models.length > 30)
        throw new PricingPublishError(
            'pricing_group_size',
            '该档次超过当前支持的 30 个模型，暂不能整组发布；不会拆分改价。',
        );
    const blocked = catalog.models.filter((row) => !row.selectable || !row.model_id);
    if (blocked.length)
        throw new PricingPublishError(
            'pricing_group_incomplete',
            `该档次还有 ${blocked.length} 个模型需要处理，请先补齐登记或计费配置后再整组发布。`,
        );
    const expected = new Set(catalog.models.map((row) => row.model_id!));
    if (
        expected.size !== catalog.models.length ||
        new Set(modelIds).size !== modelIds.length ||
        modelIds.length !== expected.size ||
        modelIds.some((id) => !expected.has(id))
    )
        throw new PricingPublishError(
            'pricing_group_coverage',
            '整组定价必须包含该 new-api 分组的全部模型，请重新加载模型清单。',
        );
}

export function prepareGroupCostDrafts(
    catalog: PricingGroupCatalog,
    fingerprint: string,
    settings: PricingGroupSettings,
    drafts: PricingGroupDraft[],
): CostRuleSave[] {
    if (catalog.fingerprint !== fingerprint)
        throw new PricingPublishError(
            'pricing_group_stale',
            '该档次的模型、基础价或成本资料已变化，请重新加载后预览。',
        );
    const common = pricingGroupSettingsSchema.parse(settings);
    assertGroupCoverage(
        catalog,
        drafts.map((row) => row.model_id),
    );
    return drafts.map((candidate) => {
        const draft = pricingGroupDraftSchema.parse(candidate);
        const current = catalog.models.find((row) => row.model_id === draft.model_id)!;
        if (current.saved_revision !== draft.expected_revision)
            throw new PricingPublishError('pricing_cost_revision', '成本资料已被更新，请重新加载后预览。');
        const config = pricingCostConfigSchema.parse({ ...draft.config, ...common, markup_percent: 0 });
        if (current.capability?.basis && config.basis !== current.capability.basis)
            throw new PricingPublishError('pricing_cost_basis', '基础报价的计量单位与模型不一致。');
        return { model_id: draft.model_id, tier: catalog.tier.key, expected_revision: draft.expected_revision, config };
    });
}

export function groupScopeFromCatalog(catalog: PricingGroupCatalog): PricingCostGroupScope {
    const configs = catalog.models.map((row) => row.config);
    if (!configs.length || configs.some((config) => !config || config.retail_multiplier === undefined))
        throw new PricingPublishError('pricing_group_cost_missing', '请先填写整组充值比例与倍率，再预览价格。');
    const first = configs[0]!;
    const ratio = getCostQuoteDisplay(first).unitRetail;
    if (
        configs.some(
            (config) =>
                config!.currency !== first.currency ||
                config!.credits_per_cny !== first.credits_per_cny ||
                config!.upstream_multiplier !== first.upstream_multiplier ||
                config!.retail_multiplier !== first.retail_multiplier,
        )
    )
        throw new PricingPublishError('pricing_group_cost_changed', '该档次的成本参数不一致，请重新保存整组参数。');
    return { tier: catalog.tier.key, newapi_group: catalog.tier.newapi_group, retail_ratio: ratio };
}

export function assertGroupSavedSelection(catalog: PricingGroupCatalog, selections: PricingCostSelection[]) {
    const models = selections.map((selection) => {
        const model = catalog.models.find((row) => row.saved_rule_id === selection.rule_id);
        if (!model || model.saved_revision !== selection.revision)
            throw new PricingPublishError('pricing_cost_revision', '本次预览的成本版本已变化，请重新预览。');
        return model.model_id!;
    });
    assertGroupCoverage(catalog, models);
}
