import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getPricingPublishOptions, getPricingRuntimeModels, putPricingPublishOption } from '@/lib/newapi/client';
import { parseTieredPricingDetails } from '@/lib/models/tiered-pricing-details';
import { assertPricingCatalogWritable, PricingPublishError } from './pricing-publish-lock';
import { tenantForInsert } from './tenant-scope';
import { tierOrder } from './pricing-tiers';
import type { AdminPrincipal } from './auth';
import {
    BASE_FX,
    EXPR_KEY,
    MODE_KEY,
    RATIO_UNIT,
    SimplePricingError,
    basePriceSchema,
    catalogMatches,
    customerPrice,
    groupRatioOf,
    modelOptionState,
    optionDict,
    planGroupRatioWrites,
    planModelWrites,
    readBasePrice,
    sameNumber,
    unverifiedWrites,
    type BasePrice,
    type CatalogAmounts,
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
    active_keys: number;
    customer_overrides: number;
    model_count: number;
}

export interface SimpleCell {
    tier: string;
    upstream_model: string;
    status: CellStatus;
    catalog: CatalogAmounts | null;
    expected: CatalogAmounts | null;
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
    /** Optimistic-lock token for save_model. */
    state: string;
    /** new-api forces output = input × this ratio for token pricing. */
    locked_completion: number | null;
    /** new-api rules that also change the charge and are not edited here. */
    notes: string[];
    used_by: Array<{ model_id: string; slug: string; display_name: string; modality: string; tier: string }>;
}

export interface SimplePricingView {
    units: { base_fx: number; ratio_unit: number };
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
            select: { id: true, key: true, display_name: true, newapi_group: true, tier_level: true },
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
        details = parseTieredPricingDetails(row.billing_details);
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
    counts: { keys: Map<string, number>; overrides: Map<string, number> },
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
                return {
                    tier,
                    upstream_model,
                    status:
                        status !== 'ok'
                            ? status
                            : !current
                              ? 'missing'
                              : catalogMatches(current, expected!)
                                ? 'ok'
                                : 'mismatch',
                    catalog: current,
                    expected,
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
        units: { base_fx: BASE_FX, ratio_unit: RATIO_UNIT },
        tiers: catalog.groups.map((group) => ({
            id: group.id,
            key: group.key,
            display_name: group.display_name,
            newapi_group: group.newapi_group,
            ratio: groupRatioOf(options, group.newapi_group),
            active_keys: counts.keys.get(group.key) ?? 0,
            customer_overrides: counts.overrides.get(group.key) ?? 0,
            model_count: modelCount.get(group.key) ?? 0,
        })),
        models,
        upstream_models: [...upstream.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
}

async function loadCounts(tenantId: string) {
    const [keys, overrides] = await Promise.all([
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
    ]);
    return {
        keys: new Map(keys.map((row) => [row.tier, row._count._all])),
        overrides: new Map(overrides.map((row) => [row.tier_key, row._count._all])),
    };
}

export async function loadSimplePricing(admin: AdminPrincipal): Promise<SimplePricingView> {
    const tenantId = tenantForInsert(admin);
    const [catalog, options, counts] = await Promise.all([
        loadCatalog(tenantId),
        getPricingPublishOptions(),
        loadCounts(tenantId),
    ]);
    return buildView(catalog, options, counts);
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

export async function previewModel(admin: AdminPrincipal, name: string, base: BasePrice): Promise<SimplePreview> {
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

async function snapshotCatalog(
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
    base: BasePrice,
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
        const base = safeBase(options, row.model_name).base;
        if (!base) diffs.push('Portal 读不到该模型的基础价。');
        else if (base.mode === 'per_call') {
            if (row.quota_type !== 1 || !sameNumber(row.model_price, base.price)) diffs.push('按次价与配置不一致。');
        } else if (base.mode === 'tiered') {
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
