import type { PricingCostConfig, PricingCostSelection, StoredPricingCostRule } from '@/lib/admin/pricing-cost-types';
import type { PricingGroupCatalog, PricingGroupModel } from '@/lib/admin/pricing-group-types';
import type { PricingPublishJob } from '@/lib/admin/pricing-publish-types';
import { calculateCostPricing, pricingCostConfigSchema } from '@/lib/admin/pricing-cost';
import { costConfigFromDraft, type CostPricingDraft, type CostPricingPrepared } from './CostPricingWorkbench.helpers';

export interface GroupSettingsDraft {
    currency: PricingCostConfig['currency'];
    credits_per_cny: string;
    upstream_multiplier: string;
    retail_multiplier: string;
}
export type GroupModelDrafts = Record<string, CostPricingDraft>;
export interface GroupPricingPrepared extends CostPricingPrepared {
    group_id: string;
    catalog_fingerprint: string;
    rules: StoredPricingCostRule[];
}
export interface GroupPreviewInput {
    action: 'preview';
    group_id: string;
    catalog_fingerprint: string;
    settings: {
        currency: PricingCostConfig['currency'];
        credits_per_cny: number;
        upstream_multiplier: number;
        retail_multiplier: number;
    };
    models: Array<{
        model_id: string;
        expected_revision: number | null;
        config: PricingCostConfig;
        variant_key?: string;
    }>;
}

/** Discovery includes incomplete quotes so the operator can complete them. Do not run
 * the stored-rule validator while converting those partial rates to editable inputs. */
function groupQuoteDraft(config: PricingCostConfig): CostPricingDraft {
    return {
        ...config,
        credits_per_cny: String(config.credits_per_cny),
        upstream_multiplier: String(config.upstream_multiplier),
        retail_multiplier: String(
            config.retail_multiplier ?? config.upstream_multiplier * (1 + config.markup_percent / 100),
        ),
        markup_percent: String(config.markup_percent),
        token_rates: Object.fromEntries(
            Object.entries(config.token_rates).map(([key, value]) => [key, value == null ? '' : String(value)]),
        ) as CostPricingDraft['token_rates'],
        variants: config.variants.map((row) => ({
            ...row,
            price: Number.isFinite(row.price) ? String(row.price) : '',
            minimum_units: String(row.minimum_units),
            step_units: String(row.step_units),
        })),
    };
}

export function groupInitialDrafts(catalog: PricingGroupCatalog): GroupModelDrafts {
    return Object.fromEntries(
        catalog.models.flatMap((model) => {
            if (!model.config) return [];
            const draft = groupQuoteDraft(model.config);
            if (model.selectable && draft.basis === 'image' && draft.variants.length === 0) {
                const resolution = model.capability?.resolution?.trim().toLowerCase() || 'standard';
                draft.variants = [
                    {
                        key: resolution,
                        label: resolution === 'standard' ? '标准' : resolution.toUpperCase(),
                        resolution,
                        audio: 'any',
                        reference_video: 'any',
                        price: '',
                        minimum_units: '1',
                        step_units: '1',
                    },
                ];
            }
            return [[model.id, draft]];
        }),
    );
}

export function groupInitialSettings(catalog: PricingGroupCatalog): GroupSettingsDraft {
    const saved = catalog.models
        .filter((model) => model.base_source === 'saved' && model.config)
        .map((model) => groupQuoteDraft(model.config!));
    const shared = (key: keyof GroupSettingsDraft) => {
        const values = [...new Set(saved.map((draft) => draft[key]))];
        return values.length === 1 ? String(values[0]) : '';
    };
    const currency = shared('currency') === 'cny' ? 'cny' : 'credits';
    return {
        currency,
        credits_per_cny: currency === 'cny' ? '1' : shared('credits_per_cny'),
        upstream_multiplier: shared('upstream_multiplier'),
        retail_multiplier: shared('retail_multiplier'),
    };
}

function positive(value: string): number | null {
    if (!value.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

export function groupSettingsValue(draft: GroupSettingsDraft): GroupPreviewInput['settings'] | null {
    const credits = draft.currency === 'cny' ? 1 : positive(draft.credits_per_cny);
    const upstream = positive(draft.upstream_multiplier);
    const retail = positive(draft.retail_multiplier);
    if (credits === null || upstream === null || retail === null || retail < upstream) return null;
    return {
        currency: draft.currency,
        credits_per_cny: credits,
        upstream_multiplier: upstream,
        retail_multiplier: retail,
    };
}

export function groupModelConfig(
    model: PricingGroupModel,
    draft: CostPricingDraft | undefined,
    settings: GroupSettingsDraft,
): PricingCostConfig | null {
    if (!model.model_id || !model.selectable || !draft) return null;
    const shared = groupSettingsValue(settings);
    if (!shared) return null;
    const raw = costConfigFromDraft({
        ...draft,
        ...Object.fromEntries(Object.entries(shared).map(([key, value]) => [key, String(value)])),
        currency: shared.currency,
        markup_percent: '0',
        legacy_multiplier: undefined,
    });
    const parsed = pricingCostConfigSchema.safeParse(raw);
    if (!parsed.success) return null;
    if (
        model.capability?.required_token_rates?.some(
            (key) => parsed.data.token_rates[key] === null || parsed.data.token_rates[key] === undefined,
        )
    )
        return null;
    try {
        calculateCostPricing(parsed.data);
    } catch {
        return null;
    }
    return parsed.data;
}

export function groupModelIssue(
    model: PricingGroupModel,
    draft: CostPricingDraft | undefined,
    settings: GroupSettingsDraft,
    en = false,
): string | null {
    if (!model.model_id || !model.selectable)
        return (
            model.reason ||
            (en ? 'Complete the model registration or pricing support first.' : '请先完成模型登记或处理计费支持。')
        );
    if (!draft) return en ? 'Missing base quote.' : '缺少基础报价。';
    // Assess model quotes independently from shared settings, so the list remains useful before settings are filled.
    const safeSettings = groupSettingsValue(settings)
        ? settings
        : {
              currency: draft.currency,
              credits_per_cny: draft.currency === 'cny' ? '1' : '1',
              upstream_multiplier: '1',
              retail_multiplier: '1',
          };
    if (!groupModelConfig(model, draft, safeSettings))
        return en ? 'Complete the base quote and required cache rates.' : '请补齐基础报价及必需的缓存价格。';
    return null;
}

export function groupPreviewInput(
    catalog: PricingGroupCatalog,
    drafts: GroupModelDrafts,
    settings: GroupSettingsDraft,
): GroupPreviewInput | null {
    const shared = groupSettingsValue(settings);
    if (!shared || !catalog.models.length || catalog.models.length > 30) return null;
    const models: GroupPreviewInput['models'] = [];
    for (const row of catalog.models) {
        const config = groupModelConfig(row, drafts[row.id], settings);
        if (!config || !row.model_id || models.some((model) => model.model_id === row.model_id)) return null;
        models.push({
            model_id: row.model_id,
            expected_revision: row.saved_revision,
            config,
            ...(config.basis === 'image' && config.variants.length === 1
                ? { variant_key: config.variants[0].key }
                : {}),
        });
    }
    return {
        action: 'preview',
        group_id: catalog.tier.id,
        catalog_fingerprint: catalog.fingerprint,
        settings: shared,
        models,
    };
}

export class GroupPricingRequestError extends Error {
    constructor(
        message: string,
        public saved: { rules?: StoredPricingCostRule[]; catalog_fingerprint?: string },
    ) {
        super(message);
    }
}

async function groupPost(body: object, en: boolean) {
    const response = await fetch('/api/admin/pricing/group-workbench', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new GroupPricingRequestError(
            typeof data.message === 'string'
                ? data.message
                : en
                  ? 'Unable to complete the request. Reload the group and try again.'
                  : '请求未完成，请重新读取档次后重试。',
            data,
        );
    return data;
}

export async function requestGroupPricingPreview(input: GroupPreviewInput, en = false): Promise<GroupPricingPrepared> {
    const data = await groupPost(input, en);
    if (
        !data.preview?.preview_token ||
        !Number.isFinite(Date.parse(data.preview.expires_at)) ||
        !Array.isArray(data.preview.rows) ||
        !data.preview.rows.length ||
        !Array.isArray(data.preview.warnings) ||
        typeof data.selection_token !== 'string' ||
        !Array.isArray(data.selections) ||
        data.selections.length !== input.models.length ||
        !Array.isArray(data.cost_rows) ||
        !Array.isArray(data.rules)
    )
        throw new GroupPricingRequestError(
            en ? 'Incomplete group preview. Reload and try again.' : '整组预览结果不完整，请重新读取后再试。',
            data,
        );
    const selections = data.selections as PricingCostSelection[];
    if (
        new Set(selections.map((row) => row.rule_id)).size !== input.models.length ||
        data.rules.length !== input.models.length ||
        input.models.some(
            (row) =>
                !data.rules.some(
                    (rule: StoredPricingCostRule) =>
                        rule.model_id === row.model_id &&
                        selections.some(
                            (selected) => selected.rule_id === rule.id && selected.revision === rule.revision,
                        ),
                ),
        )
    )
        throw new GroupPricingRequestError(
            en ? 'The preview does not cover every group model.' : '预览未包含本档次全部模型，请重新读取。',
            data,
        );
    if (typeof data.catalog_fingerprint !== 'string' || !data.catalog_fingerprint)
        throw new GroupPricingRequestError(
            en ? 'Missing saved group revision. Reload the group.' : '缺少保存后的档次版本，请重新读取档次。',
            data,
        );
    return { ...data, group_id: input.group_id, catalog_fingerprint: data.catalog_fingerprint };
}

export async function publishGroupPricing(prepared: GroupPricingPrepared, en = false): Promise<PricingPublishJob> {
    if (Date.parse(prepared.preview.expires_at) <= Date.now())
        throw new Error(en ? 'Preview expired. Preview the group again.' : '预览已过期，请重新预览整组价格。');
    const data = await groupPost(
        {
            action: 'publish',
            group_id: prepared.group_id,
            catalog_fingerprint: prepared.catalog_fingerprint,
            selections: prepared.selections,
            preview_token: prepared.preview.preview_token,
            selection_token: prepared.selection_token,
        },
        en,
    );
    if (!data.job?.id || !data.job?.status)
        throw new Error(
            en
                ? 'Publication response was incomplete. Check Publication tasks before retrying.'
                : '发布响应不完整，请先查看发布任务状态。',
        );
    return data.job;
}
