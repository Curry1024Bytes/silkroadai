import { assertPricingCatalogWritable } from '@/lib/admin/pricing-publish-lock';
import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { UpstreamMapLike } from '@/lib/channel-group-topology';
import { CHAT_FX, IMAGE_FX } from '@/lib/newapi/pricing-sync';
import { readNewApiSyncSource, type NewApiSyncSource } from './newapi-sync-source';
import { buildNewApiSyncPlan, canonicalSync, type SyncState, type SyncPlan } from './newapi-sync-plan';
import type { NewApiSyncPreview } from './newapi-sync-types';

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
    return {
        preview_token: token,
        items: plan.items,
        summary: plan.summary,
        warnings: plan.warnings,
        blocked: plan.blocked,
        unchanged: plan.unchanged,
    };
}
export async function previewNewApiSync(tenantId: string) {
    const [source, state] = await Promise.all([readNewApiSyncSource(), readSyncState(prisma, tenantId)]);
    const now = Date.now();
    const plan = buildNewApiSyncPlan(state, source, now);
    return publicPreview(plan, `${now}.${signature(tenantId, state, source, plan, now)}`);
}

export async function applyNewApiSync(tenantId: string, userId: string | null, token: string) {
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
            if (plan.blocked) throw new NewApiSyncError('sync_blocked', plan.blocked);
            if (!plan.items.length) throw new NewApiSyncError('nothing_to_sync', '目录已与 new-api 一致，无需同步。');
            // Upstream reads and transaction acquisition can consume the remaining preview lifetime.
            if (Date.now() - timestamp > 10 * 60_000)
                throw new NewApiSyncError('preview_stale', '预览已过期，请重新读取变化后确认。');
            const applied = { groups: 0, models: 0, prices: 0 };
            for (const { current, next } of plan.groups) {
                if (current)
                    await tx.channelGroup.update({
                        where: { id: current.id, tenant_id: tenantId, updated_at: new Date(current.updated_at) },
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
            for (const { current, next } of plan.models) {
                const upstreamMap = next.upstream_map as unknown as Prisma.InputJsonValue;
                if (current)
                    await tx.catalogModel.update({
                        where: { id: current.id, tenant_id: tenantId, updated_at: new Date(current.updated_at) },
                        data: { upstream_map: upstreamMap, enabled: next.enabled },
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
                            upstream_map: upstreamMap,
                            enabled: next.enabled,
                        },
                    });
                    ids.set(next.slug, created.id);
                }
                applied.models++;
            }
            for (const change of plan.prices) {
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
