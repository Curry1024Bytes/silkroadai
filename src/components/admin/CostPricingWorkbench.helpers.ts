import type {
    PricingCostCapability,
    PricingCostConfig,
    PricingCostLine,
    PricingCostSelection,
    StoredPricingCostRule,
} from '@/lib/admin/pricing-cost-types';
import type { PricingPublishJob, PricingPublishPreview } from '@/lib/admin/pricing-publish-types';
import { getCostRetailMultiplier } from '@/lib/admin/pricing-cost';
import type { PricingReferenceSelection } from './PricingReferencePicker';
import { parseTieredPricingDetails } from '@/lib/models/tiered-pricing-details';

/** A partial tiered response must never appear as a complete price confirmation. */
export function costPricingPreviewBlock(preview: PricingPublishPreview, en = false): string | null {
    if (preview.publication_mode !== 'tiered_token') return null;
    const invalid = en
        ? 'Tiered pricing details are incomplete. Preview again before confirming publication.'
        : '阶梯价格详情不完整，请重新预览后再确认发布。';
    const matchedDetails = (before: unknown, after: unknown) => {
        const previous = parseTieredPricingDetails(before);
        const next = parseTieredPricingDetails(after);
        if (!previous || !next || previous.tiers.length !== next.tiers.length) return false;
        return next.tiers.every((tier, index) => {
            const old = previous.tiers[index];
            return (
                old.name === tier.name &&
                old.min_input_tokens === tier.min_input_tokens &&
                old.max_input_tokens === tier.max_input_tokens &&
                old.min_inclusive === tier.min_inclusive &&
                old.max_inclusive === tier.max_inclusive
            );
        });
    };
    try {
        if (!preview.rows.length || !Array.isArray(preview.customer_overrides)) return invalid;
        if (preview.rows.some((row) => !matchedDetails(row.before_details, row.after_details))) return invalid;
        if (
            preview.customer_overrides.some(
                (row) =>
                    !row.group ||
                    !Number.isFinite(row.ratio) ||
                    row.ratio < 0 ||
                    !Number.isFinite(row.public_ratio) ||
                    row.public_ratio <= 0 ||
                    !Number.isInteger(row.count) ||
                    row.count < 1 ||
                    !matchedDetails(row.before, row.after),
            )
        )
            return invalid;
    } catch {
        return invalid;
    }
    return null;
}

export interface CostPricingDraft {
    basis: PricingCostConfig['basis'];
    currency: PricingCostConfig['currency'];
    credits_per_cny: string;
    upstream_multiplier: string;
    retail_multiplier: string;
    /** Keep existing percentage rules exact until either multiplier is edited. */
    legacy_multiplier?: {
        upstream_multiplier: number;
        markup_percent: number;
        retail_multiplier: string;
    };
    markup_percent: string;
    source_note: string;
    token_rates: Record<keyof PricingCostConfig['token_rates'], string>;
    variants: Array<
        Omit<PricingCostConfig['variants'][number], 'price' | 'minimum_units' | 'step_units'> & {
            price: string;
            minimum_units: string;
            step_units: string;
        }
    >;
}

export interface CostPricingSaveInput {
    model_id: string;
    tier: string;
    expected_revision: number | null;
    config: PricingCostConfig;
}

/** The picker explicitly confirms the supplier's USD-number-to-credit basis. */
export function draftWithReference(draft: CostPricingDraft, price: PricingReferenceSelection): CostPricingDraft {
    const note = `${price.sourceLabel} · ${price.model} · ${price.fetchedAt} · USD 基准数字按上游额度计价；普通档，阶梯另行核对；缓存写入为 5 分钟。`;
    return {
        ...draft,
        currency: 'credits',
        credits_per_cny: draft.currency === 'credits' ? draft.credits_per_cny : '',
        token_rates: {
            input: String(price.input),
            output: String(price.output),
            cache_read: price.cache_read === null ? '' : String(price.cache_read),
            cache_write: price.cache_write === null ? '' : String(price.cache_write),
        },
        source_note: `${note}\n${draft.source_note}`.trim().slice(0, 500),
    };
}

export interface CostPricingPrepared {
    selections: PricingCostSelection[];
    preview: PricingPublishPreview;
    selection_token: string;
    cost_rows: Array<Omit<PricingCostLine, 'key'> & { model_id: string; tier: string; variant_key?: string }>;
}

export interface CostReviewState {
    prepared: CostPricingPrepared | null;
    confirmed: boolean;
}

/** A new edit or selection always discards both signed tokens and acknowledgement. */
export function costReviewReducer(
    state: CostReviewState,
    action:
        | { type: 'invalidate' }
        | { type: 'prepare'; prepared: CostPricingPrepared }
        | { type: 'confirm'; confirmed: boolean },
): CostReviewState {
    if (action.type === 'invalidate') return { prepared: null, confirmed: false };
    if (action.type === 'prepare') return { prepared: action.prepared, confirmed: false };
    return {
        ...state,
        confirmed: state.prepared !== null && !costPricingPreviewBlock(state.prepared.preview) && action.confirmed,
    };
}

export function newCostDraft(capability?: PricingCostCapability): CostPricingDraft {
    const basis = capability?.basis === 'image' || capability?.basis === 'video' ? capability.basis : 'token';
    return {
        basis,
        currency: 'cny',
        credits_per_cny: '',
        upstream_multiplier: '',
        retail_multiplier: '',
        markup_percent: '',
        source_note: '',
        token_rates: { input: '', output: '', cache_read: '', cache_write: '' },
        variants:
            basis === 'token'
                ? []
                : [
                      {
                          key: 'standard',
                          label: capability?.resolution ?? '',
                          resolution: capability?.resolution ?? 'default',
                          audio: 'any',
                          reference_video: 'any',
                          price: '',
                          // Image quantities count complete images. Video rounding must be supplied by the operator.
                          minimum_units: basis === 'image' ? '1' : '',
                          step_units: basis === 'image' ? '1' : '',
                      },
                  ],
    };
}

export function draftFromCostConfig(config: PricingCostConfig): CostPricingDraft {
    const retail = String(getCostRetailMultiplier(config));
    return {
        ...config,
        credits_per_cny: String(config.credits_per_cny),
        upstream_multiplier: String(config.upstream_multiplier),
        retail_multiplier: retail,
        ...(config.retail_multiplier === undefined
            ? {
                  legacy_multiplier: {
                      upstream_multiplier: config.upstream_multiplier,
                      markup_percent: config.markup_percent,
                      retail_multiplier: retail,
                  },
              }
            : {}),
        markup_percent: String(config.markup_percent),
        token_rates: Object.fromEntries(
            Object.entries(config.token_rates).map(([key, value]) => [key, value === null ? '' : String(value)]),
        ) as CostPricingDraft['token_rates'],
        variants: config.variants.map((variant) => ({
            ...variant,
            price: String(variant.price),
            minimum_units: String(variant.minimum_units),
            step_units: String(variant.step_units),
        })),
    };
}

/** Empty inputs never turn into zero prices or assumed supplier multipliers. */
export function costConfigFromDraft(draft: CostPricingDraft): PricingCostConfig | null {
    const number = (value: string): number | null =>
        value.trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value);
    const upstream = number(draft.upstream_multiplier);
    const retail = number(draft.retail_multiplier);
    const credits = draft.currency === 'cny' ? 1 : number(draft.credits_per_cny);
    if (upstream === null || upstream <= 0 || retail === null || retail < upstream || credits === null || credits <= 0)
        return null;
    const legacy = draft.legacy_multiplier;
    const keepLegacy =
        legacy !== undefined &&
        upstream === legacy.upstream_multiplier &&
        draft.retail_multiplier.trim() === legacy.retail_multiplier &&
        number(draft.markup_percent) === legacy.markup_percent;
    const tokenRates = Object.fromEntries(
        Object.entries(draft.token_rates).map(([key, value]) => [key, number(value)]),
    ) as PricingCostConfig['token_rates'];
    if (draft.basis === 'token' && (tokenRates.input === null || tokenRates.output === null)) return null;
    if (
        draft.basis === 'token' &&
        Object.entries(draft.token_rates).some(
            ([key, value]) =>
                value.trim() !== '' &&
                (tokenRates[key as keyof typeof tokenRates] === null ||
                    tokenRates[key as keyof typeof tokenRates]! < 0),
        )
    )
        return null;
    const variants: PricingCostConfig['variants'] = [];
    if (draft.basis !== 'token') {
        if (draft.variants.length === 0) return null;
        for (const variant of draft.variants) {
            const price = number(variant.price);
            const minimum = number(variant.minimum_units);
            const step = number(variant.step_units);
            if (price === null || price < 0 || minimum === null || minimum <= 0 || step === null || step <= 0)
                return null;
            variants.push({
                ...variant,
                label: variant.label.trim() || variant.resolution.trim() || '默认规格',
                price,
                minimum_units: minimum,
                step_units: step,
            });
        }
    }
    return {
        version: 1,
        basis: draft.basis,
        currency: draft.currency,
        credits_per_cny: credits,
        upstream_multiplier: upstream,
        markup_percent: keepLegacy ? legacy.markup_percent : 0,
        ...(!keepLegacy ? { retail_multiplier: retail } : {}),
        source_note: draft.source_note,
        token_rates:
            draft.basis === 'token' ? tokenRates : { input: null, output: null, cache_read: null, cache_write: null },
        variants,
    };
}

export function costRuleSelections(rules: StoredPricingCostRule[], selectedIds: string[]): PricingCostSelection[] {
    const selected = new Set(selectedIds);
    return rules
        .filter((rule) => selected.has(rule.id))
        .map((rule) => ({
            rule_id: rule.id,
            revision: rule.revision,
            ...(rule.config.basis !== 'token' && rule.config.variants.length === 1
                ? { variant_key: rule.config.variants[0].key }
                : {}),
        }))
        .sort((a, b) => a.rule_id.localeCompare(b.rule_id));
}

export function costRulePublishBlock(
    rule: Pick<StoredPricingCostRule, 'mapping_current' | 'config'>,
    capability: PricingCostCapability | undefined,
    en = false,
): string | null {
    if (!rule.mapping_current)
        return en
            ? 'The registered channel changed. Review and save the cost again.'
            : '登记渠道已变化，请核对并重新保存成本。';
    if (!capability?.publishable)
        return (
            capability?.reason ||
            (en
                ? 'Estimation and saving are available. Publication is not supported yet.'
                : '可保存和试算，当前未支持发布。')
        );
    if (rule.config.basis !== capability.basis)
        return en ? 'The cost basis no longer matches the billing rule.' : '成本单位与当前计费规则不一致，请重新核对。';
    if (
        rule.config.basis === 'token' &&
        (rule.config.token_rates.cache_read !== null || rule.config.token_rates.cache_write !== null)
    ) {
        if (capability.publication_mode === 'tiered_token') {
            if (rule.config.token_rates.cache_write !== null)
                return en
                    ? 'This tiered rule supports cache-read publication. Cache-write publication is not supported.'
                    : '本阶梯规则支持发布缓存读取价；缓存写入价格暂不支持发布。';
        } else
            return en
                ? 'Cache costs can be saved and estimated. Cache price publication is not supported yet.'
                : '缓存成本可保存和试算；当前尚未支持缓存价格发布。';
    }
    if (rule.config.basis !== 'token' && rule.config.variants.length !== 1)
        return en
            ? 'Multiple specifications can be saved; this model cannot publish them separately yet.'
            : '可保存多个规格；当前模型还不能分别发布多个规格价格。';
    if (rule.config.basis === 'image') {
        const variant = rule.config.variants[0];
        if (variant.minimum_units !== 1 || variant.step_units !== 1)
            return en
                ? 'Image publication currently requires billing one image at a time.'
                : '当前图片发布仅支持逐张计费，请将最低张数和步长设为 1。';
        const expectedResolution = capability.resolution?.trim().toLowerCase() ?? 'default';
        const resolution = variant.resolution.trim().toLowerCase();
        const matches = capability.resolution
            ? resolution === expectedResolution
            : ['standard', 'default', 'any', '通用', '默认'].includes(resolution);
        if (!matches)
            return en
                ? `This model supports publication only for resolution ${expectedResolution}.`
                : `当前模型仅支持发布 ${expectedResolution} 规格，请核对分辨率。`;
    }
    return null;
}

async function costRequest(path: string, body: object, en: boolean): Promise<Record<string, unknown>> {
    const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new Error(
            typeof data.message === 'string'
                ? data.message
                : response.status === 401
                  ? en
                      ? 'Your session expired. Please sign in again.'
                      : '登录已过期，请重新登录。'
                  : en
                    ? 'The request could not be completed. Reload and check the saved status before retrying.'
                    : '请求未完成，请重新加载核对保存或任务状态后再操作。',
        );
    return data;
}

export async function saveCostPricingRules(
    inputs: CostPricingSaveInput[],
    en = false,
): Promise<StoredPricingCostRule[]> {
    const snapshot = JSON.parse(JSON.stringify(inputs)) as CostPricingSaveInput[];
    const data =
        snapshot.length === 1
            ? await costRequest('/api/admin/pricing/cost-rules', snapshot[0], en)
            : await costRequest('/api/admin/pricing/cost-rules/bulk', { rules: snapshot }, en);
    const rules = snapshot.length === 1 ? [data.rule] : data.rules;
    if (
        !Array.isArray(rules) ||
        rules.length !== inputs.length ||
        rules.some((rule) => !rule?.id || !Number.isInteger(rule.revision) || !rule.config)
    )
        throw new Error(en ? 'Invalid saved-cost response. Reload to verify.' : '保存响应不完整，请重新加载核对成本。');
    return rules as StoredPricingCostRule[];
}

export async function requestCostPricingPreview(
    selections: PricingCostSelection[],
    en = false,
    expectedMode?: 'tiered_token',
): Promise<CostPricingPrepared> {
    const snapshot = selections.map((selection) => ({ ...selection }));
    const data = await costRequest(
        '/api/admin/pricing/cost-rules/publish',
        { action: 'preview', selections: snapshot },
        en,
    );
    const preview = data.preview as PricingPublishPreview | undefined;
    if (
        !preview?.preview_token ||
        !Number.isFinite(Date.parse(preview.expires_at)) ||
        !Array.isArray(preview.rows) ||
        !Array.isArray(preview.warnings) ||
        typeof data.selection_token !== 'string' ||
        !data.selection_token ||
        !Array.isArray(data.cost_rows)
    )
        throw new Error(en ? 'Invalid preview. Please preview again.' : '预览响应不完整，请重新预览。');
    const block = costPricingPreviewBlock(preview, en);
    if (block) throw new Error(block);
    if (expectedMode === 'tiered_token' && preview.publication_mode !== expectedMode)
        throw new Error(en ? 'Tiered pricing preview is missing.' : '未返回完整阶梯价格预览。');
    return {
        selections: snapshot,
        preview,
        selection_token: data.selection_token,
        cost_rows: data.cost_rows as CostPricingPrepared['cost_rows'],
    };
}

/** Save the editor, then preview only that returned revision; never publish here. */
export async function prepareSingleCostPricing({
    input,
    savedRule,
    capability,
    onSaved,
    en = false,
}: {
    input: CostPricingSaveInput | null;
    savedRule?: StoredPricingCostRule;
    capability: PricingCostCapability | undefined;
    onSaved: (rule: StoredPricingCostRule) => void;
    en?: boolean;
}): Promise<CostPricingPrepared> {
    let rule = savedRule;
    let didSave = false;
    if (input) {
        [rule] = await saveCostPricingRules([input], en);
        didSave = true;
        onSaved(rule);
    }
    try {
        if (!rule) throw new Error(en ? 'Save the cost rule first.' : '请先保存成本规则。');
        const block = costRulePublishBlock(rule, capability, en);
        if (block) throw new Error(block);
        return await requestCostPricingPreview(costRuleSelections([rule], [rule.id]), en, capability?.publication_mode);
    } catch (error) {
        if (!didSave) throw error;
        const detail = error instanceof Error ? error.message : '';
        throw new Error(
            en
                ? `Cost saved; publication preview failed. Customer prices are unchanged. ${detail}`
                : `成本已保存，发布预览未完成，客户售价未变。${detail}`,
        );
    }
}

export async function publishCostPricingReview(prepared: CostPricingPrepared, en = false): Promise<PricingPublishJob> {
    const block = costPricingPreviewBlock(prepared.preview, en);
    if (block) throw new Error(block);
    if (Date.parse(prepared.preview.expires_at) <= Date.now())
        throw new Error(en ? 'The preview expired. Please preview again.' : '预览已过期，请重新预览。');
    const data = await costRequest(
        '/api/admin/pricing/cost-rules/publish',
        {
            action: 'publish',
            selections: prepared.selections,
            selection_token: prepared.selection_token,
            preview_token: prepared.preview.preview_token,
        },
        en,
    );
    const job = data.job as PricingPublishJob | undefined;
    if (!job?.id || !job.status)
        throw new Error(
            en
                ? 'The task response is incomplete. Check Publication tasks before retrying.'
                : '任务响应不完整，请先检查发布任务，避免重复操作。',
        );
    return job;
}
