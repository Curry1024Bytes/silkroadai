import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PricingPublishJob as StoredJob } from '@prisma/client';
import type { AdminPrincipal } from '@/lib/admin/auth';

const mocks = vi.hoisted(() => ({
    db: {
        catalogModel: { findMany: vi.fn(), findFirst: vi.fn() },
        catalogPrice: { findMany: vi.fn() },
        channelGroup: { findMany: vi.fn() },
        channelGroupRetirementJob: { findFirst: async () => null },
        pricingPublishCoordinator: { findUnique: vi.fn() },
        pricingPublishJob: { findMany: vi.fn() },
        $transaction: vi.fn(),
    },
    options: vi.fn(),
    channels: vi.fn(),
    persisted: vi.fn(),
    runtime: vi.fn(),
    put: vi.fn(),
    beginWrite: vi.fn(),
    ackWrite: vi.fn(),
    uncertain: vi.fn(),
    costGuard: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: mocks.db }));
vi.mock('@/lib/newapi/client', () => ({
    getPricingPublishOptions: mocks.options,
    listChannelsForCatalogSync: mocks.channels,
    putPricingPublishOption: mocks.put,
    getPricingRuntimeModels: mocks.runtime,
}));
vi.mock('@/lib/newapi/persisted-pricing', () => ({
    readPersistedPricingOptions: mocks.persisted,
    readPersistedTieredPricingOptions: mocks.persisted,
}));
vi.mock('@/lib/admin/pricing-publish-journal', () => ({
    beginPricingWrite: mocks.beginWrite,
    acknowledgePricingWrite: mocks.ackWrite,
    readUncertainPricingWrites: mocks.uncertain,
}));
vi.mock('@/lib/admin/pricing-cost-publication-guard', () => ({ assertPricingCostContext: mocks.costGuard }));
vi.mock('@/lib/newapi/quota-units', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    QUOTA_PER_USD: 500_000,
    USD_TO_CNY_RATE: 1,
    quotaToCny: (quota: number) => quota / 500_000,
}));

import {
    previewPricingBatch,
    enqueuePricingBatch,
    runPricingPublisherOnce,
    changePricingJob,
} from '../pricing-publish';
import { EXPRESSION_KEY, TIERED_PRICE_KEYS } from '../pricing-tiered-plan';
import type { PricingPublishInput, TieredPricingDetails } from '../pricing-publish-types';
import type { PublishSource, PublishState } from '../pricing-publish-plan';
import type { CostBatchContext } from '../pricing-cost-publication-guard';

const NOW = Date.parse('2026-09-16T13:00:00Z');
const MODEL = '11111111-1111-4111-8111-111111111111';
const EXPRESSION = 'len < 272000 ? tier("base", p * 5 + c * 30 + cr * 0.5) : tier("tier_2", p * 10 + c * 45 + cr * 1)';
const UNIFORM = 'tier("uniform", p * 5 + c * 30 + cr * 0.5)';
const ADMIN: AdminPrincipal = { role: 'superadmin', tenant_id: 'tenant', user: null, viaBreakGlass: true };
const CONTEXT: CostBatchContext = {
    selections: [{ rule_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 1 }],
    fingerprint: 'confirmed-cost',
};
type ModelRow = Omit<PublishState['models'][number], 'updated_at'> & { updated_at: Date };
type GroupRow = Omit<PublishState['groups'][number], 'updated_at'> & { updated_at: Date };
type PriceRow = Omit<PublishState['prices'][number], 'effective_from'> & {
    effective_from: Date;
    billing_details?: TieredPricingDetails;
    created_by?: string | null;
};
interface Store {
    models: ModelRow[];
    groups: GroupRow[];
    prices: PriceRow[];
    jobs: StoredJob[];
    coordinator: { id: string; revision: number; active_job_id: string | null } | null;
}
let store: Store, live: Record<string, unknown>, disk: Record<string, unknown>;
let channels: PublishSource['channels'];
let runtimeExpression: string, runtimeRatio: number, runtimeGroups: string[], runtimeMode: string;
let holdRuntime: boolean, holdPersistence: boolean, writeFailure: 'before' | 'after' | null;
let journal: Array<{ id: string; jobId: string; acknowledged: boolean }>;
let dbTail: Promise<unknown>, insertFailure: boolean;

function input(changed = false): PricingPublishInput {
    return {
        model_id: MODEL,
        tier: 'enterprise',
        input_cny_per_1m: changed ? 0.9 : 0.8,
        output_cny_per_1m: changed ? 5.4 : 4.8,
        cache_read_cny_per_1m: changed ? 0.09 : 0.08,
        per_image_cny: null,
        cost_cny_per_1m: null,
    };
}

function dbFor(read: () => Store) {
    return {
        catalogModel: {
            findMany: async () => structuredClone(read().models),
            findFirst: async ({ where }: { where: { id: string; tenant_id?: string } }) =>
                structuredClone(
                    read().models.find(
                        (row) => row.id === where.id && (!where.tenant_id || row.tenant_id === where.tenant_id),
                    ) ?? null,
                ),
        },
        channelGroup: { findMany: async () => structuredClone(read().groups) },
        catalogPrice: {
            findMany: async () => structuredClone(read().prices),
            create: async ({ data }: { data: Omit<PriceRow, 'id'> }) => {
                if (insertFailure) {
                    insertFailure = false;
                    throw new Error('catalog INSERT disconnected');
                }
                const row = { ...data, id: `new-${read().prices.length}` };
                read().prices.push(row);
                return structuredClone(row);
            },
        },
        channelGroupRetirementJob: { findFirst: async () => null },
        pricingPublishCoordinator: {
            findUnique: async () => structuredClone(read().coordinator),
            upsert: async () => {
                const current = read();
                current.coordinator ??= { id: 'newapi', revision: 0, active_job_id: null };
                current.coordinator.revision++;
                return structuredClone(current.coordinator);
            },
            update: async ({
                where,
                data,
            }: {
                where: { active_job_id?: string };
                data: { active_job_id?: string | null; revision?: { increment: number } };
            }) => {
                const row = read().coordinator;
                if (!row || (where.active_job_id && row.active_job_id !== where.active_job_id)) throw { code: 'P2025' };
                if ('active_job_id' in data) row.active_job_id = data.active_job_id ?? null;
                if (data.revision) row.revision += data.revision.increment;
                return structuredClone(row);
            },
        },
        pricingPublishJob: {
            findUnique: async ({ where }: { where: { id?: string; preview_hash?: string } }) =>
                structuredClone(
                    read().jobs.find((row) =>
                        where.id ? row.id === where.id : row.preview_hash === where.preview_hash,
                    ) ?? null,
                ),
            findFirst: async ({ where }: { where: { id: string; tenant_id?: string } }) =>
                structuredClone(
                    read().jobs.find(
                        (row) => row.id === where.id && (!where.tenant_id || row.tenant_id === where.tenant_id),
                    ) ?? null,
                ),
            findMany: async () => structuredClone(read().jobs),
            create: async ({
                data,
            }: {
                data: Omit<StoredJob, 'id' | 'created_at' | 'updated_at' | 'attempts' | 'applied_at'>;
            }) => {
                const row: StoredJob = {
                    ...data,
                    id: `33333333-3333-4333-8333-${String(read().jobs.length + 1).padStart(12, '0')}`,
                    attempts: 0,
                    applied_at: null,
                    created_at: new Date(),
                    updated_at: new Date(),
                };
                read().jobs.push(row);
                return structuredClone(row);
            },
            update: async ({ where, data }: { where: { id: string }; data: Partial<StoredJob> }) => {
                const row = read().jobs.find((item) => item.id === where.id);
                if (!row) throw { code: 'P2025' };
                Object.assign(row, data, { updated_at: new Date() });
                return structuredClone(row);
            },
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv('PORTAL_JWT_SECRET', 'test-only-publication-signing-secret-long-enough');
    const date = new Date(NOW - 60_000);
    store = {
        coordinator: null,
        jobs: [],
        models: [
            {
                id: MODEL,
                tenant_id: 'tenant',
                slug: 'gpt-5.5',
                display_name: 'GPT 5.5',
                modality: 'chat',
                enabled: true,
                updated_at: date,
                upstream_map: { enterprise: { channel_id: 5, upstream_model: 'gpt-5.5' } },
            },
        ],
        groups: [
            {
                id: 'enterprise',
                tenant_id: 'tenant',
                key: 'enterprise',
                display_name: 'Enterprise',
                newapi_group: 'Enterprise',
                newapi_channel_ids: [5],
                enabled: true,
                is_default: true,
                tier_level: 0,
                updated_at: date,
            },
        ],
        prices: [
            {
                id: 'original',
                model_id: MODEL,
                tier: 'enterprise',
                input_cny_per_1m: 0.8,
                output_cny_per_1m: 4.8,
                per_image_cny: null,
                cost_cny_per_1m: 0.65,
                effective_from: date,
            },
        ],
    };
    live = {
        ModelRatio: { 'gpt-5.5': 2.5, untouched: 8 },
        CompletionRatio: { 'gpt-5.5': 6, untouched: 9 },
        ModelPrice: {},
        CompletionRatioMeta: { 'gpt-5.5': { ratio: 6, locked: false } },
        GroupRatio: { Enterprise: 0.16 },
        GroupGroupRatio: {},
        QuotaPerUnit: '500000',
        ImageResolutionPrice: {},
        'billing_setting.billing_mode': { 'gpt-5.5': 'tiered_expr' },
        'billing_setting.scheduled_discount': {},
        [EXPRESSION_KEY]: { 'gpt-5.5': EXPRESSION, untouched: 'tier("other", p * 1 + c * 1)' },
    };
    disk = structuredClone(live);
    channels = [{ id: 5, name: 'Enterprise', status: 1, groups: ['Enterprise'], models: ['gpt-5.5'] }];
    runtimeExpression = EXPRESSION;
    runtimeRatio = 0.16;
    runtimeGroups = ['Enterprise'];
    runtimeMode = 'tiered_expr';
    holdRuntime = false;
    holdPersistence = false;
    writeFailure = null;
    insertFailure = false;
    journal = [];
    dbTail = Promise.resolve();
    mocks.costGuard.mockResolvedValue(undefined);
    mocks.beginWrite.mockImplementation(async (jobId: string) => {
        const id = `write-${journal.length}`;
        journal.push({ id, jobId, acknowledged: false });
        return id;
    });
    mocks.ackWrite.mockImplementation(async (id: string) => {
        journal.find((row) => row.id === id)!.acknowledged = true;
    });
    mocks.uncertain.mockImplementation(async (jobId: string) =>
        journal.filter((row) => row.jobId === jobId && !row.acknowledged),
    );
    const db = dbFor(() => store);
    mocks.db.catalogModel.findMany.mockImplementation(db.catalogModel.findMany);
    mocks.db.catalogModel.findFirst.mockImplementation(db.catalogModel.findFirst);
    mocks.db.channelGroup.findMany.mockImplementation(db.channelGroup.findMany);
    mocks.db.catalogPrice.findMany.mockImplementation(db.catalogPrice.findMany);
    mocks.db.pricingPublishCoordinator.findUnique.mockImplementation(db.pricingPublishCoordinator.findUnique);
    mocks.db.pricingPublishJob.findMany.mockImplementation(db.pricingPublishJob.findMany);
    mocks.db.$transaction.mockImplementation((callback: (tx: ReturnType<typeof dbFor>) => Promise<unknown>) => {
        const run = dbTail.then(async () => {
            const draft = structuredClone(store);
            const result = await callback(dbFor(() => draft));
            store = draft;
            return result;
        });
        dbTail = run.catch(() => undefined);
        return run;
    });
    mocks.options.mockImplementation(async () => structuredClone(live));
    mocks.channels.mockImplementation(async () =>
        channels.map((row) => ({ ...row, group: row.groups.join(','), models: row.models.join(',') })),
    );
    mocks.persisted.mockImplementation(async () =>
        Object.fromEntries(TIERED_PRICE_KEYS.map((key) => [key, JSON.stringify(disk[key])])),
    );
    mocks.runtime.mockImplementation(async () => ({
        models: [
            {
                model_name: 'gpt-5.5',
                billing_mode: runtimeMode,
                billing_expr: runtimeExpression,
                quota_type: 0,
                model_ratio: 2.5,
                model_price: 0,
                completion_ratio: 6,
                enable_groups: runtimeGroups,
            },
        ],
        group_ratio: { Enterprise: runtimeRatio },
    }));
    mocks.put.mockImplementation(async (key: string, value: string) => {
        const failure = writeFailure;
        writeFailure = null;
        if (failure === 'before') throw new Error('connection lost before acceptance');
        live[key] = JSON.parse(value);
        if (!holdPersistence) disk[key] = JSON.parse(value);
        if (!holdRuntime && key === 'GroupRatio') runtimeRatio = (live.GroupRatio as Record<string, number>).Enterprise;
        if (!holdRuntime && key === EXPRESSION_KEY)
            runtimeExpression = (live[key] as Record<string, string>)['gpt-5.5'];
        if (failure === 'after') throw new Error('response lost after commit');
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

const GROUP_CONTEXT: CostBatchContext = {
    ...CONTEXT,
    group_scope: { tier: 'enterprise', newapi_group: 'Enterprise', retail_ratio: 0.18 },
};
async function queuedGroup() {
    const value = input(true);
    const preview = await previewPricingBatch([value], ADMIN, GROUP_CONTEXT);
    return enqueuePricingBatch([value], preview.preview_token, ADMIN, GROUP_CONTEXT);
}
describe('durable group pricing publication', () => {
    it('publishes model base and selected ratio, journals both, then activates every row', async () => {
        const preview = await previewPricingBatch([input(true)], ADMIN, GROUP_CONTEXT);
        expect(preview.publication_mode).toBe('group');
        const job = await enqueuePricingBatch([input(true)], preview.preview_token, ADMIN, GROUP_CONTEXT);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(mocks.put.mock.calls.map((x) => x[0])).toEqual([EXPRESSION_KEY, 'GroupRatio']);
        expect(journal.every((x) => x.acknowledged)).toBe(true);
        expect(runtimeRatio).toBe(0.18);
        expect(runtimeExpression).toBe(UNIFORM);
        expect(store.prices[1]).toMatchObject({ input_cny_per_1m: 0.9, output_cny_per_1m: 5.4 });
        expect(await enqueuePricingBatch([input(true)], preview.preview_token, ADMIN, GROUP_CONTEXT)).toMatchObject({
            id: job.id,
        });
        const repeat = await previewPricingBatch([input(true)], ADMIN, GROUP_CONTEXT);
        expect(repeat.unchanged).toBe(true);
        await enqueuePricingBatch([input(true)], repeat.preview_token, ADMIN, GROUP_CONTEXT);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(mocks.put).toHaveBeenCalledTimes(2);
    });
    it('rejects membership additions between preview and confirmation without writing', async () => {
        const preview = await previewPricingBatch([input(true)], ADMIN, GROUP_CONTEXT);
        channels[0].models.push('new-model');
        await expect(
            enqueuePricingBatch([input(true)], preview.preview_token, ADMIN, GROUP_CONTEXT),
        ).rejects.toMatchObject({ code: 'pricing_group_incomplete' });
        expect(mocks.put).not.toHaveBeenCalled();
    });
    it('rechecks membership under worker lock before writes', async () => {
        await queuedGroup();
        channels[0].models.push('new-model');
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).not.toHaveBeenCalled();
        expect(store.prices).toHaveLength(1);
    });
    it('waits for runtime group cache propagation without replaying acknowledged writes', async () => {
        await queuedGroup();
        holdRuntime = true;
        expect((await runPricingPublisherOnce())?.status).toBe('retry_wait');
        expect(store.prices).toHaveLength(1);
        runtimeExpression = UNIFORM;
        runtimeRatio = 0.18;
        vi.setSystemTime(NOW + 31_000);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(mocks.put).toHaveBeenCalledTimes(2);
    });
    it('waits for persisted group configuration without activating the catalog', async () => {
        await queuedGroup();
        holdPersistence = true;
        expect((await runPricingPublisherOnce())?.status).toBe('retry_wait');
        expect(store.prices).toHaveLength(1);
        disk = structuredClone(live);
        vi.setSystemTime(NOW + 31_000);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(mocks.put).toHaveBeenCalledTimes(2);
    });
    it.each(['before', 'after'] as const)('does not replay uncertain group PUT %s acceptance', async (failure) => {
        (live[EXPRESSION_KEY] as Record<string, string>)['gpt-5.5'] = UNIFORM;
        (disk[EXPRESSION_KEY] as Record<string, string>)['gpt-5.5'] = UNIFORM;
        runtimeExpression = UNIFORM;
        const job = await queuedGroup();
        writeFailure = failure;
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        await changePricingJob(job.id, 'retry', ADMIN);
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).toHaveBeenCalledOnce();
        expect(mocks.put.mock.calls[0][0]).toBe('GroupRatio');
        expect(store.prices).toHaveLength(1);
    });
    it('rolls back local activation and safely recovers already persisted group writes', async () => {
        await queuedGroup();
        insertFailure = true;
        expect((await runPricingPublisherOnce())?.status).toBe('retry_wait');
        expect(store.prices).toHaveLength(1);
        vi.setSystemTime(NOW + 31_000);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(mocks.put).toHaveBeenCalledTimes(2);
        expect(store.prices).toHaveLength(2);
    });
    it('rejects cache-option changes even when the runtime pricing cache is still stale', async () => {
        live.CacheRatio = { 'gpt-5.5': 0.1 };
        disk.CacheRatio = { 'gpt-5.5': 0.1 };
        await queuedGroup();
        live.CacheRatio = { 'gpt-5.5': 0.2 };
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).not.toHaveBeenCalled();
    });
    it('rejects a changed other-group multiplier before any PUT', async () => {
        await queuedGroup();
        (live.GroupRatio as Record<string, number>).Other = 0.3;
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).not.toHaveBeenCalled();
    });
    it('can cancel untouched group intent but never cancel partially applied configuration', async () => {
        let job = await queuedGroup();
        expect((await changePricingJob(job.id, 'cancel', ADMIN)).status).toBe('cancelled');
        vi.setSystemTime(NOW + 1);
        job = await queuedGroup();
        holdRuntime = true;
        await runPricingPublisherOnce();
        await expect(changePricingJob(job.id, 'cancel', ADMIN)).rejects.toMatchObject({
            code: 'pricing_cancel_unsafe',
        });
    });
    it('rejects tampered target and metadata on worker rebuild', async () => {
        await queuedGroup();
        const plan = store.jobs[0].plan as unknown as { target: { GroupRatio: Record<string, number> } };
        plan.target.GroupRatio.Other = 0.2;
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).not.toHaveBeenCalled();
    });
});

describe('whole-group multi-model activation', () => {
    function addSecondModel() {
        const id = '22222222-2222-4222-8222-222222222222';
        const expression = 'tier("uniform", p * 4 + c * 20 + cr * 0.4 + cc * 5)';
        store.models.push({
            ...store.models[0],
            id,
            slug: 'sol',
            display_name: 'Sol',
            upstream_map: { enterprise: { channel_id: 5, upstream_model: 'sol' } },
        });
        channels[0].models.push('sol');
        (live.ModelRatio as Record<string, number>).sol = 2;
        (live.CompletionRatio as Record<string, number>).sol = 5;
        (live['billing_setting.billing_mode'] as Record<string, string>).sol = 'tiered_expr';
        (live[EXPRESSION_KEY] as Record<string, string>).sol = expression;
        disk = structuredClone(live);
        let secondRuntime = expression;
        mocks.runtime.mockImplementation(async () => ({
            models: [
                {
                    model_name: 'gpt-5.5',
                    billing_mode: runtimeMode,
                    billing_expr: runtimeExpression,
                    quota_type: 0,
                    model_ratio: 2.5,
                    model_price: 0,
                    completion_ratio: 6,
                    enable_groups: runtimeGroups,
                },
                {
                    model_name: 'sol',
                    billing_mode: 'tiered_expr',
                    billing_expr: secondRuntime,
                    quota_type: 0,
                    model_ratio: 2,
                    model_price: 0,
                    completion_ratio: 5,
                    enable_groups: runtimeGroups,
                },
            ],
            group_ratio: { Enterprise: runtimeRatio },
        }));
        return {
            input: {
                ...input(true),
                model_id: id,
                input_cny_per_1m: 0.72,
                output_cny_per_1m: 3.6,
                cache_read_cny_per_1m: 0.072,
                cache_write_cny_per_1m: 0.9,
            },
            stall: () => {
                secondRuntime = 'tier("old", p * 4 + c * 20 + cr * 0.4 + cc * 5)';
            },
            recover: () => {
                secondRuntime = expression;
            },
        };
    }
    it('uses one task and updates both model catalogs only after every runtime tariff matches', async () => {
        const second = addSecondModel(),
            inputs = [input(true), second.input];
        const preview = await previewPricingBatch(inputs, ADMIN, GROUP_CONTEXT);
        expect(preview.batch?.count).toBe(2);
        const job = await enqueuePricingBatch(inputs, preview.preview_token, ADMIN, GROUP_CONTEXT);
        second.stall();
        expect((await runPricingPublisherOnce())?.status).toBe('retry_wait');
        expect(store.prices).toHaveLength(1);
        second.recover();
        vi.setSystemTime(NOW + 31_000);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(store.jobs).toHaveLength(1);
        expect(store.jobs[0].id).toBe(job.id);
        expect(store.prices).toHaveLength(3);
        expect(store.prices.slice(1).map((row) => row.input_cny_per_1m)).toEqual([0.9, 0.72]);
        expect(mocks.put).toHaveBeenCalledTimes(2);
        expect(mocks.runtime).toHaveBeenCalledWith(['gpt-5.5', 'sol']);
    });
    it('does not partially enqueue when a group omits one discovered live model', async () => {
        addSecondModel();
        await expect(previewPricingBatch([input(true)], ADMIN, GROUP_CONTEXT)).rejects.toMatchObject({
            code: 'pricing_group_incomplete',
        });
        expect(store.jobs).toHaveLength(0);
        expect(mocks.put).not.toHaveBeenCalled();
    });
});
