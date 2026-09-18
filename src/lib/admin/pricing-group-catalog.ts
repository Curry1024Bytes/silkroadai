import 'server-only';
import { prisma } from '@/lib/db';
import type { AdminPrincipal } from './auth';
import { tenantScope } from './tenant-scope';
import { readPublishSource, readPublishState } from './pricing-publish';
import { fingerprint, type PublishSource, type PublishState } from './pricing-publish-plan';
import { PricingPublishError } from './pricing-publish-lock';
import { costMapping, listCostRules } from './pricing-cost-store';
import { costCapabilities } from './pricing-cost-capabilities';
import { pricingCostConfigSchema } from './pricing-cost';
import { getLiteLlmPriceCatalog, type OfficialModelPrice, type OfficialPriceCatalog } from './litellm-official-prices';
import type { PricingCostConfig, StoredPricingCostRule } from './pricing-cost-types';
import type { PricingGroupCatalog, PricingGroupModel, PricingGroupTier } from './pricing-group-types';

export interface PricingGroupCatalogInput {
    admin: AdminPrincipal;
    groupId: string;
    state: PublishState;
    source: PublishSource;
    rules: StoredPricingCostRule[];
    references: OfficialPriceCatalog | null;
    referenceError?: string | null;
}

function tierView(group: PublishState['groups'][number]): PricingGroupTier {
    return { id: group.id, key: group.key, label: group.display_name, newapi_group: group.newapi_group };
}

/** No upstream calls are necessary to render the authorized tier selector. */
export async function listPricingGroups(admin: AdminPrincipal): Promise<PricingGroupTier[]> {
    const groups = await prisma.channelGroup.findMany({
        where: { ...tenantScope(admin), enabled: true },
        orderBy: [{ tier_level: 'asc' }, { key: 'asc' }],
        select: { id: true, key: true, display_name: true, newapi_group: true },
    });
    return groups.map((group) => ({
        id: group.id,
        key: group.key,
        label: group.display_name,
        newapi_group: group.newapi_group,
    }));
}

/** Exact names only: never borrow a similarly named model or another provider's quote. */
export function exactGroupReference(
    references: OfficialModelPrice[],
    upstreamModel: string,
): OfficialModelPrice | null {
    const exact = references.filter((reference) => reference.model === upstreamModel);
    return exact.length === 1 ? exact[0] : null;
}

function blankConfig(basis: PricingCostConfig['basis']): PricingCostConfig {
    return {
        version: 1,
        basis,
        currency: 'credits',
        credits_per_cny: 1,
        upstream_multiplier: 1,
        retail_multiplier: 1,
        markup_percent: 0,
        source_note: '',
        token_rates: { input: null, output: null, cache_read: null, cache_write: null },
        variants: [],
    };
}

function referenceConfig(reference: OfficialModelPrice, catalog: OfficialPriceCatalog): PricingCostConfig {
    // LiteLLM multiplies per-token binary floats by a million. Remove only the
    // floating representation noise; missing cache rates always remain null.
    const clean = (value: number | null) => (value === null ? null : Number(value.toPrecision(14)));
    return {
        ...blankConfig('token'),
        token_rates: {
            input: clean(reference.inputUsdPer1m),
            output: clean(reference.outputUsdPer1m),
            cache_read: clean(reference.cacheReadUsdPer1m),
            cache_write: clean(reference.cacheWrite5mUsdPer1m),
            ...(reference.cacheWrite1hUsdPer1m === null
                ? {}
                : { cache_write_1h: clean(reference.cacheWrite1hUsdPer1m) }),
        },
        source_note: `${catalog.sourceLabel} · ${reference.model} · ${catalog.fetchedAt}。按上游使用相同基础数字扣额度试算；请确认充值比例与倍率。`,
    };
}

function rawTierMapping(model: PublishState['models'][number], tier: string) {
    const map = model.upstream_map;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
    const raw = (map as Record<string, unknown>)[tier];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const entry = raw as Record<string, unknown>;
    return typeof entry.upstream_model === 'string'
        ? { upstream_model: entry.upstream_model, channel_id: entry.channel_id }
        : null;
}

/** Complete, read-only discovery. Unknown and stale rows are reported, never silently dropped. */
export function buildPricingGroupCatalog(input: PricingGroupCatalogInput): PricingGroupCatalog {
    const { admin, groupId, state, source, rules, references } = input;
    const scope = tenantScope(admin);
    const group = state.groups.find(
        (candidate) =>
            candidate.id === groupId && (scope.tenant_id === undefined || candidate.tenant_id === scope.tenant_id),
    );
    if (!group) throw new PricingPublishError('pricing_group_not_found', '档次不存在。', 404);
    if (!group.enabled)
        throw new PricingPublishError('pricing_group_disabled', '该档次已停用，请选择启用的档次。', 409);

    const scopedModels = state.models.filter((model) => model.tenant_id === group.tenant_id);
    const liveChannels = source.channels.filter(
        (channel) => channel.status === 1 && channel.groups.includes(group.newapi_group),
    );
    const names = new Set(liveChannels.flatMap((channel) => channel.models));
    const mapped = scopedModels.flatMap((model) => {
        const mapping = rawTierMapping(model, group.key);
        return mapping ? [{ model, mapping }] : [];
    });
    const retiredNames = [...new Set(mapped.map((row) => row.mapping.upstream_model))].filter(
        (name) => !names.has(name),
    );
    const capabilities = costCapabilities(state, source);
    const rows: PricingGroupModel[] = [];
    for (const upstreamModel of [...names].sort()) {
        const channels = liveChannels.filter((channel) => channel.models.includes(upstreamModel));
        const mappedModels = mapped.filter((row) => row.mapping.upstream_model === upstreamModel);
        const enabled = mappedModels.filter((row) => row.model.enabled);
        const candidates = enabled.length ? enabled : mappedModels;
        const candidate = candidates.length === 1 ? candidates[0] : null;
        const model = candidate?.model ?? null;
        const capability = model
            ? (capabilities.find((row) => row.model_id === model.id && row.tier === group.key) ?? null)
            : null;
        const row: PricingGroupModel = {
            id: model ? `model:${model.id}` : `upstream:${upstreamModel}`,
            model_id: model?.id ?? null,
            slug: model?.slug ?? null,
            display_name: model?.display_name ?? upstreamModel,
            upstream_model: upstreamModel,
            channel_ids: channels.map((channel) => channel.id).sort((a, b) => a - b),
            status: 'ready',
            selectable: false,
            ready: false,
            config: null,
            saved_revision: null,
            saved_rule_id: null,
            capability,
            reason: null,
            base_source: 'none',
            reference_model: null,
        };
        const reject = (status: PricingGroupModel['status'], reason: string) => {
            row.status = status;
            row.reason = reason;
            rows.push(row);
        };
        if (channels.length === 0) {
            reject('inactive', '该模型已不在此 new-api 分组的启用渠道中，请先更新目录或处理旧关联。');
            continue;
        }
        if (channels.some((channel) => !group.newapi_channel_ids.includes(channel.id))) {
            reject('unregistered_channel', '该模型的启用渠道尚未全部登记到此档次，请先核对渠道分组。');
            continue;
        }
        if (candidates.length > 1) {
            reject('ambiguous', '多个 Portal 模型指向同一上游模型，请先核对目录映射。');
            continue;
        }
        if (!model) {
            reject('unregistered', 'new-api 已有此模型，Portal 尚未登记该档次关联，请先从 new-api 更新目录。');
            continue;
        }
        if (!model.enabled) {
            reject('inactive', 'Portal 中该模型尚未启用，请先在模型管理中核对并启用。');
            continue;
        }
        let mapping: ReturnType<typeof costMapping>;
        try {
            mapping = costMapping(model, group.key, state.groups);
            if (!channels.some((channel) => channel.id === mapping.channel_id)) throw new Error();
        } catch {
            reject('invalid_mapping', 'Portal 模型映射与此 new-api 分组当前启用渠道不一致，请先更新目录。');
            continue;
        }

        const basis = model.modality === 'video' ? 'video' : model.modality === 'image' ? 'image' : 'token';
        const saved = rules.find((rule) => rule.model_id === model.id && rule.tier === group.key);
        row.saved_revision = saved?.revision ?? null;
        row.saved_rule_id = saved?.id ?? null;
        const savedConfig = saved && pricingCostConfigSchema.safeParse(saved.config);
        if (
            saved &&
            saved.mapping_current &&
            saved.channel_id === mapping.channel_id &&
            saved.upstream_model === mapping.upstream_model &&
            savedConfig?.success &&
            savedConfig.data.basis === basis
        ) {
            row.config = savedConfig.data;
            row.base_source = 'saved';
        } else {
            const reference = basis === 'token' && references && exactGroupReference(references.models, upstreamModel);
            row.config = reference && references ? referenceConfig(reference, references) : blankConfig(basis);
            row.base_source = reference ? 'reference' : 'manual';
            row.reference_model = reference ? reference.model : null;
        }
        if (!capability?.publishable) {
            reject('unsupported', capability?.reason ?? '该模型尚不能通过当前发布核验，请先核对计费配置。');
            continue;
        }
        row.selectable = true;
        const requiredCacheMissing = capability.required_token_rates?.some(
            (key) => row.config?.token_rates[key] == null,
        );
        row.ready = pricingCostConfigSchema.safeParse(row.config).success && !requiredCacheMissing;
        if (!row.ready) {
            row.status = 'missing_price';
            row.reason =
                basis === 'image'
                    ? '请补充本模型按张或分辨率的基础报价。'
                    : '请补齐基础报价；缓存价格未提供时保持空白，不会视为免费。';
        }
        rows.push(row);
    }
    const result = {
        tier: tierView(group),
        models: rows,
        reference_error: input.referenceError ?? null,
        notices: retiredNames.length
            ? [
                  `Portal 另有 ${retiredNames.length} 个旧模型关联已不在该 new-api 分组中，本次不参与定价，可从 new-api 更新目录后清理。`,
              ]
            : [],
        counts: {
            total: rows.length,
            ready: rows.filter((row) => row.ready).length,
            needs_price: rows.filter((row) => row.selectable && !row.ready).length,
            unavailable: rows.filter((row) => !row.selectable).length,
        },
    };
    return {
        ...result,
        fingerprint: fingerprint({
            group,
            channels: liveChannels,
            models: scopedModels,
            rules: rules.filter(
                (rule) => scopedModels.some((model) => model.id === rule.model_id) && rule.tier === group.key,
            ),
            options: source.options,
            // Reference refresh times must not invalidate unchanged numeric quotes.
            rows: rows.map(({ config, ...row }) => ({
                ...row,
                config: config
                    ? { ...config, source_note: row.base_source === 'reference' ? '' : config.source_note }
                    : null,
            })),
        }),
    };
}

export async function discoverPricingGroupCatalog(
    admin: AdminPrincipal,
    groupId: string,
): Promise<PricingGroupCatalog> {
    const [state, source, rules, referenceResult] = await Promise.all([
        readPublishState(prisma),
        readPublishSource(),
        listCostRules(admin),
        getLiteLlmPriceCatalog().then(
            (catalog) => ({ catalog, error: null }),
            () => ({ catalog: null, error: '暂时无法获取基础参考价；已保存成本仍可使用，其他模型可手动补价。' }),
        ),
    ]);
    return buildPricingGroupCatalog({
        admin,
        groupId,
        state,
        source,
        rules,
        references: referenceResult.catalog,
        referenceError: referenceResult.error,
    });
}
