import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCatalogGuard = vi.fn();
vi.mock('@/lib/admin/pricing-publish-lock', async () => ({
    ...(await vi.importActual<typeof import('@/lib/admin/pricing-publish-lock')>('@/lib/admin/pricing-publish-lock')),
    assertPricingCatalogWritable: (...args: unknown[]) => mockCatalogGuard(...args),
}));
import { PricingPublishError } from '@/lib/admin/pricing-publish-lock';
import type { NewApiSyncSource } from '@/lib/admin/newapi-sync-source';
import type { SyncGroup, SyncModel, SyncPrice } from '@/lib/admin/newapi-sync-plan';

const mocked = vi.hoisted(() => ({
    source: vi.fn(),
    db: {
        channelGroup: { findMany: vi.fn() },
        catalogModel: { findMany: vi.fn() },
        catalogPrice: { findMany: vi.fn() },
        $transaction: vi.fn(),
    },
}));
vi.mock('@/lib/db', () => ({ prisma: mocked.db }));
vi.mock('@/lib/admin/newapi-sync-source', () => ({ readNewApiSyncSource: mocked.source }));

import { applyNewApiSync, previewNewApiSync } from '@/lib/admin/newapi-sync';

const TENANT = 'tenant-a';
const FOREIGN = 'tenant-b';
const NOW = Date.parse('2026-09-11T08:00:00.000Z');
const OLD = new Date(NOW - 60_000);
type GroupRow = Omit<SyncGroup, 'updated_at'> & { tenant_id: string; updated_at: Date };
type ModelRow = Omit<SyncModel, 'updated_at'> & { tenant_id: string; updated_at: Date };
type PriceRow = Omit<SyncPrice, 'effective_from'> & { effective_from: Date; created_by?: string | null };
interface Store {
    groups: GroupRow[];
    models: ModelRow[];
    prices: PriceRow[];
}
interface ReadArgs {
    where: { tenant_id?: string; model?: { tenant_id: string } };
}
interface UpdateArgs<T> {
    where: { id: string; tenant_id: string; updated_at: Date };
    data: Partial<T>;
}
let store: Store;
let source: NewApiSyncSource;
let writes: string[];
let failPriceWrite: boolean;

function group(tenant = TENANT): GroupRow {
    return {
        id: `${tenant}-group`,
        tenant_id: tenant,
        key: 'sale',
        display_name: 'Sale',
        newapi_group: 'sale',
        newapi_channel_ids: [1],
        enabled: true,
        is_default: true,
        tier_level: 0,
        updated_at: OLD,
    };
}
function model(tenant = TENANT): ModelRow {
    return {
        id: `${tenant}-model`,
        tenant_id: tenant,
        slug: 'gpt-test',
        display_name: 'GPT Test',
        vendor: 'openai',
        modality: 'chat',
        enabled: true,
        sort_order: 0,
        upstream_map: { sale: { channel_id: 1, upstream_model: 'gpt-test' } },
        updated_at: OLD,
    };
}
function price(tenant = TENANT): PriceRow {
    return {
        id: `${tenant}-price`,
        model_id: `${tenant}-model`,
        tier: 'sale',
        effective_from: OLD,
        input_cny_per_1m: 0.1234,
        output_cny_per_1m: 0.5678,
        per_image_cny: null,
        cost_cny_per_1m: 0.02,
    };
}
function dbFor(getStore: () => Store) {
    const update = <T extends { id: string; tenant_id: string; updated_at: Date }>(rows: T[], args: UpdateArgs<T>) => {
        const row = rows.find(
            (value) =>
                value.id === args.where.id &&
                value.tenant_id === args.where.tenant_id &&
                value.updated_at.getTime() === args.where.updated_at.getTime(),
        );
        if (!row) throw { code: 'P2025' };
        Object.assign(row, args.data, { updated_at: new Date(Date.now()) });
        return structuredClone(row);
    };
    return {
        channelGroup: {
            findMany: async ({ where }: ReadArgs) =>
                structuredClone(getStore().groups.filter((row) => row.tenant_id === where.tenant_id)),
            create: async ({ data }: { data: Omit<GroupRow, 'id' | 'updated_at'> }) => {
                writes.push('group:create');
                const row = { ...data, id: `new-group-${getStore().groups.length}`, updated_at: new Date(Date.now()) };
                getStore().groups.push(row);
                return structuredClone(row);
            },
            update: async (args: UpdateArgs<GroupRow>) => {
                writes.push('group:update');
                return update(getStore().groups, args);
            },
        },
        catalogModel: {
            findMany: async ({ where }: ReadArgs) =>
                structuredClone(getStore().models.filter((row) => row.tenant_id === where.tenant_id)),
            create: async ({ data }: { data: Omit<ModelRow, 'id' | 'updated_at'> }) => {
                writes.push('model:create');
                const row = { ...data, id: `new-model-${getStore().models.length}`, updated_at: new Date(Date.now()) };
                getStore().models.push(row);
                return structuredClone(row);
            },
            update: async (args: UpdateArgs<ModelRow>) => {
                writes.push('model:update');
                return update(getStore().models, args);
            },
        },
        catalogPrice: {
            findMany: async ({ where }: ReadArgs) => {
                const ids = new Set(
                    getStore()
                        .models.filter((row) => row.tenant_id === where.model?.tenant_id)
                        .map((row) => row.id),
                );
                return structuredClone(getStore().prices.filter((row) => ids.has(row.model_id)));
            },
            create: async ({ data }: { data: Omit<PriceRow, 'id' | 'effective_from'> }) => {
                writes.push('price:create');
                if (failPriceWrite) throw new Error('fixture database failure');
                const row = {
                    ...data,
                    id: `new-price-${getStore().prices.length}`,
                    effective_from: new Date(Date.now()),
                };
                getStore().prices.push(row);
                return structuredClone(row);
            },
        },
    };
}
function addExternalGroup() {
    source.groups.external = 'External';
    source.channels.push({ id: 13, name: 'External', status: 1, groups: ['external'], models: ['claude-new'] });
    source.prices.modelRatio = { ...(source.prices.modelRatio as object), 'claude-new': 1 };
    source.prices.completionRatio = { ...(source.prices.completionRatio as object), 'claude-new': 2 };
    source.prices.groupRatio = { sale: 1, external: 1 };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv('PORTAL_JWT_SECRET', 'local-fixture-preview-signature-secret');
    store = { groups: [group(), group(FOREIGN)], models: [model(), model(FOREIGN)], prices: [price(), price(FOREIGN)] };
    source = {
        channels: [{ id: 1, name: 'Sale', status: 1, groups: ['sale'], models: ['gpt-test', 'gpt-new'] }],
        groups: { sale: 'Sale' },
        prices: {
            modelRatio: { 'gpt-test': 2, 'gpt-new': 1 },
            completionRatio: { 'gpt-test': 3, 'gpt-new': 2 },
            modelPrice: {},
            groupRatio: { sale: 1 },
        },
    };
    writes = [];
    failPriceWrite = false;
    mocked.source.mockImplementation(async () => structuredClone(source));
    const liveDb = dbFor(() => store);
    mocked.db.channelGroup.findMany.mockImplementation(liveDb.channelGroup.findMany);
    mocked.db.catalogModel.findMany.mockImplementation(liveDb.catalogModel.findMany);
    mocked.db.catalogPrice.findMany.mockImplementation(liveDb.catalogPrice.findMany);
    // Copy-on-write transaction: earlier writes become visible only if the complete
    // callback succeeds. On an exception the independent working copy is discarded.
    mocked.db.$transaction.mockImplementation(async (callback: (tx: ReturnType<typeof dbFor>) => Promise<unknown>) => {
        const working = structuredClone(store);
        const result = await callback(dbFor(() => working));
        store = working;
        return result;
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('new-api sync signed preview and transactional apply', () => {
    it('previews real changes without writes or a transaction', async () => {
        const before = structuredClone(store);
        const preview = await previewNewApiSync(TENANT);
        expect(preview.preview_token).toMatch(/^\d{13}\.[a-f0-9]{64}$/);
        expect(preview.items.some((row) => row.kind === 'model' && row.change === 'create')).toBe(true);
        expect(preview.summary).toMatchObject({ models_published: 1, prices_updated: 2 });
        expect(preview.blocked).toBeNull();
        expect(preview.items.some((row) => row.kind === 'price' && row.change === 'update')).toBe(true);
        expect(writes).toEqual([]);
        expect(store).toEqual(before);
        expect(mocked.db.$transaction).not.toHaveBeenCalled();
    });

    it.each(['portal', 'upstream'] as const)('rejects a preview after %s state changed', async (location) => {
        const preview = await previewNewApiSync(TENANT);
        if (location === 'portal') store.models[0].display_name = 'Edited by another admin';
        else source.channels[0].models.push('gpt-later');
        await expect(applyNewApiSync(TENANT, 'admin-1', preview.preview_token)).rejects.toMatchObject({
            code: 'preview_stale',
            status: 409,
        });
        expect(writes).toEqual([]);
        expect(mocked.source).toHaveBeenCalledTimes(2);
    });

    it('rejects expired previews before refreshing upstream or opening a transaction', async () => {
        const preview = await previewNewApiSync(TENANT);
        vi.advanceTimersByTime(10 * 60_000 + 1);
        await expect(applyNewApiSync(TENANT, 'admin-1', preview.preview_token)).rejects.toMatchObject({
            code: 'preview_stale',
        });
        expect(mocked.source).toHaveBeenCalledTimes(1);
        expect(mocked.db.$transaction).not.toHaveBeenCalled();
        expect(writes).toEqual([]);
    });

    it('rejects a preview that expires while fresh upstream metadata is being read', async () => {
        const preview = await previewNewApiSync(TENANT);
        vi.advanceTimersByTime(10 * 60_000 - 1);
        mocked.source.mockImplementationOnce(async () => {
            vi.advanceTimersByTime(2);
            return structuredClone(source);
        });
        await expect(applyNewApiSync(TENANT, 'admin-1', preview.preview_token)).rejects.toMatchObject({
            code: 'preview_stale',
        });
        expect(writes).toEqual([]);
    });

    it('rejects a forged signature and a token issued for another tenant', async () => {
        const preview = await previewNewApiSync(TENANT);
        const badToken = `${preview.preview_token.slice(0, 14)}${'0'.repeat(64)}`;
        for (const [tenant, token] of [
            [TENANT, badToken],
            [FOREIGN, preview.preview_token],
        ]) {
            await expect(applyNewApiSync(tenant, null, token)).rejects.toMatchObject({ code: 'preview_stale' });
        }
        expect(writes).toEqual([]);
    });

    it('appends price history once and refuses replaying the same successful preview', async () => {
        const preview = await previewNewApiSync(TENANT);
        const result = await applyNewApiSync(TENANT, 'admin-1', preview.preview_token);
        expect(result.applied).toEqual({ groups: 0, models: 1, prices: 2 });
        expect(store.prices).toContainEqual(price());
        expect(
            store.prices.find((row) => row.model_id === `${TENANT}-model` && row.id !== `${TENANT}-price`),
        ).toMatchObject({ cost_cny_per_1m: 0.02, created_by: 'admin-1' });
        const after = structuredClone(store);
        await expect(applyNewApiSync(TENANT, 'admin-1', preview.preview_token)).rejects.toMatchObject({
            code: 'preview_stale',
        });
        expect(store).toEqual(after);
        expect(mocked.db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
            isolationLevel: 'Serializable',
            timeout: 15000,
        });
    });

    it('enables a new group that has channels and a GroupRatio and publishes its priced models', async () => {
        addExternalGroup();
        const preview = await previewNewApiSync(TENANT);
        await applyNewApiSync(TENANT, null, preview.preview_token);
        expect(store.groups.find((row) => row.key === 'external')).toMatchObject({
            enabled: true,
            is_default: false,
            newapi_channel_ids: [13],
        });
        expect(store.models.find((row) => row.slug === 'claude-new')).toMatchObject({
            enabled: true,
            upstream_map: { external: { channel_id: 13, upstream_model: 'claude-new' } },
        });
        expect(store.models.find((row) => row.slug === 'gpt-new')?.enabled).toBe(true);
    });

    it('does not read or modify another tenant with the same tier key and model slug', async () => {
        const foreignBefore = {
            group: structuredClone(store.groups[1]),
            model: structuredClone(store.models[1]),
            price: structuredClone(store.prices[1]),
        };
        const preview = await previewNewApiSync(TENANT);
        expect(mocked.db.channelGroup.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenant_id: TENANT } }),
        );
        expect(mocked.db.catalogModel.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenant_id: TENANT } }),
        );
        expect(mocked.db.catalogPrice.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { model: { tenant_id: TENANT } } }),
        );
        await applyNewApiSync(TENANT, null, preview.preview_token);
        expect(store.groups.find((row) => row.tenant_id === FOREIGN)).toEqual(foreignBefore.group);
        expect(store.models.find((row) => row.tenant_id === FOREIGN)).toEqual(foreignBefore.model);
        expect(store.prices.filter((row) => row.model_id === `${FOREIGN}-model`)).toEqual([foreignBefore.price]);
    });

    it('rolls back groups and models already written when a later price write fails', async () => {
        addExternalGroup();
        const preview = await previewNewApiSync(TENANT);
        const before = structuredClone(store);
        failPriceWrite = true;
        await expect(applyNewApiSync(TENANT, 'admin-1', preview.preview_token)).rejects.toThrow(
            'fixture database failure',
        );
        expect(writes).toContain('group:create');
        expect(writes).toContain('model:create');
        expect(writes.at(-1)).toBe('price:create');
        expect(store).toEqual(before);
    });
});

describe('new-api sync keeps the catalog aligned', () => {
    it('re-points the registry and mappings together when a channel is replaced', async () => {
        source.channels = [{ ...source.channels[0], id: 14, models: ['gpt-test'] }];
        const beforePrices = structuredClone(store.prices);
        const preview = await previewNewApiSync(TENANT);
        await applyNewApiSync(TENANT, null, preview.preview_token);
        expect(store.groups.find((row) => row.tenant_id === TENANT)?.newapi_channel_ids).toEqual([14]);
        expect(store.models.find((row) => row.tenant_id === TENANT)?.upstream_map.sale.channel_id).toBe(14);
        expect(store.prices.slice(0, beforePrices.length)).toEqual(beforePrices);
    });

    it('unpublishes a model its channel no longer offers, keeping the model and price history', async () => {
        source.channels[0].models = ['gpt-new'];
        const before = structuredClone(store);
        const preview = await previewNewApiSync(TENANT);
        expect(preview.summary).toMatchObject({ models_unpublished: 1, models_published: 1 });
        await applyNewApiSync(TENANT, null, preview.preview_token);
        expect(store.models.find((row) => row.id === `${TENANT}-model`)).toMatchObject({
            enabled: false,
            upstream_map: model().upstream_map,
        });
        expect(store.prices.slice(0, before.prices.length)).toEqual(before.prices);
    });

    it('publishes an unpublished model at the live price, preserving cost and history', async () => {
        store.models[0].enabled = false;
        source.channels[0].models = ['gpt-test'];
        const before = structuredClone(store);
        const preview = await previewNewApiSync(TENANT);
        await applyNewApiSync(TENANT, 'admin-1', preview.preview_token);
        expect(writes).toEqual(['model:update', 'price:create']);
        expect(store.models[0].enabled).toBe(true);
        expect(store.prices.slice(0, before.prices.length)).toEqual(before.prices);
        expect(store.prices.at(-1)).toMatchObject({
            model_id: store.models[0].id,
            cost_cny_per_1m: before.prices[0].cost_cny_per_1m,
            created_by: 'admin-1',
        });
    });

    it.each(['chat', 'image'] as const)(
        'does not publish an existing %s model whose live billing basis contradicts its catalog modality',
        async (modality) => {
            store.models[0].enabled = false;
            store.models[0].modality = modality;
            source.channels[0].models = ['gpt-test'];
            if (modality === 'chat') source.prices.modelPrice = { 'gpt-test': 0.12 };
            const preview = await previewNewApiSync(TENANT);
            expect(preview.items).toEqual([]);
            expect(preview.warnings.join(' ')).toContain('计费方式无法');
            await expect(applyNewApiSync(TENANT, null, preview.preview_token)).rejects.toMatchObject({
                code: 'nothing_to_sync',
            });
            expect(writes).toEqual([]);
        },
    );

    it('refuses to apply when the default tier would lose every channel', async () => {
        source.channels = [];
        const before = structuredClone(store);
        const preview = await previewNewApiSync(TENANT);
        expect(preview.blocked).toContain('默认档次');
        await expect(applyNewApiSync(TENANT, null, preview.preview_token)).rejects.toMatchObject({
            code: 'sync_blocked',
        });
        expect(writes).toEqual([]);
        expect(store).toEqual(before);
    });
});

it('blocks unified catalog synchronization before reads or writes while a price publication is active', async () => {
    const preview = await previewNewApiSync(TENANT);
    mockCatalogGuard.mockRejectedValueOnce(new PricingPublishError('pricing_publish_busy', 'busy'));
    await expect(applyNewApiSync(TENANT, null, preview.preview_token)).rejects.toMatchObject({
        code: 'pricing_publish_busy',
        status: 409,
    });
    expect(writes).toEqual([]);
});
