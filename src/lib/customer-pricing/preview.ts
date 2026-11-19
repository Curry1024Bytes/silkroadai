import type { OfficialContext } from './context';
import type { NativeModelPrice, OfficialCustomerRule, OfficialPricingDraft, OfficialPricingPreview } from './types';
import {
    compileOfficialRatio,
    CustomerPricingError,
    fingerprint,
    internalModelGroup,
    officialMultiplierOf,
    roundPrice,
    selectOfficialRule,
} from './math';

export function rulesAfterDraft(rules: OfficialCustomerRule[], draft: OfficialPricingDraft): OfficialCustomerRule[] {
    const prior = rules.find((r) => r.tier_key === draft.tier_key && r.model_id === draft.model_id);
    const next = rules.filter((r) => r !== prior);
    if (draft.official_multiplier !== null)
        next.push({
            id: prior?.id ?? 'draft',
            tier_key: draft.tier_key,
            model_id: draft.model_id,
            official_multiplier: draft.official_multiplier,
            revision: (prior?.revision ?? 0) + 1,
        });
    return next;
}

export function compileCustomerPreview(context: OfficialContext, draft: OfficialPricingDraft, affectedKeys: number) {
    const tier = context.tiers.find((t) => t.key === draft.tier_key);
    if (!tier) throw new CustomerPricingError('tier_missing', '该分组不可用。', 404);
    if (draft.model_id && !tier.models.some((m) => m.model_id === draft.model_id))
        throw new CustomerPricingError('model_missing', '模型不属于所选分组。', 400);
    if (
        draft.official_multiplier !== null &&
        (!Number.isFinite(draft.official_multiplier) ||
            draft.official_multiplier <= 0 ||
            draft.official_multiplier > 100)
    )
        throw new CustomerPricingError('invalid_multiplier', '官方价倍率须大于 0 且不超过 100。', 400);
    const rules = rulesAfterDraft(context.rules, draft);
    const cells: OfficialPricingPreview['cells'] = [];
    const blocked: string[] = [];
    const warnings: string[] = [];
    const models: NativeModelPrice[] = [];
    if (!tier.models.length) blocked.push('该分组没有可售模型。');
    if (tier.binding_status && tier.binding_status !== 'active')
        blocked.push('该客户有未核验完成的专属定价，请先恢复发布。');
    const names = new Set<string>();
    for (const model of tier.models) {
        if (names.has(model.model_name)) blocked.push(`多个目录模型共用 ${model.model_name}，无法分别定价。`);
        names.add(model.model_name);
        const rule = selectOfficialRule(rules, tier.key, model.model_id);
        let ratio = tier.legacy_multiplier ?? tier.public_ratio;
        try {
            if (!model.source_channel_ids.length)
                throw new CustomerPricingError('channel_missing', '没有可用来源渠道。');
            if (rule) ratio = compileOfficialRatio(model, rule.official_multiplier);
            if (!(ratio > 0)) throw new CustomerPricingError('ratio_missing', '当前计费倍率无效。');
        } catch (error) {
            blocked.push(`${model.display_name}：${error instanceof Error ? error.message : '不能确定客户价。'}`);
        }
        const existing = context.registry.find((g) => g.tier_key === tier.key && g.model_id === model.model_id);
        models.push({
            model_id: model.model_id,
            model_name: model.model_name,
            group: existing?.internal_group ?? internalModelGroup(tier.key, model.model_id),
            public_ratio: tier.public_ratio,
            customer_ratio: ratio,
            source_channel_ids: model.source_channel_ids,
            replica_channel_ids: existing?.replica_channel_ids ?? [],
            ...(existing?.source_fingerprint ? { source_fingerprint: existing.source_fingerprint } : {}),
        });
        const scope = rule ? (rule.model_id ? 'model' : 'tier') : tier.legacy_multiplier !== null ? 'legacy' : null;
        for (const cell of model.cells) {
            const actual = roundPrice(cell.base_cny * ratio);
            cells.push({
                model_id: model.model_id,
                model_name: model.display_name,
                label: cell.label,
                unit: cell.unit,
                official_cny: cell.official_cny,
                cost_cny: cell.cost_cny,
                before_cny: roundPrice(cell.base_cny * model.current_ratio),
                target_cny: rule ? roundPrice(cell.official_cny * rule.official_multiplier) : actual,
                actual_cny: actual,
                margin: cell.cost_cny === null || actual === 0 ? null : (actual - cell.cost_cny) / actual,
                rule_scope: scope,
                official_multiplier: rule?.official_multiplier ?? officialMultiplierOf(model.cells, ratio),
            });
        }
    }
    if (cells.some((c) => c.cost_cny === null)) warnings.push('部分模型未登记可靠采购成本，毛利显示为未知。');
    if (cells.some((c) => Math.abs(c.actual_cny - c.target_cny) > 1e-9))
        warnings.push('内部倍率保留 12 位小数，预览列出了实际单价。每笔请求还按 quota 粒度取整。');
    if (tier.legacy_multiplier !== null)
        warnings.push(`未命中新官方价规则的模型继续沿用原有 ${tier.legacy_multiplier} 分组倍率。`);
    warnings.push('仅同步该客户在当前分组的 Key，Key 字符串和其他分组的 Key 保持不变。');
    const preview: OfficialPricingPreview = {
        version: context.version,
        hash: fingerprint({ version: context.version, draft, models, cells }),
        draft,
        cells,
        below_cost: cells.some((c) => c.cost_cny !== null && c.actual_cny < c.cost_cny - 1e-9),
        has_increases: cells.some((c) => c.actual_cny > c.before_cny + 1e-9),
        blocked: [...new Set(blocked)],
        warnings,
        affected_keys: affectedKeys,
    };
    // A legacy multiplier is still an active customer-price contract. Removing the
    // last new-style rule must republish the native customer group so that models
    // continue using that legacy factor; only a tier with neither rule type can be
    // restored to the public group.
    return {
        preview,
        models,
        rules,
        tier,
        restoring: !rules.some((r) => r.tier_key === tier.key) && tier.legacy_multiplier === null,
    };
}
