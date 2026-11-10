import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
    getPricingPublishOptions,
    getPricingRuntimeModels,
    putPricingPublishOption,
    queryLogs,
} from '@/lib/newapi/client';
import { QUOTA_PER_USD } from '@/lib/newapi/quota-units';
import { parseCatalogBillingDetails } from '@/lib/models/catalog-pricing-details';
import { advancedSyncPrice } from '@/lib/newapi/catalog-sync-advanced';
import { syncPricesFromOptions } from '@/lib/newapi/catalog-sync-prices';
import { assertPricingCatalogWritable, PricingPublishError } from './pricing-publish-lock';
import { assertGroupsUnmanaged } from '@/lib/pricing-rules/guards';
import { tenantForInsert } from './tenant-scope';
import { tierOrder } from './pricing-tiers';
import type { AdminPrincipal } from './auth';
import { parseLoggedBill, type LoggedBill } from './pricing-bill-check';
import { saveCostRulesInTransaction } from './pricing-cost-store';
import { pricingCostConfigSchema } from './pricing-cost';
import {
    VideoQuoteError,
    computeVideoQuote,
    videoQuoteCostConfig,
    videoQuoteFromCostConfig,
    type VideoQuoteCell,
    type VideoQuoteInput,
    type VideoQuoteOfficialCell,
} from './pricing-video-quote';
import { VIDEO_TOKEN_COMBOS, videoTokenKey } from './pricing-video-token-expression';
import { arkOfficialPrice } from '@/lib/seedance/official-rates';
import {
    BASE_FX,
    EXPR_KEY,
    MODE_KEY,
    RATIO_UNIT,
    SimplePricingError,
    basePriceSchema,
    catalogDiffs,
    catalogMatches,
    customerPrice,
    groupRatioOf,
    modelOptionState,
    optionDict,
    round,
    planGroupRatioWrites,
    planModelWrites,
    planVideoTokenWrites,
    readBasePrice,
    hasStructuredMediaPrice,
    hasTimeOfDayPrice,
    sameNumber,
    unverifiedWrites,
    type BasePrice,
    type EditableBasePrice,
    type CatalogAmounts,
    type CatalogDiff,
    type OptionWrite,
} from './pricing-simple-core';

/**
 * Two-knob pricing (docs/PRICING-SIMPLIFY.md): one base price per upstream
 * model plus one GroupRatio per tier. Saves write new-api synchronously under
 * the shared pricing mutex, verify the readback, then snapshot CatalogPrice.
 */

export interface SimplePricingContext {
    admin: AdminPrincipal;
    ip: string | null;
    userAgent: string | null;
}

export type CellStatus = 'ok' | 'mismatch' | 'missing' | 'unpriced' | 'no_ratio' | 'invalid';

export interface SimpleTier {
    id: string;
    key: string;
    display_name: string;
    newapi_group: string;
    ratio: number | null;
    /** 进货率 (¥ we pay per official $1); Portal-only, never billed. */
    purchase_rate: number | null;
    active_keys: number;
    customer_overrides: number;
    model_count: number;
    /** GroupRatio is compiled from sale rules; edit the unified sale ratio instead. */
    sale_rules_managed: boolean;
}

export interface SimpleCell {
    tier: string;
    upstream_model: string;
    status: CellStatus;
    catalog: CatalogAmounts | null;
    expected: CatalogAmounts | null;
    /** Only for status 'mismatch': which fields differ. */
    diffs: CatalogDiff[];
}

export interface SimpleCatalogModel {
    id: string;
    slug: string;
    display_name: string;
    vendor: string;
    modality: string;
    cells: SimpleCell[];
}

export interface SimpleUpstreamModel {
    name: string;
    base: BasePrice | null;
    error: string | null;
    read_only?: boolean;
    /** Why `read_only`: structured image/video pricing, or a peak/off-peak formula kept in new-api. */
    read_only_kind?: 'media' | 'time_of_day';
    /** Optimistic-lock token for save_model. */
    state: string;
    /** new-api forces output = input × this ratio for token pricing. */
    locked_completion: number | null;
    /** new-api rules that also change the charge and are not edited here. */
    notes: string[];
    used_by: Array<{ model_id: string; slug: string; display_name: string; modality: string; tier: string }>;
    /** Only for video-token models: the official-price discount quote. */
    video_quote?: SimpleVideoQuote;
}

/** One video-token model's quote: stored official prices and discounts, or a prefill. */
export interface SimpleVideoQuote {
    model_id: string;
    tier: string;
    tier_name: string;
    newapi_group: string;
    group_ratio: number | null;
    /** The stored Portal quote (official prices, buy and sell discount), if any. */
    rule: { id: string; revision: number; quote: VideoQuoteInput | null; updated_at: string } | null;
    /** Official prices to start from when no quote is stored. Null = fill in by hand. */
    prefill: VideoQuoteOfficialCell[] | null;
    /** True when the stored quote no longer produces the live coefficients. */
    drift: boolean;
    customer_overrides: number;
    sale_rules_managed: boolean;
    notes: string[];
}

export interface SimpleVideoQuotePreview {
    unchanged: boolean;
    tier: string;
    group_ratio: number;
    cells: Array<VideoQuoteCell & { current_coefficient: number; current_actual: number }>;
    warnings: string[];
}

export interface SimplePricingView {
    units: { base_fx: number; ratio_unit: number; quota_per_usd: number };
    tiers: SimpleTier[];
    models: SimpleCatalogModel[];
    upstream_models: SimpleUpstreamModel[];
}

type CatalogRow = Awaited<ReturnType<typeof loadCatalog>>['models'][number];

async function loadCatalog(tenantId: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
    const now = new Date();
    const [groups, models] = await Promise.all([
        db.channelGroup.findMany({
            where: { tenant_id: tenantId, enabled: true },
            select: {
                id: true,
                key: true,
                display_name: true,
                newapi_group: true,
                tier_level: true,
                purchase_rate: true,
            },
        }),
        db.catalogModel.findMany({
            where: { tenant_id: tenantId, enabled: true },
            orderBy: [{ sort_order: 'asc' }, { slug: 'asc' }],
            select: {
                id: true,
                slug: true,
                display_name: true,
                vendor: true,
                modality: true,
                upstream_map: true,
                prices: {
                    where: { effective_from: { lte: now } },
                    orderBy: [{ effective_from: 'desc' }, { id: 'desc' }],
                    select: {
                        tier: true,
                        input_cny_per_1m: true,
                        output_cny_per_1m: true,
                        per_image_cny: true,
                        billing_details: true,
                        cost_cny_per_1m: true,
                    },
                },
            },
        }),
    ]);
    groups.sort(
        (a, b) => tierOrder(a.key) - tierOrder(b.key) || a.tier_level - b.tier_level || a.key.localeCompare(b.key),
    );
    return { groups, models };
}

const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

function latestCatalog(model: CatalogRow, tier: string) {
    const row = model.prices.find((price) => price.tier === tier);
    if (!row) return null;
    let details = null;
    try {
        details = parseCatalogBillingDetails(row.billing_details);
    } catch {
        details = null;
    }
    return {
        amounts: {
            input_cny_per_1m: num(row.input_cny_per_1m),
            output_cny_per_1m: num(row.output_cny_per_1m),
            per_image_cny: num(row.per_image_cny),
            billing_details: details,
        } satisfies CatalogAmounts,
        cost: num(row.cost_cny_per_1m),
    };
}

/** Enabled tier → upstream model name, from the model's upstream_map. */
function mappings(model: CatalogRow, tierKeys: Set<string>): Array<{ tier: string; upstream_model: string }> {
    const map = model.upstream_map;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
    return Object.entries(map as Record<string, unknown>).flatMap(([tier, entry]) => {
        if (!tierKeys.has(tier) || !entry || typeof entry !== 'object') return [];
        const name = (entry as { upstream_model?: unknown }).upstream_model;
        return typeof name === 'string' && name.trim() ? [{ tier, upstream_model: name }] : [];
    });
}

function safeBase(options: Record<string, unknown>, name: string): { base: BasePrice | null; error: string | null } {
    try {
        return { base: readBasePrice(options, name), error: null };
    } catch (error) {
        return { base: null, error: error instanceof Error ? error.message : '计费配置无法解析。' };
    }
}

function notesFor(options: Record<string, unknown>, name: string): string[] {
    const notes: string[] = [];
    if (Object.hasOwn(optionDict(options, 'ImageResolutionPrice', true), name))
        notes.push('new-api 另配了按分辨率计价，实际扣费以分辨率价为准。');
    const discount = optionDict(options, 'billing_setting.scheduled_discount', true)[name];
    if (discount && typeof discount === 'object' && (discount as { enabled?: unknown }).enabled === true)
        notes.push('new-api 对该模型开启了限时折扣，实际扣费会低于这里显示的价格。');
    return notes;
}

function expectedFor(options: Record<string, unknown>, name: string, group: string) {
    const configuredRatio = groupRatioOf(options, group);
    if (configuredRatio !== null) {
        const advanced = advancedSyncPrice(syncPricesFromOptions(options), name, configuredRatio);
        if (advanced)
            return advanced.price
                ? {
                      status: 'ok' as const,
                      expected: { ...advanced.price, billing_details: advanced.price.billing_details ?? null },
                  }
                : { status: 'invalid' as const, expected: null };
    }
    const { base, error } = safeBase(options, name);
    const ratio = groupRatioOf(options, group);
    if (error) return { status: 'invalid' as const, expected: null };
    if (!base) return { status: 'unpriced' as const, expected: null };
    if (ratio === null) return { status: 'no_ratio' as const, expected: null };
    return { status: 'ok' as const, expected: customerPrice(base, ratio) };
}

function buildView(
    catalog: Awaited<ReturnType<typeof loadCatalog>>,
    options: Record<string, unknown>,
    counts: { keys: Map<string, number>; overrides: Map<string, number>; managed: Set<string> },
): SimplePricingView {
    const tierKeys = new Set(catalog.groups.map((group) => group.key));
    const groupByKey = new Map(catalog.groups.map((group) => [group.key, group]));
    const upstream = new Map<string, SimpleUpstreamModel>();
    const modelCount = new Map<string, number>();
    const models = catalog.models.map((model): SimpleCatalogModel => {
        const cells = mappings(model, tierKeys)
            .sort((a, b) => tierOrder(a.tier) - tierOrder(b.tier) || a.tier.localeCompare(b.tier))
            .map(({ tier, upstream_model }): SimpleCell => {
                modelCount.set(tier, (modelCount.get(tier) ?? 0) + 1);
                let entry = upstream.get(upstream_model);
                if (!entry) {
                    const { base, error } = safeBase(options, upstream_model);
                    const meta = optionDict(options, 'CompletionRatioMeta', true)[upstream_model] as
                        { ratio?: unknown; locked?: unknown } | undefined;
                    entry = {
                        name: upstream_model,
                        base,
                        error,
                        read_only:
                            hasStructuredMediaPrice(options, upstream_model) ||
                            hasTimeOfDayPrice(options, upstream_model),
                        read_only_kind: hasTimeOfDayPrice(options, upstream_model)
                            ? 'time_of_day'
                            : hasStructuredMediaPrice(options, upstream_model)
                              ? 'media'
                              : undefined,
                        state: modelOptionState(options, upstream_model),
                        locked_completion: meta?.locked === true && typeof meta.ratio === 'number' ? meta.ratio : null,
                        notes: notesFor(options, upstream_model),
                        used_by: [],
                    };
                    upstream.set(upstream_model, entry);
                }
                entry.used_by.push({
                    model_id: model.id,
                    slug: model.slug,
                    display_name: model.display_name,
                    modality: model.modality,
                    tier,
                });
                const current = latestCatalog(model, tier)?.amounts ?? null;
                const { status, expected } = expectedFor(options, upstream_model, groupByKey.get(tier)!.newapi_group);
                const diffs = status === 'ok' && current ? catalogDiffs(current, expected!) : [];
                return {
                    tier,
                    upstream_model,
                    status: status !== 'ok' ? status : !current ? 'missing' : diffs.length === 0 ? 'ok' : 'mismatch',
                    catalog: current,
                    expected,
                    diffs,
                };
            });
        return {
            id: model.id,
            slug: model.slug,
            display_name: model.display_name,
            vendor: model.vendor,
            modality: model.modality,
            cells,
        };
    });
    return {
        units: { base_fx: BASE_FX, ratio_unit: RATIO_UNIT, quota_per_usd: QUOTA_PER_USD },
        tiers: catalog.groups.map((group) => ({
            id: group.id,
            key: group.key,
            display_name: group.display_name,
            newapi_group: group.newapi_group,
            ratio: groupRatioOf(options, group.newapi_group),
            purchase_rate: num(group.purchase_rate),
            active_keys: counts.keys.get(group.key) ?? 0,
            customer_overrides: counts.overrides.get(group.key) ?? 0,
            model_count: modelCount.get(group.key) ?? 0,
            sale_rules_managed: counts.managed.has(group.newapi_group),
        })),
        models,
        upstream_models: [...upstream.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
}

async function loadCounts(tenantId: string) {
    const [keys, overrides, managed] = await Promise.all([
        prisma.newApiToken.groupBy({
            by: ['tier'],
            where: { status: 'active', user: { tenant_id: tenantId } },
            _count: { _all: true },
        }),
        prisma.userTierMultiplier.groupBy({
            by: ['tier_key'],
            where: { enabled: true, user: { tenant_id: tenantId } },
            _count: { _all: true },
        }),
        prisma.pricingBillingGroup.findMany({
            where: { unified_sale_ratio: { not: null } },
            select: { newapi_group: true },
        }),
    ]);
    return {
        keys: new Map(keys.map((row) => [row.tier, row._count._all])),
        overrides: new Map(overrides.map((row) => [row.tier_key, row._count._all])),
        managed: new Set(managed.map((row) => row.newapi_group)),
    };
}

export async function loadSimplePricing(admin: AdminPrincipal): Promise<SimplePricingView> {
    const tenantId = tenantForInsert(admin);
    const [catalog, options, counts] = await Promise.all([
        loadCatalog(tenantId),
        getPricingPublishOptions(),
        loadCounts(tenantId),
    ]);
    const view = buildView(catalog, options, counts);
    await attachVideoQuotes(view, catalog, options, counts);
    return view;
}

// ── video-token quotes (official price × discount) ──

type CostRuleRow = { id: string; model_id: string; tier: string; revision: number; config: unknown; updated_at: Date };

function storedQuote(rule: CostRuleRow | undefined) {
    if (!rule) return null;
    const parsed = pricingCostConfigSchema.safeParse(rule.config);
    return {
        id: rule.id,
        revision: rule.revision,
        quote: parsed.success ? videoQuoteFromCostConfig(parsed.data) : null,
        updated_at: rule.updated_at.toISOString(),
    };
}

function officialPrefill(name: string): VideoQuoteOfficialCell[] | null {
    const cells = VIDEO_TOKEN_COMBOS.map((combo) => ({
        ...combo,
        price: arkOfficialPrice(name, combo.resolution, combo.video_input === 'video'),
    }));
    return cells.every((cell) => cell.price !== null) ? (cells as VideoQuoteOfficialCell[]) : null;
}

/** A discount quote prices one catalog model in one tier; a shared upstream name has no single ratio. */
function planVideoQuote(
    catalog: Awaited<ReturnType<typeof loadCatalog>>,
    options: Record<string, unknown>,
    name: string,
    input: VideoQuoteInput,
) {
    const tierKeys = new Set(catalog.groups.map((group) => group.key));
    const uses = catalog.models.flatMap((model) =>
        mappings(model, tierKeys)
            .filter((mapping) => mapping.upstream_model === name)
            .map((mapping) => ({ model, tier: mapping.tier })),
    );
    if (!uses.length)
        throw new SimplePricingError('pricing_model_not_found', `没有启用的模型在启用档次上映射到「${name}」。`, 404);
    if (uses.length !== 1)
        throw new SimplePricingError(
            'pricing_video_quote_shared',
            `「${name}」被 ${uses.length} 个模型或档次使用，按官方价折扣定价只支持一个档次。`,
        );
    const { model, tier } = uses[0];
    const group = catalog.groups.find((row) => row.key === tier)!;
    const base = safeBase(options, name);
    if (base.error) throw new SimplePricingError('pricing_video_token_invalid', base.error);
    if (base.base?.mode !== 'video_token')
        throw new SimplePricingError('pricing_video_token_invalid', '该模型不是按分辨率和参考视频计价，请刷新。');
    const ratio = groupRatioOf(options, group.newapi_group);
    if (ratio === null)
        throw new SimplePricingError('pricing_no_ratio', `档次「${group.display_name}」在 new-api 没有分组倍率。`);
    const cells = quoteOrError(input, ratio);
    let writes: OptionWrite[];
    try {
        writes = planVideoTokenWrites(
            options,
            name,
            cells.map((cell) => ({
                resolution: cell.resolution,
                video_input: cell.video_input,
                price: cell.coefficient,
            })),
        );
    } catch (error) {
        if (error instanceof SimplePricingError) throw error;
        throw new SimplePricingError(
            'pricing_video_token_invalid',
            error instanceof Error ? error.message : '视频计费公式无法改写。',
        );
    }
    return { model, tier, group, ratio, current: base.base, cells, writes };
}

function quoteOrError(input: VideoQuoteInput, groupRatio: number): VideoQuoteCell[] {
    try {
        return computeVideoQuote(input, BASE_FX, groupRatio);
    } catch (error) {
        if (error instanceof VideoQuoteError)
            throw new SimplePricingError('pricing_video_quote_invalid', error.message, 400);
        throw error;
    }
}

async function attachVideoQuotes(
    view: SimplePricingView,
    catalog: Awaited<ReturnType<typeof loadCatalog>>,
    options: Record<string, unknown>,
    counts: Awaited<ReturnType<typeof loadCounts>>,
) {
    const videos = view.upstream_models.filter((model) => model.base?.mode === 'video_token');
    if (!videos.length) return;
    const rules: CostRuleRow[] = await prisma.pricingCostRule.findMany({
        where: { model_id: { in: [...new Set(videos.flatMap((model) => model.used_by.map((use) => use.model_id)))] } },
        select: { id: true, model_id: true, tier: true, revision: true, config: true, updated_at: true },
    });
    for (const model of videos) {
        const use = model.used_by[0];
        const group = catalog.groups.find((row) => row.key === use.tier)!;
        const ratio = groupRatioOf(options, group.newapi_group);
        const rule = storedQuote(rules.find((row) => row.model_id === use.model_id && row.tier === use.tier));
        const notes: string[] = [];
        if (model.used_by.length !== 1)
            notes.push(`被 ${model.used_by.length} 个模型或档次使用，按官方价折扣定价只支持一个档次。`);
        if (rule && !rule.quote) notes.push('已保存的成本资料不是按 token 计价的视频报价，保存后会被替换。');
        let drift = false;
        if (rule?.quote && ratio !== null && model.base?.mode === 'video_token') {
            const live = new Map(model.base.cells.map((cell) => [videoTokenKey(cell), cell.price]));
            try {
                drift = computeVideoQuote(rule.quote, BASE_FX, ratio).some(
                    (cell) => live.get(videoTokenKey(cell)) !== cell.coefficient,
                );
            } catch {
                drift = true;
            }
        }
        model.video_quote = {
            model_id: use.model_id,
            tier: use.tier,
            tier_name: group.display_name,
            newapi_group: group.newapi_group,
            group_ratio: ratio,
            rule,
            prefill: rule?.quote ? null : officialPrefill(model.name),
            drift,
            customer_overrides: counts.overrides.get(use.tier) ?? 0,
            sale_rules_managed: counts.managed.has(group.newapi_group),
            notes,
        };
    }
}

// ── previews ──

export interface PreviewRow {
    model_id: string;
    slug: string;
    display_name: string;
    tier: string;
    before: CatalogAmounts | null;
    after: CatalogAmounts | null;
}

export interface SimplePreview {
    unchanged: boolean;
    writes: Array<{ key: string; entry: string; before: unknown; after: unknown }>;
    rows: PreviewRow[];
    warnings: string[];
}

function applyWrites(options: Record<string, unknown>, writes: OptionWrite[]): Record<string, unknown> {
    const next = { ...options };
    for (const write of writes) next[write.key] = write.value;
    return next;
}

function describeWrites(options: Record<string, unknown>, writes: OptionWrite[]): SimplePreview['writes'] {
    return writes.map((write) => {
        const dict = optionDict(options, write.key, true);
        return {
            key: write.key,
            entry: write.entry,
            before: Object.hasOwn(dict, write.entry) ? dict[write.entry] : null,
            after: write.target ?? null,
        };
    });
}

function previewRows(
    catalog: Awaited<ReturnType<typeof loadCatalog>>,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    filter: (cell: { tier: string; upstream_model: string }) => boolean,
): PreviewRow[] {
    const tierKeys = new Set(catalog.groups.map((group) => group.key));
    const groupByKey = new Map(catalog.groups.map((group) => [group.key, group]));
    return catalog.models.flatMap((model) =>
        mappings(model, tierKeys)
            .filter(filter)
            .map(({ tier, upstream_model }) => {
                const group = groupByKey.get(tier)!.newapi_group;
                return {
                    model_id: model.id,
                    slug: model.slug,
                    display_name: model.display_name,
                    tier,
                    before: expectedFor(before, upstream_model, group).expected,
                    after: expectedFor(after, upstream_model, group).expected,
                };
            }),
    );
}

function tierGroup(catalog: Awaited<ReturnType<typeof loadCatalog>>, groupId: string) {
    const group = catalog.groups.find((row) => row.id === groupId);
    if (!group) throw new SimplePricingError('pricing_tier_not_found', '档次不存在或已停用。', 404);
    return group;
}

function modelUsers(catalog: Awaited<ReturnType<typeof loadCatalog>>, name: string) {
    const tierKeys = new Set(catalog.groups.map((group) => group.key));
    const users = catalog.models.filter((model) =>
        mappings(model, tierKeys).some((mapping) => mapping.upstream_model === name),
    );
    if (!users.length)
        throw new SimplePricingError('pricing_model_not_found', `没有启用的模型在启用档次上映射到「${name}」。`, 404);
    return users;
}

export async function previewTier(admin: AdminPrincipal, groupId: string, ratio: number): Promise<SimplePreview> {
    const tenantId = tenantForInsert(admin);
    const [catalog, options, counts] = await Promise.all([
        loadCatalog(tenantId),
        getPricingPublishOptions(),
        loadCounts(tenantId),
    ]);
    const group = tierGroup(catalog, groupId);
    if (counts.managed.has(group.newapi_group)) await assertGroupsUnmanaged(prisma, [group.newapi_group]);
    const writes = planGroupRatioWrites(options, group.newapi_group, ratio);
    const after = applyWrites(options, writes);
    const warnings: string[] = [];
    const overrides = counts.overrides.get(group.key) ?? 0;
    if (overrides) warnings.push(`${overrides} 位客户在该档次有专属倍率，他们按专属倍率计费，不受这次修改影响。`);
    const shared = catalog.groups.filter((row) => row.newapi_group === group.newapi_group && row.id !== group.id);
    if (shared.length)
        warnings.push(
            `new-api 分组「${group.newapi_group}」同时被档次 ${shared.map((row) => row.key).join('、')} 使用，它们会一起变价。`,
        );
    return {
        unchanged: writes.length === 0,
        writes: describeWrites(options, writes),
        rows: previewRows(catalog, options, after, ({ tier }) => [group, ...shared].some((row) => row.key === tier)),
        warnings,
    };
}

export async function previewModel(
    admin: AdminPrincipal,
    name: string,
    base: EditableBasePrice,
): Promise<SimplePreview> {
    const tenantId = tenantForInsert(admin);
    const [catalog, options] = await Promise.all([loadCatalog(tenantId), getPricingPublishOptions()]);
    modelUsers(catalog, name);
    const writes = planModelWrites(options, name, basePriceSchema.parse(base));
    const after = applyWrites(options, writes);
    return {
        unchanged: writes.length === 0,
        writes: describeWrites(options, writes),
        rows: previewRows(catalog, options, after, ({ upstream_model }) => upstream_model === name),
        warnings: notesFor(options, name),
    };
}

// ── saves ──

const TX_OPTIONS = { timeout: 120_000, maxWait: 5_000 };
const WRITE_DEADLINE_MS = 90_000;

function toPricingError(error: unknown): never {
    if (error instanceof SimplePricingError) throw new PricingPublishError(error.code, error.message, error.status);
    throw error;
}

/** Write options in order, then read back. A partial failure leaves new-api billable (see plan ordering). */
async function writeAndVerify(writes: OptionWrite[]): Promise<Record<string, unknown>> {
    const deadline = Date.now() + WRITE_DEADLINE_MS;
    const done: string[] = [];
    for (const write of writes) {
        if (Date.now() > deadline)
            throw new PricingPublishError(
                'pricing_write_timeout',
                `写入超时，已写入:${done.join('、') || '无'}。请刷新核对后重试。`,
            );
        try {
            await putPricingPublishOption(write.key, JSON.stringify(write.value));
        } catch {
            throw new PricingPublishError(
                'pricing_write_failed',
                `写入 new-api 的 ${write.key} 失败，已写入:${done.join('、') || '无'}。请刷新核对后重试。`,
                502,
            );
        }
        done.push(write.key);
    }
    const readback = await getPricingPublishOptions();
    const failed = unverifiedWrites(readback, writes);
    if (failed.length)
        throw new PricingPublishError(
            'pricing_verify_failed',
            `new-api 回读与写入不一致:${failed.join('、')}。请刷新核对。`,
            502,
        );
    return readback;
}

/** Rewrite stale CatalogPrice snapshots from what new-api bills now. Shared with the sale-rule publisher. */
export async function snapshotCatalog(
    tx: Prisma.TransactionClient,
    tenantId: string,
    options: Record<string, unknown>,
    createdBy: string | null,
    filter: (cell: { tier: string; upstream_model: string }) => boolean,
): Promise<number> {
    const catalog = await loadCatalog(tenantId, tx);
    const tierKeys = new Set(catalog.groups.map((group) => group.key));
    const groupByKey = new Map(catalog.groups.map((group) => [group.key, group]));
    const now = new Date();
    let written = 0;
    for (const model of catalog.models) {
        for (const mapping of mappings(model, tierKeys)) {
            if (!filter(mapping)) continue;
            const { expected } = expectedFor(
                options,
                mapping.upstream_model,
                groupByKey.get(mapping.tier)!.newapi_group,
            );
            if (!expected) continue;
            const current = latestCatalog(model, mapping.tier);
            if (current && catalogMatches(current.amounts, expected)) continue;
            await tx.catalogPrice.create({
                data: {
                    model_id: model.id,
                    tier: mapping.tier,
                    input_cny_per_1m: expected.input_cny_per_1m,
                    output_cny_per_1m: expected.output_cny_per_1m,
                    per_image_cny: expected.per_image_cny,
                    ...(expected.billing_details
                        ? { billing_details: expected.billing_details as unknown as Prisma.InputJsonValue }
                        : {}),
                    cost_cny_per_1m: current?.cost ?? null,
                    effective_from: now,
                    created_by: createdBy,
                },
            });
            written += 1;
        }
    }
    return written;
}

async function audit(
    tx: Prisma.TransactionClient,
    context: SimplePricingContext,
    action: string,
    target: string,
    params: unknown,
) {
    const json = JSON.stringify(params);
    await tx.adminAuditLog.create({
        data: {
            admin_user_id: context.admin.user?.id ?? null,
            admin_email: context.admin.user?.email ?? null,
            level: context.admin.viaBreakGlass ? 'break_glass' : 'super',
            action,
            method: 'POST',
            path: '/api/admin/pricing/simple',
            target: target.slice(0, 200),
            params: json.length > 8_000 ? `${json.slice(0, 8_000)}…` : json,
            client_ip: context.ip,
            user_agent: context.userAgent?.slice(0, 500) ?? null,
        },
    });
}

export interface SaveResult {
    unchanged: boolean;
    written_keys: string[];
    catalog_rows: number;
}

export async function saveTier(
    context: SimplePricingContext,
    groupId: string,
    ratio: number,
    expectedRatio: number | null,
): Promise<SaveResult> {
    const tenantId = tenantForInsert(context.admin);
    return prisma.$transaction(async (tx) => {
        await assertPricingCatalogWritable(tx);
        const [catalog, options] = await Promise.all([loadCatalog(tenantId, tx), getPricingPublishOptions()]);
        const group = tierGroup(catalog, groupId);
        await assertGroupsUnmanaged(tx, [group.newapi_group]);
        const current = groupRatioOf(options, group.newapi_group);
        if (current === null ? expectedRatio !== null : expectedRatio === null || !sameNumber(current, expectedRatio))
            throw new PricingPublishError('pricing_stale', '档次倍率已被其他人修改，请刷新后重新确认。');
        let writes: OptionWrite[];
        try {
            writes = planGroupRatioWrites(options, group.newapi_group, ratio);
        } catch (error) {
            toPricingError(error);
        }
        const readback = writes.length ? await writeAndVerify(writes) : options;
        const shared = new Set(
            catalog.groups.filter((row) => row.newapi_group === group.newapi_group).map((row) => row.key),
        );
        const rows = await snapshotCatalog(tx, tenantId, readback, context.admin.user?.id ?? null, ({ tier }) =>
            shared.has(tier),
        );
        await audit(tx, context, 'pricing_tier_ratio', group.key, {
            newapi_group: group.newapi_group,
            before: current,
            after: ratio,
            catalog_rows: rows,
        });
        return { unchanged: writes.length === 0, written_keys: writes.map((write) => write.key), catalog_rows: rows };
    }, TX_OPTIONS);
}

export async function saveModel(
    context: SimplePricingContext,
    name: string,
    base: EditableBasePrice,
    expectedState: string,
): Promise<SaveResult> {
    const tenantId = tenantForInsert(context.admin);
    const parsed = basePriceSchema.parse(base);
    return prisma.$transaction(async (tx) => {
        await assertPricingCatalogWritable(tx);
        const [catalog, options] = await Promise.all([loadCatalog(tenantId, tx), getPricingPublishOptions()]);
        try {
            modelUsers(catalog, name);
        } catch (error) {
            toPricingError(error);
        }
        if (modelOptionState(options, name) !== expectedState)
            throw new PricingPublishError('pricing_stale', '该模型的计费配置已被其他人修改，请刷新后重新确认。');
        const before = safeBase(options, name).base;
        let writes: OptionWrite[];
        try {
            writes = planModelWrites(options, name, parsed);
        } catch (error) {
            toPricingError(error);
        }
        const readback = writes.length ? await writeAndVerify(writes) : options;
        const rows = await snapshotCatalog(
            tx,
            tenantId,
            readback,
            context.admin.user?.id ?? null,
            ({ upstream_model }) => upstream_model === name,
        );
        await audit(tx, context, 'pricing_model_base', name, { before, after: parsed, catalog_rows: rows });
        return { unchanged: writes.length === 0, written_keys: writes.map((write) => write.key), catalog_rows: rows };
    }, TX_OPTIONS);
}

function videoQuoteWarnings(
    options: Record<string, unknown>,
    name: string,
    overrides: number,
    rule: CostRuleRow | undefined,
): string[] {
    const warnings: string[] = [
        '计费系数按两位小数向上取整，客户实付可能比目标价略高，不会更低。',
        'new-api 按模型名计价，所有渠道里同名模型的请求都按新系数扣费。',
    ];
    if (overrides) warnings.push(`${overrides} 位客户在该档次有专属倍率，他们的价格按同一比例变化。`);
    const stored = storedQuote(rule);
    if (stored && !stored.quote) warnings.push('该档次已有的按秒成本草稿会被这份按 token 的报价替换。');
    warnings.push(...notesFor(options, name));
    return warnings;
}

export async function previewVideoQuote(
    admin: AdminPrincipal,
    name: string,
    input: VideoQuoteInput,
): Promise<SimpleVideoQuotePreview> {
    const tenantId = tenantForInsert(admin);
    const [catalog, options, counts] = await Promise.all([
        loadCatalog(tenantId),
        getPricingPublishOptions(),
        loadCounts(tenantId),
    ]);
    const plan = planVideoQuote(catalog, options, name, input);
    if (counts.managed.has(plan.group.newapi_group)) await assertGroupsUnmanaged(prisma, [plan.group.newapi_group]);
    const rule = await prisma.pricingCostRule.findUnique({
        where: { model_id_tier: { model_id: plan.model.id, tier: plan.tier } },
        select: { id: true, model_id: true, tier: true, revision: true, config: true, updated_at: true },
    });
    const live = new Map(plan.current.cells.map((cell) => [videoTokenKey(cell), cell.price]));
    return {
        unchanged: plan.writes.length === 0,
        tier: plan.tier,
        group_ratio: plan.ratio,
        cells: plan.cells.map((cell) => {
            const current = live.get(videoTokenKey(cell))!;
            return { ...cell, current_coefficient: current, current_actual: round(current * BASE_FX * plan.ratio, 6) };
        }),
        warnings: videoQuoteWarnings(options, name, counts.overrides.get(plan.tier) ?? 0, rule ?? undefined),
    };
}

/**
 * Store the quote as the model's Portal cost rule and write the matching
 * coefficients to new-api, in one database transaction: the rule is validated
 * and saved first (so a refused rule never reaches new-api), then new-api is
 * written and read back, then the catalog snapshot and audit follow.
 */
export async function saveVideoQuote(
    context: SimplePricingContext,
    name: string,
    input: VideoQuoteInput,
    expectedState: string,
    expectedRevision: number | null,
): Promise<SaveResult> {
    const tenantId = tenantForInsert(context.admin);
    return prisma.$transaction(async (tx) => {
        await assertPricingCatalogWritable(tx);
        const [catalog, options] = await Promise.all([loadCatalog(tenantId, tx), getPricingPublishOptions()]);
        if (modelOptionState(options, name) !== expectedState)
            throw new PricingPublishError('pricing_stale', '该模型的计费配置已被其他人修改，请刷新后重新确认。');
        let plan: ReturnType<typeof planVideoQuote>;
        try {
            plan = planVideoQuote(catalog, options, name, input);
        } catch (error) {
            toPricingError(error);
        }
        await assertGroupsUnmanaged(tx, [plan.group.newapi_group]);
        const existing = await tx.pricingCostRule.findUnique({
            where: { model_id_tier: { model_id: plan.model.id, tier: plan.tier } },
            select: { id: true, model_id: true, tier: true, revision: true, config: true, updated_at: true },
        });
        if ((existing?.revision ?? null) !== expectedRevision)
            throw new PricingPublishError('pricing_cost_revision', '该模型的报价已被其他人修改，请刷新后重新确认。');
        const config = videoQuoteCostConfig(input);
        const before = storedQuote(existing ?? undefined)?.quote ?? null;
        const ruleChanged = !before || JSON.stringify(videoQuoteCostConfig(before)) !== JSON.stringify(config);
        if (ruleChanged)
            await saveCostRulesInTransaction(
                tx,
                [{ model_id: plan.model.id, tier: plan.tier, expected_revision: expectedRevision, config }],
                context.admin,
                { videoTokenQuote: true },
            );
        const readback = plan.writes.length ? await writeAndVerify(plan.writes) : options;
        const rows = await snapshotCatalog(
            tx,
            tenantId,
            readback,
            context.admin.user?.id ?? null,
            ({ upstream_model }) => upstream_model === name,
        );
        await audit(tx, context, 'pricing_video_quote', name, {
            tier: plan.tier,
            group_ratio: plan.ratio,
            before: { quote: before, coefficients: plan.current.cells.map((cell) => cell.price) },
            after: { quote: input, coefficients: plan.cells.map((cell) => cell.coefficient) },
            catalog_rows: rows,
        });
        return {
            unchanged: plan.writes.length === 0 && !ruleChanged,
            written_keys: plan.writes.map((write) => write.key),
            catalog_rows: rows,
        };
    }, TX_OPTIONS);
}

/** Rewrite every stale/missing catalog snapshot from what new-api bills now. Never writes new-api. */
export async function resyncCatalog(context: SimplePricingContext): Promise<SaveResult> {
    const tenantId = tenantForInsert(context.admin);
    return prisma.$transaction(async (tx) => {
        await assertPricingCatalogWritable(tx);
        const options = await getPricingPublishOptions();
        const rows = await snapshotCatalog(tx, tenantId, options, context.admin.user?.id ?? null, () => true);
        await audit(tx, context, 'pricing_catalog_resync', tenantId, { catalog_rows: rows });
        return { unchanged: rows === 0, written_keys: [], catalog_rows: rows };
    }, TX_OPTIONS);
}

/** 进货率 is Portal-only bookkeeping for margins and upstream checks; it never touches new-api. */
export async function savePurchaseRate(
    context: SimplePricingContext,
    groupId: string,
    rate: number | null,
): Promise<{ purchase_rate: number | null }> {
    if (rate !== null && (!Number.isFinite(rate) || rate <= 0 || rate > 1000))
        throw new SimplePricingError('pricing_purchase_rate_invalid', '进货率须为 0 到 1000 之间的正数。', 400);
    const tenantId = tenantForInsert(context.admin);
    const next = rate === null ? null : round(rate, 6);
    return prisma.$transaction(async (tx) => {
        const group = tierGroup(await loadCatalog(tenantId, tx), groupId);
        await tx.channelGroup.update({ where: { id: group.id }, data: { purchase_rate: next } });
        await audit(tx, context, 'pricing_tier_purchase_rate', group.key, {
            before: num(group.purchase_rate),
            after: next,
        });
        return { purchase_rate: next };
    });
}

// ── bill check ──

export interface LoggedBillLookup {
    log: LoggedBill;
    /** Enabled tier whose new-api group billed this request; null when none matches. */
    tier: string | null;
}

/** Read one consume log by request_id for the bill check. Read-only against new-api. */
export async function lookupBillLog(admin: AdminPrincipal, requestId: string): Promise<LoggedBillLookup> {
    const tenantId = tenantForInsert(admin);
    const [catalog, logs] = await Promise.all([
        loadCatalog(tenantId),
        queryLogs({ request_id: requestId, type: 2, page_size: 5 }),
    ]);
    const row = logs.items.find((item) => item.request_id === requestId);
    if (!row) throw new SimplePricingError('pricing_log_not_found', '没有找到这条消费日志，请核对 request_id。', 404);
    const log = parseLoggedBill(row);
    return { log, tier: catalog.groups.find((group) => group.newapi_group === log.group)?.key ?? null };
}

// ── runtime check ──

export interface RuntimeCheck {
    name: string;
    ok: boolean;
    diffs: string[];
}

/**
 * Compare new-api's public /api/pricing with its options. Informational only:
 * new-api may cache the pricing page for about a minute after a save.
 */
export async function verifyRuntime(names: string[]): Promise<{ models: RuntimeCheck[]; groups: RuntimeCheck[] }> {
    const [options, runtime] = await Promise.all([getPricingPublishOptions(), getPricingRuntimeModels(names)]);
    const models = runtime.models.map((row): RuntimeCheck => {
        const diffs: string[] = [];
        if (hasTimeOfDayPrice(options, row.model_name)) {
            // Portal never writes these; only check that new-api's runtime holds the configured formula.
            const expression = optionDict(options, EXPR_KEY, true)[row.model_name];
            if (row.billing_mode !== 'tiered_expr' || row.billing_expr !== expression)
                diffs.push('分时段公式与配置不一致。');
            return { name: row.model_name, ok: diffs.length === 0, diffs };
        }
        const base = safeBase(options, row.model_name).base;
        if (!base) diffs.push('Portal 读不到该模型的基础价。');
        else if (base.mode === 'per_call') {
            if (row.quota_type !== 1 || !sameNumber(row.model_price, base.price)) diffs.push('按次价与配置不一致。');
        } else if (base.mode === 'tiered' || base.mode === 'video_token') {
            const expression = optionDict(options, EXPR_KEY, true)[row.model_name];
            if (row.billing_mode !== 'tiered_expr' || row.billing_expr !== expression)
                diffs.push('阶梯公式与配置不一致。');
        } else {
            if (row.quota_type !== 0) diffs.push('计费方式不是按 Token。');
            if (!sameNumber(row.model_ratio, base.input / RATIO_UNIT)) diffs.push('输入倍率与配置不一致。');
            if (base.input > 0 && !sameNumber(row.completion_ratio, base.output / base.input))
                diffs.push('输出倍率与配置不一致。');
            const mode = optionDict(options, MODE_KEY, true)[row.model_name];
            if (row.billing_mode === 'tiered_expr' || mode === 'tiered_expr') diffs.push('运行时仍在阶梯模式。');
        }
        return { name: row.model_name, ok: diffs.length === 0, diffs };
    });
    const configured = optionDict(options, 'GroupRatio');
    const groups = Object.entries(runtime.group_ratio).map(([group, ratio]): RuntimeCheck => {
        const expected = configured[group];
        const ok = typeof expected === 'number' && sameNumber(expected, ratio);
        return {
            name: group,
            ok,
            diffs: ok ? [] : [`运行时倍率 ${ratio} 与配置 ${String(expected ?? '无')} 不一致。`],
        };
    });
    return { models, groups };
}

export { SimplePricingError };
