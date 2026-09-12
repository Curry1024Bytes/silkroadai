import { assertPricingCatalogWritable } from '@/lib/admin/pricing-publish-lock';
import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ChannelGroupTopology, ChannelGroupTopologyError, type UpstreamMapLike } from '@/lib/channel-group-topology';
import { CHAT_FX, IMAGE_FX } from '@/lib/newapi/pricing-sync';
import { readSyncPrice } from '@/lib/newapi/catalog-sync-prices';
import { readNewApiSyncSource, type NewApiSyncSource } from './newapi-sync-source';
import {
    buildNewApiSyncPlan,
    canonicalSync,
    currentSyncPrice,
    type PriceValues,
    type SyncState,
    type SyncPlan,
} from './newapi-sync-plan';
import type { NewApiSyncPreview, NewApiSyncSelection } from './newapi-sync-types';

export class NewApiSyncError extends Error {
    constructor(
        public code: string,
        message: string,
        public status = 409,
    ) {
        super(message);
    }
}
type SyncDb = Pick<Prisma.TransactionClient, 'channelGroup' | 'catalogModel' | 'catalogPrice'>;
function checkedMap(raw: unknown): UpstreamMapLike {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new NewApiSyncError('invalid_catalog', '已有模型映射格式不完整，请先在模型管理中核对。');
    for (const entry of Object.values(raw)) {
        if (
            !entry ||
            typeof entry !== 'object' ||
            !Number.isSafeInteger(entry.channel_id) ||
            entry.channel_id <= 0 ||
            typeof entry.upstream_model !== 'string' ||
            !entry.upstream_model.trim()
        )
            throw new NewApiSyncError('invalid_catalog', '已有模型映射格式不完整，请先在模型管理中核对。');
    }
    return raw as UpstreamMapLike;
}
export async function readSyncState(db: SyncDb, tenantId: string): Promise<SyncState> {
    const [groups, models, prices] = await Promise.all([
        db.channelGroup.findMany({
            where: { tenant_id: tenantId },
            orderBy: { id: 'asc' },
            select: {
                id: true,
                key: true,
                display_name: true,
                newapi_group: true,
                newapi_channel_ids: true,
                enabled: true,
                is_default: true,
                tier_level: true,
                updated_at: true,
            },
        }),
        db.catalogModel.findMany({
            where: { tenant_id: tenantId },
            orderBy: { id: 'asc' },
            select: {
                id: true,
                slug: true,
                display_name: true,
                vendor: true,
                modality: true,
                enabled: true,
                sort_order: true,
                upstream_map: true,
                updated_at: true,
            },
        }),
        db.catalogPrice.findMany({
            where: { model: { tenant_id: tenantId } },
            orderBy: { id: 'asc' },
            select: {
                id: true,
                model_id: true,
                tier: true,
                effective_from: true,
                input_cny_per_1m: true,
                output_cny_per_1m: true,
                per_image_cny: true,
                cost_cny_per_1m: true,
            },
        }),
    ]);
    const numberOrNull = (value: unknown) => (value === null ? null : Number(value));
    return {
        groups: groups.map((row) => ({
            ...row,
            newapi_channel_ids: [...row.newapi_channel_ids].sort((a, b) => a - b),
            updated_at: row.updated_at.toISOString(),
        })),
        models: models.map((row) => ({
            ...row,
            upstream_map: checkedMap(row.upstream_map),
            updated_at: row.updated_at.toISOString(),
        })),
        prices: prices.map((row) => ({
            ...row,
            effective_from: row.effective_from.toISOString(),
            input_cny_per_1m: numberOrNull(row.input_cny_per_1m),
            output_cny_per_1m: numberOrNull(row.output_cny_per_1m),
            per_image_cny: numberOrNull(row.per_image_cny),
            cost_cny_per_1m: numberOrNull(row.cost_cny_per_1m),
        })),
    };
}
function signature(
    tenantId: string,
    state: SyncState,
    source: NewApiSyncSource,
    plan: SyncPlan,
    timestamp: number,
): string {
    const secret = process.env.PORTAL_JWT_SECRET;
    if (!secret) throw new NewApiSyncError('sync_unavailable', '同步预览暂不可用，请检查服务配置。', 503);
    return createHmac('sha256', secret)
        .update(
            canonicalSync({
                purpose: 'newapi-catalog-sync-v1',
                tenantId,
                timestamp,
                state,
                source,
                items: plan.items,
                units: { CHAT_FX, IMAGE_FX },
            }),
        )
        .digest('hex');
}
function publicPreview(plan: SyncPlan, token: string): NewApiSyncPreview {
    return { preview_token: token, items: plan.items, warnings: plan.warnings, unchanged: plan.unchanged };
}
export async function previewNewApiSync(tenantId: string) {
    const [source, state] = await Promise.all([readNewApiSyncSource(), readSyncState(prisma, tenantId)]);
    const now = Date.now();
    const plan = buildNewApiSyncPlan(state, source, now);
    return publicPreview(plan, `${now}.${signature(tenantId, state, source, plan, now)}`);
}

export function validateSyncSelection(
    state: SyncState,
    source: NewApiSyncSource,
    plan: SyncPlan,
    selection: NewApiSyncSelection,
    now: number,
) {
    const selected = new Set(selection.selected),
        activate = new Set(selection.activate);
    const fail = (message: string): never => {
        throw new NewApiSyncError('selection_invalid', message);
    };
    if (!selected.size) fail('请先选择要同步的变化。');
    for (const id of selected) {
        const row = plan.items.find((item) => item.id === id);
        if (!row?.selectable) return fail('所选变化已不可同步，请重新预览。');
        if (row.dependsOn.some((dependency) => !selected.has(dependency)))
            fail(`「${row.title}」的关联变化需要一起选择。`);
    }
    for (const id of activate) {
        if (!selected.has(id) || !plan.items.find((row) => row.id === id)?.canActivate)
            fail('启用或上架项必须先选中对应的同步变化。');
    }
    const groups = new Map(state.groups.map((group) => [group.key, group]));
    for (const change of plan.groups)
        if (selected.has(change.item.id))
            groups.set(change.next.key, {
                ...change.next,
                enabled: change.current?.enabled === true || activate.has(change.item.id),
            });
    const models = new Map(state.models.map((model) => [model.slug, model]));
    for (const change of plan.models)
        if (selected.has(change.item.id))
            models.set(change.next.slug, {
                ...change.next,
                enabled: change.current?.enabled === true || activate.has(change.item.id),
            });
    let topology: ChannelGroupTopology;
    try {
        topology = new ChannelGroupTopology(
            '',
            [...groups.values()].filter((group) => group.enabled),
        );
    } catch (error) {
        if (error instanceof ChannelGroupTopologyError) fail('确认后会产生重复渠道归属或无效默认档，请核对档次选择。');
        throw error;
    }
    for (const model of models.values())
        if (model.enabled && topology.validateUpstreamMap(model.upstream_map).length)
            fail(`「${model.display_name}」仍引用未启用或未登记的档次/渠道，请一起选择相关变更。`);
    const validPrice = (value: PriceValues | null, modality: string): boolean =>
        !!value &&
        (modality === 'image'
            ? value.per_image_cny !== null && Number.isFinite(value.per_image_cny) && value.per_image_cny >= 0
            : value.per_image_cny === null &&
              value.input_cny_per_1m !== null &&
              value.output_cny_per_1m !== null &&
              Number.isFinite(value.input_cny_per_1m) &&
              Number.isFinite(value.output_cny_per_1m) &&
              value.input_cny_per_1m >= 0 &&
              value.output_cny_per_1m >= 0);
    for (const change of plan.models)
        if (activate.has(change.item.id)) {
            const model = models.get(change.next.slug)!;
            for (const [tier, entry] of Object.entries(model.upstream_map)) {
                const group = groups.get(tier);
                const channel = source.channels.find((row) => row.id === entry.channel_id);
                if (
                    !group?.enabled ||
                    !channel ||
                    channel.status !== 1 ||
                    !channel.groups.includes(group.newapi_group) ||
                    !channel.models.includes(entry.upstream_model)
                )
                    return fail(`「${model.display_name}」的档次或渠道尚未就绪，暂不能上架。`);
                const priceChange = plan.prices.find(
                    (price) => price.slug === model.slug && price.tier === tier && selected.has(price.item.id),
                );
                const effectivePrice = priceChange?.next ?? currentSyncPrice(state, model.id, tier, now);
                if (!validPrice(effectivePrice, model.modality))
                    fail(`「${model.display_name}」在「${group.display_name}」尚无完整价格，请先补价或选择价格同步。`);
                if (!/^gpt-image-2-(1k|2k|4k)$/.test(model.slug)) {
                    const livePrice = readSyncPrice(source.prices, entry.upstream_model, group.newapi_group);
                    if (!livePrice.price || (livePrice.basis === 'request') !== (model.modality === 'image'))
                        fail(`「${model.display_name}」的计费方式或当前价格尚待核对，暂不能上架。`);
                    const values = effectivePrice && {
                        input_cny_per_1m: effectivePrice.input_cny_per_1m,
                        output_cny_per_1m: effectivePrice.output_cny_per_1m,
                        per_image_cny: effectivePrice.per_image_cny,
                    };
                    if (canonicalSync(values) !== canonicalSync(livePrice.price))
                        fail(`「${model.display_name}」的目录价格与 new-api 不一致，请一起选择对应的价格同步。`);
                }
            }
        }
    for (const change of plan.prices)
        if (selected.has(change.item.id)) {
            const model = models.get(change.slug),
                group = groups.get(change.tier);
            if (
                !model ||
                !group ||
                !group.newapi_channel_ids.includes(change.mapping.channel_id) ||
                canonicalSync(model.upstream_map[change.tier]) !== canonicalSync(change.mapping)
            )
                fail('价格对应的模型或渠道尚未登记，请一起选择关联变化。');
        }
    return { selected, activate, groups, models };
}

export async function applyNewApiSync(
    tenantId: string,
    userId: string | null,
    token: string,
    selection: NewApiSyncSelection,
) {
    const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(token);
    const timestamp = Number(match?.[1]);
    if (!match || Date.now() - timestamp > 10 * 60_000 || timestamp > Date.now() + 30_000)
        throw new NewApiSyncError('preview_stale', '预览已过期，请重新读取变化后确认。');
    // Refresh upstream metadata before opening the DB transaction; never send new-api writes.
    const source = await readNewApiSyncSource();
    return prisma.$transaction(
        async (tx) => {
            await assertPricingCatalogWritable(tx);
            const state = await readSyncState(tx, tenantId);
            const now = Date.now();
            const plan = buildNewApiSyncPlan(state, source, now);
            const expected = signature(tenantId, state, source, plan, timestamp);
            if (!timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(expected, 'hex')))
                throw new NewApiSyncError('preview_stale', 'new-api 或 Portal 配置已变化，请重新预览后确认。');
            const validated = validateSyncSelection(state, source, plan, selection, now);
            // Upstream reads and transaction acquisition can consume the remaining preview lifetime.
            if (Date.now() - timestamp > 10 * 60_000)
                throw new NewApiSyncError('preview_stale', '预览已过期，请重新读取变化后确认。');
            const applied = { groups: 0, models: 0, prices: 0 };
            for (const change of plan.groups)
                if (validated.selected.has(change.item.id)) {
                    const next = validated.groups.get(change.next.key)!;
                    if (change.current)
                        await tx.channelGroup.update({
                            where: {
                                id: change.current.id,
                                tenant_id: tenantId,
                                updated_at: new Date(change.current.updated_at),
                            },
                            data: { newapi_channel_ids: next.newapi_channel_ids, enabled: next.enabled },
                        });
                    else
                        await tx.channelGroup.create({
                            data: {
                                tenant_id: tenantId,
                                key: next.key,
                                display_name: next.display_name,
                                newapi_group: next.newapi_group,
                                newapi_channel_ids: next.newapi_channel_ids,
                                enabled: next.enabled,
                                is_default: false,
                                tier_level: next.tier_level,
                            },
                        });
                    applied.groups++;
                }
            const ids = new Map(state.models.map((model) => [model.slug, model.id]));
            for (const change of plan.models)
                if (validated.selected.has(change.item.id)) {
                    const next = validated.models.get(change.next.slug)!;
                    if (change.current)
                        await tx.catalogModel.update({
                            where: {
                                id: change.current.id,
                                tenant_id: tenantId,
                                updated_at: new Date(change.current.updated_at),
                            },
                            data: {
                                upstream_map: next.upstream_map as unknown as Prisma.InputJsonValue,
                                enabled: next.enabled,
                            },
                        });
                    else {
                        const created = await tx.catalogModel.create({
                            data: {
                                tenant_id: tenantId,
                                slug: next.slug,
                                display_name: next.display_name,
                                vendor: next.vendor,
                                modality: next.modality,
                                sort_order: next.sort_order,
                                upstream_map: next.upstream_map as unknown as Prisma.InputJsonValue,
                                enabled: next.enabled,
                            },
                        });
                        ids.set(next.slug, created.id);
                    }
                    applied.models++;
                }
            for (const change of plan.prices)
                if (validated.selected.has(change.item.id)) {
                    await tx.catalogPrice.create({
                        data: {
                            model_id: ids.get(change.slug)!,
                            tier: change.tier,
                            ...change.next,
                            cost_cny_per_1m: change.current?.cost_cny_per_1m ?? null,
                            created_by: userId,
                        },
                    });
                    applied.prices++;
                }
            return { preview: publicPreview(plan, token), applied };
        },
        { isolationLevel: 'Serializable', timeout: 15000 },
    );
}
