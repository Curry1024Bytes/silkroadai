import 'server-only';
import { createHash } from 'node:crypto';
import { CHAT_FX, IMAGE_FX, computeRatios } from '@/lib/newapi/pricing-sync';
import { QUOTA_PER_USD } from '@/lib/newapi/quota-units';
import { readSyncPrice } from '@/lib/newapi/catalog-sync-prices';
import { ChannelGroupTopology, type UpstreamMapLike } from '@/lib/channel-group-topology';
import { canonicalSync } from './newapi-sync-plan';
import type { SyncChannel } from './newapi-sync-source';
import type { PricingPublishAmounts, PricingPublishInput, PricingPublishPreviewRow } from './pricing-publish-types';
import { PricingPublishError } from './pricing-publish-lock';
import type { CostBatchContext } from './pricing-cost-publication-guard';
import type { UniformPublishPlan, CacheUniformPublishPlan } from './pricing-uniform-plan';
import type { GroupPublishPlan } from './pricing-group-plan';
import type { GroupRatioPublishPlan } from './pricing-group-ratio-plan';
import type { TieredPublishPlan } from './pricing-tiered-plan';
import type { GlobalModelBaseInput } from './global-model-pricing-types';

export const PRICE_KEYS = ['ModelRatio', 'CompletionRatio', 'ModelPrice', 'GroupRatio'] as const;
export type PriceKey = (typeof PRICE_KEYS)[number];
export type WritePriceKey = Exclude<PriceKey, 'GroupRatio'>;
export type PriceOptions = Record<PriceKey, Record<string, unknown>>;
export interface PublishSource {
    options: Record<string, unknown>;
    channels: SyncChannel[];
}
export interface PublishState {
    models: Array<{
        id: string;
        tenant_id: string | null;
        slug: string;
        display_name: string;
        modality: string;
        enabled: boolean;
        upstream_map: unknown;
        updated_at: string;
    }>;
    groups: Array<{
        id: string;
        tenant_id: string | null;
        key: string;
        display_name: string;
        newapi_group: string;
        enabled: boolean;
        is_default: boolean;
        tier_level: number;
        newapi_channel_ids: number[];
        updated_at: string;
    }>;
    prices: Array<
        PricingPublishAmounts & {
            id: string;
            model_id: string;
            tier: string;
            effective_from: string;
            cost_cny_per_1m: number | null;
        }
    >;
}
export interface PublishPlan {
    version: 1;
    input: PricingPublishInput;
    upstream_model: string;
    tenant_id: string | null;
    basis: 'token' | 'request';
    rows: Array<PricingPublishPreviewRow & { cost_cny_per_1m: number | null }>;
    warnings: string[];
    baseline: PriceOptions;
    target: Partial<Record<WritePriceKey, number>>;
    source_guard: string;
    catalog_guard: string;
    units: { chat_fx: number; image_fx: number; quota_per_usd: number };
}

export interface PublishBatchPlan extends Omit<PublishPlan, 'version' | 'input' | 'target'> {
    version: 2;
    inputs: PricingPublishInput[];
    upstream_models: Array<{ name: string; basis: 'token' | 'request' }>;
    target: Partial<Record<WritePriceKey, Record<string, number>>>;
    cost_context?: CostBatchContext;
    /** Signed marker for the model-global official base-price workflow. */
    global_model?: boolean;
    global_input?: GlobalModelBaseInput;
}
export type AnyPublishPlan =
    | PublishPlan
    | PublishBatchPlan
    | TieredPublishPlan
    | UniformPublishPlan
    | CacheUniformPublishPlan
    | GroupPublishPlan
    | GroupRatioPublishPlan;
export type PublicationWriteKey = WritePriceKey | 'billing_setting.billing_expr' | 'GroupRatio';

/** Normalize legacy intent without changing the persisted v1 contract or signature. */
export function targetDictionaries(
    plan: AnyPublishPlan,
): Partial<Record<PublicationWriteKey, Record<string, number | string>>> {
    return plan.version !== 1
        ? plan.target
        : Object.fromEntries(
              Object.entries(plan.target).map(([key, value]) => [key, { [plan.upstream_model]: value }]),
          );
}

export function fingerprint(value: unknown) {
    return createHash('sha256').update(canonicalSync(value)).digest('hex');
}

export function dictionary(raw: unknown, key: string): Record<string, unknown> {
    let parsed = raw;
    try {
        if (typeof raw === 'string') parsed = JSON.parse(raw);
    } catch {
        parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new PricingPublishError('pricing_options_invalid', `未读到完整的 ${key} 配置，请先核对 new-api。`);
    }
    return parsed as Record<string, unknown>;
}

export function priceOptions(options: Record<string, unknown>): PriceOptions {
    return Object.fromEntries(PRICE_KEYS.map((key) => [key, dictionary(options[key], key)])) as PriceOptions;
}

type OptionalBillingKey = 'ImageResolutionPrice' | 'billing_setting.scheduled_discount';
function optionalBillingDictionary(source: PublishSource, key: OptionalBillingKey) {
    // The verified rc.23 option registry predates these features. Only a truly
    // absent key means unsupported; null, malformed JSON and arrays still fail.
    return Object.hasOwn(source.options, key) ? dictionary(source.options[key], key) : {};
}

function checkedMap(raw: unknown): UpstreamMapLike {
    const map = dictionary(raw, '模型渠道映射');
    for (const entry of Object.values(map)) {
        if (
            !entry ||
            typeof entry !== 'object' ||
            !('channel_id' in entry) ||
            !Number.isSafeInteger(entry.channel_id) ||
            Number(entry.channel_id) <= 0 ||
            !('upstream_model' in entry) ||
            typeof entry.upstream_model !== 'string' ||
            !entry.upstream_model.trim()
        ) {
            throw new PricingPublishError('pricing_mapping_invalid', '模型渠道映射不完整，请先修正模型配置。');
        }
    }
    return map as UpstreamMapLike;
}

export function sourceGuard(source: PublishSource): string {
    // Effective ratio numbers change when a publication writes CompletionRatio;
    // the locked/unlocked contract itself must remain unchanged.
    const meta = dictionary(source.options.CompletionRatioMeta, 'CompletionRatioMeta');
    return fingerprint({
        channels: source.channels,
        group: dictionary(source.options.GroupRatio, 'GroupRatio'),
        quota: source.options.QuotaPerUnit,
        overrides: ['GroupGroupRatio', 'billing_setting.billing_mode'].map((key) => [
            key,
            dictionary(source.options[key], key),
        ]),
        optional_overrides: (['ImageResolutionPrice', 'billing_setting.scheduled_discount'] as const).map((key) => [
            key,
            Object.hasOwn(source.options, key),
            optionalBillingDictionary(source, key),
        ]),
        locks: Object.fromEntries(
            Object.entries(meta).map(([name, value]) => {
                const info = dictionary(value, 'CompletionRatioMeta');
                if (typeof info.locked !== 'boolean')
                    throw new PricingPublishError('pricing_meta_invalid', '输出倍率锁定信息不完整。');
                return [name, info.locked ? info : { locked: false }];
            }),
        ),
    });
}

function completionInfo(source: PublishSource, model: string) {
    const meta = dictionary(source.options.CompletionRatioMeta, 'CompletionRatioMeta');
    const info = dictionary(meta[model], `CompletionRatioMeta/${model}`);
    if (
        typeof info.ratio !== 'number' ||
        !Number.isFinite(info.ratio) ||
        info.ratio < 0 ||
        typeof info.locked !== 'boolean'
    ) {
        throw new PricingPublishError('pricing_meta_invalid', '无法核对该模型的实际输出倍率，尚不能发布。');
    }
    return { ratio: info.ratio, locked: info.locked };
}

export function assertEffectiveCompletion(source: PublishSource, plan: AnyPublishPlan) {
    if (plan.version === 3 || plan.version === 4 || plan.version === 5 || plan.version === 6 || plan.version === 7)
        return; // The runtime expression/group ratio is verified separately.
    if (plan.version === 2) {
        for (const model of plan.upstream_models) {
            if (
                model.basis === 'token' &&
                completionInfo(source, model.name).ratio !== plan.target.CompletionRatio?.[model.name]
            ) {
                throw new PricingPublishError(
                    'pricing_effective_ratio_mismatch',
                    'new-api 实际输出倍率与发布目标不同，目录价格尚未生效。',
                );
            }
        }
        return;
    }
    if (plan.basis === 'token') {
        const info = completionInfo(source, plan.upstream_model);
        if (info.ratio !== plan.target.CompletionRatio) {
            throw new PricingPublishError(
                'pricing_effective_ratio_mismatch',
                'new-api 实际输出倍率与发布目标不同，目录价格尚未生效。',
            );
        }
    }
}

export function buildPublishPlan(
    state: PublishState,
    source: PublishSource,
    input: PricingPublishInput,
    now: number,
    targetOverride?: PublishPlan['target'],
): PublishPlan {
    if (
        input.cache_read_cny_per_1m !== undefined ||
        input.cache_write_cny_per_1m !== undefined ||
        input.cache_write_1h_cny_per_1m !== undefined
    )
        throw new PricingPublishError(
            'pricing_cache_unsupported',
            '缓存售价请通过支持阶梯计费的成本规则发布；普通倍率计费暂不支持单独发布缓存价。',
        );
    const model = state.models.find((row) => row.id === input.model_id);
    if (!model) throw new PricingPublishError('model_not_found', '模型不存在。', 404);
    const entry = checkedMap(model.upstream_map)[input.tier];
    if (!entry) throw new PricingPublishError('pricing_tier_invalid', '该档次没有模型渠道映射。');
    const name = entry.upstream_model;
    const fixedSku = /^gpt-image-2-(1k|2k|4k)$/.test(name) || /^gpt-image-2-(1k|2k|4k)$/.test(model.slug);
    const fixedMode = input.pricing_mode === 'fixed_image';
    if (fixedSku && !fixedMode) {
        throw new PricingPublishError('fixed_sku_price', '该模型使用已约定的固定分辨率价格，不能在通用定价页修改。');
    }
    const baseline = priceOptions(source.options);
    if (model.modality === 'video') {
        throw new PricingPublishError(
            'pricing_video_unsupported',
            '视频时长与规格计费尚不能通过此发布器修改，请保留现有视频价格配置。',
        );
    }
    if (
        fixedMode &&
        (!fixedSku ||
            name !== model.slug ||
            model.modality !== 'image' ||
            !Object.hasOwn(baseline.ModelPrice, name) ||
            typeof baseline.ModelPrice[name] !== 'number' ||
            !Number.isFinite(baseline.ModelPrice[name]) ||
            Number(baseline.ModelPrice[name]) < 0)
    ) {
        throw new PricingPublishError(
            'fixed_sku_invalid',
            '仅能调整已配置按次价格、模型名与上游名完全一致的 1K / 2K / 4K 图片规格。',
        );
    }
    if (
        Number(source.options.QuotaPerUnit) !== QUOTA_PER_USD ||
        !Number.isFinite(CHAT_FX) ||
        CHAT_FX <= 0 ||
        !Number.isFinite(IMAGE_FX) ||
        IMAGE_FX <= 0
    ) {
        throw new PricingPublishError('pricing_units_mismatch', 'Portal 与 new-api 的金额换算配置不一致，请先核对。');
    }
    const basis = Object.hasOwn(baseline.ModelPrice, name) ? 'request' : 'token';
    if ((basis === 'request') !== (input.per_image_cny !== null)) {
        throw new PricingPublishError(
            'pricing_basis_change',
            '本次只能修改现有计费方式下的价格，不能同时切换按次与按 Token 计费。',
        );
    }
    const group = state.groups.find(
        (row) => row.tenant_id === model.tenant_id && row.key === input.tier && row.enabled,
    );
    if (!group) throw new PricingPublishError('pricing_tier_invalid', '档次未启用或未登记。');
    const ratio = baseline.GroupRatio[group.newapi_group];
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) {
        throw new PricingPublishError('pricing_group_invalid', '该档次的 new-api 分组倍率缺失或无效。');
    }
    const modes = dictionary(source.options['billing_setting.billing_mode'], 'billing_setting.billing_mode');
    const discounts = optionalBillingDictionary(source, 'billing_setting.scheduled_discount');
    const resolution = optionalBillingDictionary(source, 'ImageResolutionPrice');
    const discount = discounts[name];
    if (
        (modes[name] != null && modes[name] !== '' && modes[name] !== 'standard' && modes[name] !== 'ratio') ||
        Object.hasOwn(resolution, name) ||
        (discount && typeof discount === 'object' && 'enabled' in discount && discount.enabled === true)
    ) {
        throw new PricingPublishError(
            'pricing_special_rule',
            '该模型存在阶梯、分辨率或定时折扣规则，无法用普通目录价完整表达，请先在 new-api 核对。',
        );
    }
    let target: PublishPlan['target'];
    if (basis === 'request') {
        target = targetOverride ?? { ModelPrice: Number((input.per_image_cny! / (IMAGE_FX * ratio)).toFixed(6)) };
        if (typeof target.ModelPrice !== 'number' || !Number.isFinite(target.ModelPrice) || target.ModelPrice < 0)
            throw new PricingPublishError('pricing_precision', '按次基础价无效。');
        if (input.per_image_cny! > 0 && target.ModelPrice === 0)
            throw new PricingPublishError('pricing_precision', '价格太小，换算后会变为免费，请调整。');
    } else {
        const computed = targetOverride
            ? { model_ratio: targetOverride.ModelRatio, completion_ratio: targetOverride.CompletionRatio }
            : computeRatios(input.input_cny_per_1m!, input.output_cny_per_1m!, ratio);
        if (
            typeof computed.model_ratio !== 'number' ||
            !Number.isFinite(computed.model_ratio) ||
            computed.model_ratio <= 0
        )
            throw new PricingPublishError('pricing_precision', '输入价格必须大于零，且换算后不能变为免费。');
        if (
            typeof computed.completion_ratio !== 'number' ||
            !Number.isFinite(computed.completion_ratio) ||
            computed.completion_ratio < 0 ||
            (input.output_cny_per_1m! > 0 && computed.completion_ratio === 0)
        )
            throw new PricingPublishError('pricing_precision', '输出价格太小，换算后会变为免费，请调整。');
        const info = completionInfo(source, name);
        if (info.locked && info.ratio !== computed.completion_ratio) {
            throw new PricingPublishError(
                'pricing_completion_locked',
                `new-api 将该模型输出倍率固定为 ${info.ratio}，所填输入与输出价格比例不符。`,
            );
        }
        target = { ModelRatio: computed.model_ratio, CompletionRatio: computed.completion_ratio };
    }
    const next: PriceOptions = { ...baseline };
    for (const key of Object.keys(target) as WritePriceKey[]) next[key] = { ...baseline[key], [name]: target[key] };
    const rows: PublishPlan['rows'] = [];
    const warnings = [
        'new-api 按模型名共享基础价格，下列同名模型与档次将一起更新；其他渠道中使用该模型名的请求也会受影响。',
        '发布期间请只在 Portal 改价，不要同时在 new-api 后台或脚本中修改价格。',
        '输入与输出价格需要分别写入，期间可能短暂使用一新一旧的倍率。当前流程不暂停客户请求。',
    ];
    for (const linked of state.models) {
        const map = checkedMap(linked.upstream_map);
        const links = Object.entries(map).filter(([, mapping]) => mapping.upstream_model === name);
        if (!links.length) continue;
        if (fixedMode && linked.slug !== name)
            throw new PricingPublishError('fixed_sku_invalid', '固定图片规格存在别名或基础模型混用，请先核对映射。');
        if (linked.modality === 'video')
            throw new PricingPublishError(
                'pricing_video_unsupported',
                '该基础价格被视频模型引用，不能通过通用发布器修改。',
            );
        if ((basis === 'request') !== (linked.modality === 'image')) {
            throw new PricingPublishError(
                'pricing_modality_mismatch',
                `「${linked.display_name}」的目录类型与实际计费方式不匹配，请先核对模型配置。`,
            );
        }
        if (/^gpt-image-2-(1k|2k|4k)$/.test(linked.slug) && (!fixedMode || linked.slug !== name))
            throw new PricingPublishError('fixed_sku_price', '该基础价格还被固定分辨率模型引用，不能通用改价。');
        const groups = state.groups.filter((item) => item.tenant_id === linked.tenant_id && item.enabled);
        const topology = new ChannelGroupTopology(linked.tenant_id ?? 'legacy', groups);
        for (const [tier, mapping] of links) {
            const linkedGroup = groups.find((item) => item.key === tier);
            if (!linkedGroup || topology.channelOwner.get(mapping.channel_id) !== tier) {
                throw new PricingPublishError(
                    'pricing_mapping_invalid',
                    `「${linked.display_name}」的档次归属不完整，请先核对。`,
                );
            }
            const channel = source.channels.find((item) => item.id === mapping.channel_id);
            if (
                !channel ||
                channel.status !== 1 ||
                !channel.groups.includes(linkedGroup.newapi_group) ||
                !channel.models.includes(name)
            ) {
                throw new PricingPublishError(
                    'pricing_channel_unavailable',
                    `「${linked.display_name} / ${tier}」的渠道不可用或不支持该模型。`,
                );
            }
            const prices = state.prices.filter((price) => price.model_id === linked.id && price.tier === tier);
            if (prices.some((price) => Date.parse(price.effective_from) > now)) {
                throw new PricingPublishError(
                    'pricing_future_price',
                    '受影响档次存在未来生效价格，请先处理排期后再发布。',
                );
            }
            const current = prices.sort(
                (a, b) => b.effective_from.localeCompare(a.effective_from) || b.id.localeCompare(a.id),
            )[0];
            const calculated = readSyncPrice(
                {
                    modelRatio: next.ModelRatio,
                    completionRatio: next.CompletionRatio,
                    modelPrice: next.ModelPrice,
                    groupRatio: next.GroupRatio,
                },
                name,
                linkedGroup.newapi_group,
            );
            if (!calculated.price)
                throw new PricingPublishError('pricing_unrepresentable', calculated.reason ?? '无法换算目录价格。');
            rows.push({
                model_id: linked.id,
                model_name: linked.display_name,
                tier,
                group: linkedGroup.newapi_group,
                before: current
                    ? {
                          input_cny_per_1m: current.input_cny_per_1m,
                          output_cny_per_1m: current.output_cny_per_1m,
                          per_image_cny: current.per_image_cny,
                      }
                    : null,
                after: calculated.price,
                cost_cny_per_1m:
                    linked.id === input.model_id && tier === input.tier
                        ? input.cost_cny_per_1m
                        : (current?.cost_cny_per_1m ?? null),
            });
        }
    }
    const overrides = dictionary(source.options.GroupGroupRatio, 'GroupGroupRatio');
    let overridesCount = 0;
    for (const values of Object.values(overrides)) {
        const byGroup = dictionary(values, 'GroupGroupRatio');
        overridesCount += rows.filter((row) => Object.hasOwn(byGroup, row.group)).length;
    }
    if (overridesCount)
        warnings.push(
            '部分客户有专属分组倍率，仍按其专属倍率扣费；此处展示公共档次价格，修改基础价格也会影响这些客户。',
        );
    return {
        version: 1,
        input,
        tenant_id: model.tenant_id,
        upstream_model: name,
        basis,
        rows,
        warnings,
        baseline,
        target,
        source_guard: sourceGuard(source),
        catalog_guard: fingerprint(state),
        units: { chat_fx: CHAT_FX, image_fx: IMAGE_FX, quota_per_usd: QUOTA_PER_USD },
    };
}

/** Build every model against the SAME observed source, then merge shared targets.
 * No sequential rebasing: conflicting requirements must be explicitly resolved by the operator. */
export function buildPublishBatchPlan(
    state: PublishState,
    source: PublishSource,
    inputs: PricingPublishInput[],
    now: number,
    costContext?: CostBatchContext,
): PublishBatchPlan {
    if (!inputs.length || inputs.length > 30)
        throw new PricingPublishError('pricing_batch_size', '每次请选择 1 至 30 个模型档次。');
    const selected = new Set<string>();
    for (const input of inputs) {
        const key = JSON.stringify([input.model_id, input.tier]);
        if (selected.has(key)) throw new PricingPublishError('pricing_batch_duplicate', '同一个模型档次不能重复选择。');
        selected.add(key);
    }
    const plans = inputs.map((input) => buildPublishPlan(state, source, input, now));
    const target: PublishBatchPlan['target'] = {};
    const models = new Map<string, 'token' | 'request'>();
    const rows = new Map<string, PublishPlan['rows'][number]>();
    for (const plan of plans) {
        if (models.has(plan.upstream_model) && models.get(plan.upstream_model) !== plan.basis)
            throw new PricingPublishError('pricing_batch_conflict', '共享模型的计费方式不一致，请分开核对。');
        models.set(plan.upstream_model, plan.basis);
        for (const key of Object.keys(plan.target) as WritePriceKey[]) {
            const values = target[key] ?? {};
            const value = plan.target[key]!;
            if (Object.hasOwn(values, plan.upstream_model) && values[plan.upstream_model] !== value)
                throw new PricingPublishError(
                    'pricing_batch_conflict',
                    `「${plan.upstream_model}」在所选档次换算出的基础倍率不同，不能同时发布；请统一加价条件后重新预览。`,
                );
            target[key] = { ...values, [plan.upstream_model]: value };
        }
        for (const row of plan.rows) {
            const key = JSON.stringify([row.model_id, row.tier]);
            const existing = rows.get(key);
            if (existing && fingerprint(existing.after) !== fingerprint(row.after))
                throw new PricingPublishError('pricing_batch_conflict', '共享目录行存在不同发布价格，请先核对。');
            if (!existing) rows.set(key, { ...row });
        }
    }
    // A selected row owns its explicit cost; incidental shared impact must never overwrite it.
    for (const input of inputs) {
        const current = state.prices
            .filter((price) => price.model_id === input.model_id && price.tier === input.tier)
            .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.id.localeCompare(a.id))[0];
        // The cost workflow stores full component/spec costs separately. A null
        // legacy one-column estimate must not erase an existing reference cost.
        rows.get(JSON.stringify([input.model_id, input.tier]))!.cost_cny_per_1m =
            input.cost_cny_per_1m ?? current?.cost_cny_per_1m ?? null;
    }
    const first = plans[0];
    const names = [...models].map(([name, basis]) => ({ name, basis }));
    return {
        version: 2,
        inputs,
        upstream_model: names.map((model) => model.name).join(', '),
        upstream_models: names,
        tenant_id: first.tenant_id,
        basis: first.basis,
        rows: [...rows.values()],
        warnings: [
            ...new Set(plans.flatMap((plan) => plan.warnings)),
            '本批次全部模型通过运行价格和持久化价格核验后，才统一更新目录。多个配置项写入期间不具备远端原子性。',
        ],
        baseline: first.baseline,
        target,
        source_guard: first.source_guard,
        catalog_guard: first.catalog_guard,
        units: first.units,
        ...(costContext ? { cost_context: costContext } : {}),
    };
}

/** A recovery accepts only old/target states, including a partially completed pair.
 * Any third value or unrelated dictionary edit is a conflict, never rolled back. */
export function assertRecoverableOptions(current: PriceOptions, plan: PublishPlan | PublishBatchPlan) {
    const targets = targetDictionaries(plan);
    for (const key of PRICE_KEYS) {
        const expected = { ...plan.baseline[key] };
        if (key !== 'GroupRatio') {
            for (const [model, target] of Object.entries(targets[key] ?? {})) {
                const value = current[key][model];
                const old = plan.baseline[key][model];
                if (value !== old && value !== target)
                    throw new PricingPublishError(
                        'pricing_conflict',
                        'new-api 价格出现其他修改，已停止自动写入，请核对后处理。',
                    );
                if (Object.hasOwn(current[key], model)) expected[model] = value;
                else delete expected[model];
            }
        }
        if (fingerprint(current[key]) !== fingerprint(expected)) {
            throw new PricingPublishError('pricing_conflict', 'new-api 分组或其他价格配置已变化，已停止自动写入。');
        }
    }
}

export function optionsAtTarget(current: Record<string, Record<string, unknown>>, plan: AnyPublishPlan) {
    return Object.entries(targetDictionaries(plan)).every(([key, values]) =>
        Object.entries(values).every(([model, value]) => current[key]?.[model] === value),
    );
}
