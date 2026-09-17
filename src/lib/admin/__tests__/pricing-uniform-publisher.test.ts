import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Historical V4 creation is fixed; its queued-job recovery still uses the current worker.
vi.mock('@/lib/admin/pricing-uniform-plan', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, buildCacheUniformPublishPlan: actual.buildUniformPublishPlan };
});
import type { PricingPublishJob as StoredJob } from '@prisma/client';
import type { AdminPrincipal } from '@/lib/admin/auth';
import { createHmac } from 'node:crypto';

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
    readPublishState,
} from '../pricing-publish';
import { buildTieredPublishPlan, EXPRESSION_KEY, TIERED_PRICE_KEYS } from '../pricing-tiered-plan';
import type { PricingPublishInput, TieredPricingDetails } from '../pricing-publish-types';
import type { PublishSource, PublishState } from '../pricing-publish-plan';
import { fingerprint } from '../pricing-publish-plan';
import type { CostBatchContext } from '../pricing-cost-publication-guard';
import { PricingPublishError } from '../pricing-publish-lock';

const NOW = Date.parse('2026-09-16T13:00:00Z');
const MODEL = '11111111-1111-4111-8111-111111111111';
const EXPRESSION = 'len < 272000 ? tier("base", p * 5 + c * 30 + cr * 0.5) : tier("tier_2", p * 10 + c * 45 + cr * 1)';
const SCALED = 'tier("uniform", p * 5.625 + c * 33.75 + cr * 0.5625)';
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

function setUniformLive() {
    (live[EXPRESSION_KEY] as Record<string, string>)['gpt-5.5'] = UNIFORM;
    (disk[EXPRESSION_KEY] as Record<string, string>)['gpt-5.5'] = UNIFORM;
    runtimeExpression = UNIFORM;
}

async function queued(changed = false) {
    const value = input(changed);
    const preview = await previewPricingBatch([value], ADMIN, CONTEXT);
    return enqueuePricingBatch([value], preview.preview_token, ADMIN, CONTEXT);
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
        if (!holdRuntime && key === EXPRESSION_KEY)
            runtimeExpression = (live[key] as Record<string, string>)['gpt-5.5'];
        if (failure === 'after') throw new Error('response lost after commit');
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('durable v4 uniform price publication', () => {
    it('publishes the reviewed base rate to every input length rather than preserving the old long-context price', async () => {
        const preview = await previewPricingBatch([input()], ADMIN, CONTEXT);
        expect(preview).toMatchObject({ publication_mode: 'uniform_token', unchanged: false });
        expect(preview.rows[0].before_details?.tiers).toHaveLength(2);
        expect(preview.rows[0].after_details?.tiers).toHaveLength(1);
        await enqueuePricingBatch([input()], preview.preview_token, ADMIN, CONTEXT);
        expect(store.jobs[0].plan).toMatchObject({ version: 4, strategy: 'uniform_token' });
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(runtimeExpression).toBe(UNIFORM);
        expect(mocks.put).toHaveBeenCalledOnce();
        expect(store.prices[1].billing_details?.tiers[0]).toMatchObject({
            min_input_tokens: null,
            max_input_tokens: null,
            rates: { input: 0.8, output: 4.8, cache_read: 0.08 },
        });
    });

    it('requires a new confirmation after upgrading an old V3 preview instead of reinterpreting its signature', async () => {
        const state = await readPublishState(mocks.db as never);
        const legacy = buildTieredPublishPlan(state, { options: live, channels }, [input()], NOW, CONTEXT);
        const digest = createHmac('sha256', process.env.PORTAL_JWT_SECRET!)
            .update(
                fingerprint({
                    purpose: 'pricing-publication-v3',
                    actor: 'break-glass',
                    tenant: ADMIN.tenant_id,
                    plan: legacy,
                    timestamp: NOW,
                }),
            )
            .digest('hex');
        await expect(enqueuePricingBatch([input()], `${NOW}.${digest}`, ADMIN, CONTEXT)).rejects.toMatchObject({
            code: 'pricing_preview_stale',
        });
        expect(store.jobs).toHaveLength(0);
        expect(mocks.put).not.toHaveBeenCalled();
    });

    it('publishes independently edited output and cache prices without enforcing historical proportions', async () => {
        const independentlyPriced = { ...input(), output_cny_per_1m: 7.2, cache_read_cny_per_1m: 0.12 };
        const preview = await previewPricingBatch([independentlyPriced], ADMIN, CONTEXT);
        await enqueuePricingBatch([independentlyPriced], preview.preview_token, ADMIN, CONTEXT);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(runtimeExpression).toBe('tier("uniform", p * 5 + c * 45 + cr * 0.75)');
        expect(store.prices[1].billing_details?.tiers[0].rates).toMatchObject({
            input: 0.8,
            output: 7.2,
            cache_read: 0.12,
        });
    });

    it.each(['strategy', 'version'] as const)('rejects a tampered V4 %s before any write', async (field) => {
        await queued();
        const plan = store.jobs[0].plan as Record<string, unknown>;
        plan[field] = field === 'version' ? 3 : 'preserve_tiers';
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).not.toHaveBeenCalled();
        expect(store.prices).toHaveLength(1);
    });

    it('requires the saved cost context and runtime/persisted agreement before offering a preview', async () => {
        await expect(previewPricingBatch([input()], ADMIN)).rejects.toMatchObject({
            code: 'pricing_tiered_cost_required',
        });
        runtimeExpression = EXPRESSION.replace('272000', '128000');
        await expect(previewPricingBatch([input()], ADMIN, CONTEXT)).rejects.toThrow();
        runtimeExpression = EXPRESSION;
        (disk[EXPRESSION_KEY] as Record<string, string>)['gpt-5.5'] = SCALED;
        await expect(previewPricingBatch([input()], ADMIN, CONTEXT)).rejects.toMatchObject({
            code: 'pricing_persistence_mismatch',
        });
        expect(mocks.put).not.toHaveBeenCalled();
        expect(store.prices).toHaveLength(1);
    });

    it('publishes uniform/cache catalog metadata for an already correct price without a PUT', async () => {
        setUniformLive();
        const preview = await previewPricingBatch([input()], ADMIN, CONTEXT);
        expect(preview).toMatchObject({ publication_mode: 'uniform_token', unchanged: true });
        const job = await enqueuePricingBatch([input()], preview.preview_token, ADMIN, CONTEXT);
        expect(store.prices).toHaveLength(1);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(mocks.put).not.toHaveBeenCalled();
        expect(mocks.beginWrite).not.toHaveBeenCalled();
        expect(store.prices).toHaveLength(2);
        expect(store.prices[1]).toMatchObject({ input_cny_per_1m: 0.8, output_cny_per_1m: 4.8, cost_cny_per_1m: 0.65 });
        expect(store.prices[1].billing_details?.tiers[0].rates.cache_read).toBe(0.08);
        expect(store.prices[1].billing_details?.tiers).toHaveLength(1);
        expect(store.prices[1].billing_details?.tiers[0]).toMatchObject({
            name: 'uniform',
            min_input_tokens: null,
            max_input_tokens: null,
        });
        expect(store.coordinator?.active_job_id).toBeNull();
        expect(await enqueuePricingBatch([input()], preview.preview_token, ADMIN, CONTEXT)).toMatchObject({
            id: job.id,
            status: 'succeeded',
        });
        expect(await runPricingPublisherOnce()).toBeNull();
        expect(store.prices).toHaveLength(2);
    });

    it('writes only the complete expression dictionary once, preserving unrelated model and group prices', async () => {
        const untouched = structuredClone(live);
        await queued(true);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(mocks.put).toHaveBeenCalledTimes(1);
        expect(mocks.put.mock.calls[0][0]).toBe(EXPRESSION_KEY);
        expect(JSON.parse(mocks.put.mock.calls[0][1])).toEqual({
            ...(untouched[EXPRESSION_KEY] as object),
            'gpt-5.5': SCALED,
        });
        for (const [key, value] of Object.entries(untouched))
            if (key !== EXPRESSION_KEY) expect(live[key]).toEqual(value);
        expect(store.prices[1].billing_details?.tiers).toHaveLength(1);
        expect(store.prices[1].billing_details?.tiers[0].rates).toMatchObject({
            input: 0.9,
            output: 5.4,
            cache_read: 0.09,
        });
    });

    it('stops before writing if source channels, groups, or another expression change after confirmation', async () => {
        await queued(true);
        channels[0].status = 2;
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).not.toHaveBeenCalled();
        expect(store.prices).toHaveLength(1);
    });

    it('can cancel an untouched plan after channel drift without trapping the global publication lock', async () => {
        const job = await queued(true);
        channels[0].status = 2;
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect((await changePricingJob(job.id, 'cancel', ADMIN)).status).toBe('cancelled');
        expect(mocks.put).not.toHaveBeenCalled();
        expect(store.prices).toHaveLength(1);
        expect(store.coordinator?.active_job_id).toBeNull();
    });

    it('still refuses cancellation after acknowledged expression change when channel configuration also drifts', async () => {
        const job = await queued(true);
        holdRuntime = true;
        expect((await runPricingPublisherOnce())?.status).toBe('retry_wait');
        channels[0].status = 2;
        await expect(changePricingJob(job.id, 'cancel', ADMIN)).rejects.toMatchObject({
            code: 'pricing_cancel_unsafe',
        });
        expect(mocks.put).toHaveBeenCalledOnce();
        expect(store.prices).toHaveLength(1);
        expect(store.coordinator?.active_job_id).toBe(job.id);
    });

    it('rejects a changed unrelated formula without overwriting the full remote dictionary', async () => {
        await queued(true);
        (live[EXPRESSION_KEY] as Record<string, string>).untouched = 'tier("other", p * 2 + c * 2)';
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).not.toHaveBeenCalled();
    });

    it('refuses to write if independent persisted verification becomes unavailable after confirmation', async () => {
        await queued(true);
        mocks.persisted.mockRejectedValue(new Error('independent readonly database unavailable'));
        expect((await runPricingPublisherOnce())?.status).toBe('retry_wait');
        expect(mocks.put).not.toHaveBeenCalled();
        expect(store.prices).toHaveLength(1);
    });

    it('does not activate or repeat a write whose acknowledgement journal failed', async () => {
        const job = await queued(true);
        mocks.ackWrite.mockRejectedValueOnce(new Error('durable acknowledgement failed'));
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).toHaveBeenCalledTimes(1);
        expect((disk[EXPRESSION_KEY] as Record<string, string>)['gpt-5.5']).toBe(SCALED);
        expect(store.prices).toHaveLength(1);
        await changePricingJob(job.id, 'retry', ADMIN);
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).toHaveBeenCalledTimes(1);
    });

    it.each(['before', 'after'] as const)(
        'never repeats or cancels an uncertain expression write (%s persistence)',
        async (when) => {
            const job = await queued(true);
            writeFailure = when;
            expect((await runPricingPublisherOnce())?.status).toBe('conflict');
            expect(mocks.put).toHaveBeenCalledTimes(1);
            expect(store.prices).toHaveLength(1);
            await expect(changePricingJob(job.id, 'cancel', ADMIN)).rejects.toMatchObject({
                code: 'pricing_write_uncertain',
            });
            await changePricingJob(job.id, 'retry', ADMIN);
            expect((await runPricingPublisherOnce())?.status).toBe('conflict');
            expect(mocks.put).toHaveBeenCalledTimes(1);
            expect(store.prices).toHaveLength(1);
            expect(store.coordinator?.active_job_id).toBe(job.id);
        },
    );

    it('keeps an acknowledged write inactive until runtime converges, then verifies without another PUT', async () => {
        await queued(true);
        holdRuntime = true;
        expect((await runPricingPublisherOnce())?.status).toBe('retry_wait');
        expect(mocks.put).toHaveBeenCalledTimes(1);
        expect(store.prices).toHaveLength(1);
        expect(journal[0].acknowledged).toBe(true);
        runtimeExpression = SCALED;
        vi.setSystemTime(NOW + 31_000);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(mocks.put).toHaveBeenCalledTimes(1);
        expect(store.prices).toHaveLength(2);
    });

    it.each(['ratio', 'group', 'mode'] as const)(
        'does not activate catalog metadata while runtime %s remains stale',
        async (field) => {
            setUniformLive();
            await queued();
            if (field === 'ratio') runtimeRatio = 0.13;
            if (field === 'group') runtimeGroups = [];
            if (field === 'mode') runtimeMode = 'standard';
            expect((await runPricingPublisherOnce())?.status).toBe('retry_wait');
            expect(mocks.put).not.toHaveBeenCalled();
            expect(store.prices).toHaveLength(1);
        },
    );

    it('blocks a stale cost revision even on the no-PUT publication path', async () => {
        setUniformLive();
        await queued();
        mocks.costGuard.mockRejectedValue(new PricingPublishError('pricing_cost_changed', 'cost revision changed'));
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).not.toHaveBeenCalled();
        expect(store.prices).toHaveLength(1);
    });

    it('recovers catalog transaction failure after a known successful remote write without billing again', async () => {
        await queued(true);
        insertFailure = true;
        expect((await runPricingPublisherOnce())?.status).toBe('retry_wait');
        expect(mocks.put).toHaveBeenCalledTimes(1);
        expect(store.prices).toHaveLength(1);
        vi.setSystemTime(NOW + 31_000);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(mocks.put).toHaveBeenCalledTimes(1);
        expect(store.prices).toHaveLength(2);
    });

    it('refuses a tampered durable plan before any remote write or catalog insertion', async () => {
        await queued(true);
        const plan = store.jobs[0].plan as unknown as { target: Record<string, Record<string, string>> };
        plan.target[EXPRESSION_KEY]['gpt-5.5'] = EXPRESSION;
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).not.toHaveBeenCalled();
        expect(store.prices).toHaveLength(1);
    });

    it('rebuilds and verifies cached-token catalog metadata, not just the remote expression', async () => {
        await queued(true);
        const plan = store.jobs[0].plan as unknown as { rows: Array<{ after_details: TieredPricingDetails }> };
        plan.rows[0].after_details.tiers[0].rates.cache_read = 0;
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).not.toHaveBeenCalled();
        expect(store.prices).toHaveLength(1);
    });
});
