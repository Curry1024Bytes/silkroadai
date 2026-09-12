import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PricingPublishJob as StoredJob } from '@prisma/client';
import type { AdminPrincipal } from '@/lib/admin/auth';

const mocks = vi.hoisted(() => ({
    db: {
        catalogModel: { findMany: vi.fn(), findFirst: vi.fn() },
        catalogPrice: { findMany: vi.fn() },
        channelGroup: { findMany: vi.fn() },
        pricingPublishCoordinator: { findUnique: vi.fn() },
        pricingPublishJob: { findMany: vi.fn() },
        $transaction: vi.fn(),
    },
    options: vi.fn(),
    channels: vi.fn(),
    persisted: vi.fn(),
    put: vi.fn(),
    beginWrite: vi.fn(),
    ackWrite: vi.fn(),
    uncertain: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: mocks.db }));
vi.mock('@/lib/newapi/client', () => ({
    getPricingPublishOptions: mocks.options,
    listChannelsForCatalogSync: mocks.channels,
    putPricingPublishOption: mocks.put,
}));
vi.mock('@/lib/newapi/persisted-pricing', () => ({ readPersistedPricingOptions: mocks.persisted }));
vi.mock('@/lib/admin/pricing-publish-journal', () => ({
    beginPricingWrite: mocks.beginWrite,
    acknowledgePricingWrite: mocks.ackWrite,
    readUncertainPricingWrites: mocks.uncertain,
}));

import {
    previewPricingPublish,
    enqueuePricingPublish,
    runPricingPublisherOnce,
    changePricingJob,
    readPublishState,
    pricingPublishInputSchema,
} from '@/lib/admin/pricing-publish';
import {
    buildPublishPlan,
    PRICE_KEYS,
    type PublishSource,
    type PublishState,
    type WritePriceKey,
} from '@/lib/admin/pricing-publish-plan';
import { CHAT_FX, IMAGE_FX } from '@/lib/newapi/pricing-sync';
import { QUOTA_PER_USD } from '@/lib/newapi/quota-units';
import { assertPricingCatalogWritable } from '@/lib/admin/pricing-publish-lock';
import type { PricingPublishInput } from '@/lib/admin/pricing-publish-types';

const NOW = Date.parse('2026-09-12T04:00:00Z');
const MODEL = '11111111-1111-4111-8111-111111111111';
const ALIAS = '22222222-2222-4222-8222-222222222222';
const ADMIN: AdminPrincipal = { role: 'superadmin', tenant_id: 'tenant-a', user: null, viaBreakGlass: true };
type ModelRow = Omit<PublishState['models'][number], 'updated_at'> & { updated_at: Date };
type GroupRow = Omit<PublishState['groups'][number], 'updated_at'> & { updated_at: Date };
type PriceRow = Omit<PublishState['prices'][number], 'effective_from'> & {
    effective_from: Date;
    created_by?: string | null;
};
interface Store {
    models: ModelRow[];
    groups: GroupRow[];
    prices: PriceRow[];
    jobs: StoredJob[];
    coordinator: { id: string; revision: number; active_job_id: string | null } | null;
}
let store: Store;
let live: Record<string, unknown>, disk: Record<string, unknown>;
let sourceChannels: PublishSource['channels'];
let noPersistence: boolean;
let noWrite: boolean;
let throwOnce: { key: WritePriceKey; after: boolean } | null;
let failPriceAt: number;
let priceAttempts: number;
let dbTail: Promise<unknown>;
let journal: Array<{ id: string; jobId: string; acknowledged: boolean }>;
let failOptionsAfterFirstWrite: boolean;

function input(): PricingPublishInput {
    return {
        model_id: MODEL,
        tier: 'standard',
        input_cny_per_1m: Number((CHAT_FX * 2).toFixed(4)),
        output_cny_per_1m: Number((CHAT_FX * 6).toFixed(4)),
        per_image_cny: null,
        cost_cny_per_1m: 0.7,
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
                priceAttempts++;
                if (priceAttempts === failPriceAt) throw new Error('arbitrary second INSERT driver failure');
                const row = { ...data, id: `new-${priceAttempts}` };
                read().prices.push(row);
                return structuredClone(row);
            },
        },
        pricingPublishCoordinator: {
            findUnique: async () => structuredClone(read().coordinator),
            upsert: async () => {
                const s = read();
                s.coordinator ??= { id: 'newapi', revision: 0, active_job_id: null };
                s.coordinator.revision++;
                return structuredClone(s.coordinator);
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
                const row = read().jobs.find((job) => job.id === where.id);
                if (!row) throw { code: 'P2025' };
                Object.assign(row, data, { updated_at: new Date() });
                return structuredClone(row);
            },
        },
    };
}

function source(): PublishSource {
    return {
        channels: structuredClone(sourceChannels),
        options: {
            ...structuredClone(live),
            CompletionRatioMeta: {
                'gpt-test': {
                    ratio: (live.CompletionRatio as Record<string, number>)['gpt-test'],
                    locked: false,
                },
            },
        },
    };
}
async function queued(value = input()) {
    const preview = await previewPricingPublish(value, ADMIN);
    return enqueuePricingPublish(value, preview.preview_token, ADMIN);
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
                tenant_id: 'tenant-a',
                slug: 'gpt-test',
                display_name: 'GPT Test',
                modality: 'chat',
                enabled: true,
                updated_at: date,
                upstream_map: {
                    standard: { channel_id: 1, upstream_model: 'gpt-test' },
                    premium: { channel_id: 2, upstream_model: 'gpt-test' },
                },
            },
            {
                id: ALIAS,
                tenant_id: 'tenant-b',
                slug: 'other-alias',
                display_name: 'Other tenant alias',
                modality: 'chat',
                enabled: false,
                updated_at: date,
                upstream_map: { other: { channel_id: 3, upstream_model: 'gpt-test' } },
            },
        ],
        groups: [
            {
                id: 'g1',
                tenant_id: 'tenant-a',
                key: 'standard',
                display_name: 'Standard',
                newapi_group: 'G',
                newapi_channel_ids: [1],
                enabled: true,
                is_default: true,
                tier_level: 0,
                updated_at: date,
            },
            {
                id: 'g2',
                tenant_id: 'tenant-a',
                key: 'premium',
                display_name: 'Premium',
                newapi_group: 'H',
                newapi_channel_ids: [2],
                enabled: true,
                is_default: false,
                tier_level: 1,
                updated_at: date,
            },
            {
                id: 'g3',
                tenant_id: 'tenant-b',
                key: 'other',
                display_name: 'Other',
                newapi_group: 'J',
                newapi_channel_ids: [3],
                enabled: true,
                is_default: true,
                tier_level: 0,
                updated_at: date,
            },
        ],
        prices: [
            {
                id: 'p1',
                model_id: MODEL,
                tier: 'standard',
                input_cny_per_1m: 1,
                output_cny_per_1m: 2,
                per_image_cny: null,
                cost_cny_per_1m: 0.5,
                effective_from: date,
            },
            {
                id: 'p2',
                model_id: MODEL,
                tier: 'premium',
                input_cny_per_1m: 3,
                output_cny_per_1m: 4,
                per_image_cny: null,
                cost_cny_per_1m: 0.6,
                effective_from: date,
            },
            {
                id: 'p3',
                model_id: ALIAS,
                tier: 'other',
                input_cny_per_1m: 5,
                output_cny_per_1m: 6,
                per_image_cny: null,
                cost_cny_per_1m: 0.8,
                effective_from: date,
            },
        ],
    };
    live = {
        ModelRatio: { 'gpt-test': 1, untouched: 8 },
        CompletionRatio: { 'gpt-test': 2, untouched: 9 },
        ModelPrice: {},
        GroupRatio: { G: 1, H: 2, J: 3 },
        GroupGroupRatio: {},
        QuotaPerUnit: String(QUOTA_PER_USD),
        ImageResolutionPrice: {},
        'billing_setting.billing_mode': {},
        'billing_setting.scheduled_discount': {},
    };
    disk = structuredClone(live);
    sourceChannels = [1, 2, 3].map((id) => ({
        id,
        name: `Channel ${id}`,
        status: 1,
        groups: [['G'], ['H'], ['J']][id - 1],
        models: ['gpt-test'],
    }));
    noPersistence = false;
    noWrite = false;
    throwOnce = null;
    failPriceAt = -1;
    priceAttempts = 0;
    dbTail = Promise.resolve();
    journal = [];
    failOptionsAfterFirstWrite = false;
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
    mocks.db.$transaction.mockImplementation((fn: (tx: ReturnType<typeof dbFor>) => Promise<unknown>) => {
        const run = dbTail.then(async () => {
            const draft = structuredClone(store);
            const result = await fn(dbFor(() => draft));
            store = draft;
            return result;
        });
        dbTail = run.catch(() => undefined);
        return run;
    });
    mocks.options.mockImplementation(async () => {
        if (failOptionsAfterFirstWrite && mocks.put.mock.calls.length === 1) {
            failOptionsAfterFirstWrite = false;
            throw new Error('GET connection interrupted');
        }
        return source().options;
    });
    mocks.channels.mockImplementation(async () =>
        sourceChannels.map((row) => ({ ...row, group: row.groups.join(','), models: row.models.join(',') })),
    );
    mocks.persisted.mockImplementation(async () =>
        Object.fromEntries(PRICE_KEYS.map((key) => [key, JSON.stringify(disk[key])])),
    );
    mocks.put.mockImplementation(async (key: WritePriceKey, value: string) => {
        const fail = throwOnce?.key === key ? throwOnce : null;
        if (fail) throwOnce = null;
        if (fail && !fail.after) throw new Error('network interrupted before write');
        if (!noWrite) {
            live[key] = JSON.parse(value);
            if (!noPersistence) disk[key] = JSON.parse(value);
        }
        if (fail) throw new Error('response lost after server persisted write');
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('durable price publication', () => {
    it('does not cancel an unacknowledged request even while both stores still show the old price', async () => {
        const job = await queued();
        throwOnce = { key: 'ModelRatio', after: false };
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(live.ModelRatio).toEqual(disk.ModelRatio);
        expect((live.ModelRatio as Record<string, number>)['gpt-test']).toBe(1);
        await expect(changePricingJob(job.id, 'cancel', ADMIN)).rejects.toMatchObject({
            code: 'pricing_write_uncertain',
        });
        expect(store.coordinator?.active_job_id).toBe(job.id);
    });
    it('an acknowledgement journal failure blocks publication even when new-api already saved the write', async () => {
        await queued();
        mocks.ackWrite.mockRejectedValueOnce(new Error('acknowledgement commit unavailable'));
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).toHaveBeenCalledTimes(1);
        expect(journal[0].acknowledged).toBe(false);
        expect(store.prices).toHaveLength(3);
    });
    it('a missing verification connection after enqueue prevents the first PUT', async () => {
        await queued();
        mocks.persisted.mockRejectedValueOnce(new Error('verification connection unavailable'));
        expect((await runPricingPublisherOnce())?.status).toBe('retry_wait');
        expect(mocks.put).not.toHaveBeenCalled();
        expect(journal).toHaveLength(0);
    });
    it('previews all shared models/tiers across tenants with current history; writes nothing', async () => {
        const preview = await previewPricingPublish(input(), ADMIN);
        expect(preview.rows).toHaveLength(3);
        expect(preview.rows[1].after).toMatchObject({ input_cny_per_1m: Number((CHAT_FX * 4).toFixed(4)) });
        expect(preview.rows[2]).toMatchObject({ model_id: ALIAS, before: { input_cny_per_1m: 5 } });
        expect(mocks.put).not.toHaveBeenCalled();
        expect(store.jobs).toHaveLength(0);
        expect(store.prices).toHaveLength(3);
    });
    it('commits intent only; repeated confirmation returns same job even after preview expiry', async () => {
        const value = input(),
            preview = await previewPricingPublish(value, ADMIN);
        const first = await enqueuePricingPublish(value, preview.preview_token, ADMIN);
        vi.setSystemTime(NOW + 11 * 60_000);
        expect((await enqueuePricingPublish(value, preview.preview_token, ADMIN)).id).toBe(first.id);
        expect(store.jobs).toHaveLength(1);
        expect(store.prices).toHaveLength(3);
        expect(mocks.put).not.toHaveBeenCalled();
    });
    it('rejects stale catalog, stale upstream, edited input, forged token and expired preview without writes', async () => {
        const preview = await previewPricingPublish(input(), ADMIN);
        await expect(
            enqueuePricingPublish({ ...input(), cost_cny_per_1m: 9 }, preview.preview_token, ADMIN),
        ).rejects.toMatchObject({ code: 'pricing_preview_stale' });
        await expect(
            enqueuePricingPublish(input(), preview.preview_token.replace(/.$/, 'Z'), ADMIN),
        ).rejects.toMatchObject({ code: 'pricing_preview_stale' });
        store.prices[0].cost_cny_per_1m = 99;
        await expect(enqueuePricingPublish(input(), preview.preview_token, ADMIN)).rejects.toMatchObject({
            code: 'pricing_preview_stale',
        });
        store.prices[0].cost_cny_per_1m = 0.5;
        (live.GroupRatio as Record<string, number>).G = 5;
        disk.GroupRatio = live.GroupRatio;
        await expect(enqueuePricingPublish(input(), preview.preview_token, ADMIN)).rejects.toMatchObject({
            code: 'pricing_preview_stale',
        });
        vi.setSystemTime(NOW + 11 * 60_000);
        await expect(enqueuePricingPublish(input(), preview.preview_token, ADMIN)).rejects.toMatchObject({
            code: 'pricing_preview_stale',
        });
        expect(store.jobs).toHaveLength(0);
        expect(mocks.put).not.toHaveBeenCalled();
    });
    it('rejects confirmation by another actor and refuses absent persistence verification', async () => {
        const preview = await previewPricingPublish(input(), ADMIN);
        await expect(
            enqueuePricingPublish(input(), preview.preview_token, { ...ADMIN, tenant_id: 'different' }),
        ).rejects.toMatchObject({ code: 'pricing_preview_stale' });
        mocks.persisted.mockRejectedValue(
            Object.assign(new Error('unconfigured'), { code: 'persisted_pricing_not_configured' }),
        );
        await expect(enqueuePricingPublish(input(), preview.preview_token, ADMIN)).rejects.toMatchObject({
            code: 'persisted_pricing_not_configured',
        });
        expect(store.jobs).toHaveLength(0);
        expect(mocks.put).not.toHaveBeenCalled();
    });
    it('verifies persisted and live prices before all affected rows become effective; preserves history and costs', async () => {
        const old = structuredClone(store.prices);
        await queued();
        const result = await runPricingPublisherOnce();
        expect(result?.status).toBe('succeeded');
        expect(mocks.put).toHaveBeenCalledTimes(2);
        expect(store.prices.slice(0, 3)).toEqual(old);
        expect(store.prices).toHaveLength(6);
        expect(store.prices.slice(3).map((row) => row.cost_cny_per_1m)).toEqual([0.7, 0.6, 0.8]);
        expect(store.prices.slice(3).every((row) => row.effective_from.getTime() === NOW)).toBe(true);
        expect(store.coordinator?.active_job_id).toBeNull();
        expect(live.ModelRatio).toEqual({ 'gpt-test': 2, untouched: 8 });
        expect(live.CompletionRatio).toEqual({ 'gpt-test': 3, untouched: 9 });
    });
    it('a half-written pair does not publish; next tick writes only the missing half', async () => {
        await queued();
        failOptionsAfterFirstWrite = true;
        expect((await runPricingPublisherOnce())?.status).toBe('retry_wait');
        expect(store.prices).toHaveLength(3);
        expect(store.coordinator?.active_job_id).not.toBeNull();
        expect((live.ModelRatio as Record<string, number>)['gpt-test']).toBe(2);
        expect(await runPricingPublisherOnce()).toBeNull();
        vi.setSystemTime(NOW + 31_000);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(mocks.put.mock.calls.map((call) => call[0])).toEqual(['ModelRatio', 'CompletionRatio']);
    });
    it('a response lost after commit blocks further writes and cancellation until audited upstream termination', async () => {
        const job = await queued();
        throwOnce = { key: 'ModelRatio', after: true };
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        vi.setSystemTime(NOW + 31_000);
        await changePricingJob(job.id, 'retry', ADMIN);
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).toHaveBeenCalledTimes(1);
        expect(store.prices).toHaveLength(3);
        await expect(changePricingJob(job.id, 'cancel', ADMIN)).rejects.toMatchObject({
            code: 'pricing_write_uncertain',
        });
        // Fixture simulates an operator who has verified the old request ended
        // and used the audited recovery path. Reading target values alone is insufficient.
        journal.forEach((row) => {
            row.acknowledged = true;
        });
        await changePricingJob(job.id, 'retry', ADMIN);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(mocks.put.mock.calls.map((call) => call[0])).toEqual(['ModelRatio', 'CompletionRatio']);
    });
    it('HTTP 200 without a write, or memory-only write, never becomes succeeded', async () => {
        await queued();
        noWrite = true;
        expect((await runPricingPublisherOnce())?.status).toBe('retry_wait');
        expect(store.prices).toHaveLength(3);
        noWrite = false;
        noPersistence = true;
        vi.setSystemTime(NOW + 31_000);
        expect((await runPricingPublisherOnce())?.status).toBe('retry_wait');
        expect(store.prices).toHaveLength(3);
        noPersistence = false;
        vi.setSystemTime(NOW + 92_000);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(store.prices).toHaveLength(6);
    });
    it('DB failure on second version INSERT rolls back the first too; persisted intent recovers without more PUTs', async () => {
        await queued();
        failPriceAt = 2;
        expect((await runPricingPublisherOnce())?.status).toBe('retry_wait');
        expect(store.prices).toHaveLength(3);
        expect(store.jobs[0].status).toBe('retry_wait');
        expect(store.coordinator?.active_job_id).toBe(store.jobs[0].id);
        expect(mocks.put).toHaveBeenCalledTimes(2);
        failPriceAt = -1;
        vi.setSystemTime(NOW + 31_000);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(store.prices).toHaveLength(6);
        expect(mocks.put).toHaveBeenCalledTimes(2);
    });
    it("third values or unrelated global dictionary changes halt; never roll back somebody else's price", async () => {
        await queued();
        (live.ModelRatio as Record<string, number>).untouched = 123;
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).not.toHaveBeenCalled();
        expect(store.prices).toHaveLength(3);
        expect((live.ModelRatio as Record<string, number>).untouched).toBe(123);
    });
    it('persisted conflict, changed group/channel or changed local costs stops before writes', async () => {
        const job = await queued();
        (disk.ModelRatio as Record<string, number>)['gpt-test'] = 77;
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        disk = structuredClone(live);
        await changePricingJob(job.id, 'retry', ADMIN);
        sourceChannels[0].models = ['other'];
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        sourceChannels[0].models = ['gpt-test'];
        await changePricingJob(job.id, 'retry', ADMIN);
        store.prices[0].cost_cny_per_1m = 100;
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).not.toHaveBeenCalled();
    });
    it('only safe cancellation releases a job; a partly applied pair cannot be cancelled', async () => {
        const job = await queued();
        failOptionsAfterFirstWrite = true;
        await runPricingPublisherOnce();
        await expect(changePricingJob(job.id, 'cancel', ADMIN)).rejects.toMatchObject({
            code: 'pricing_cancel_unsafe',
        });
        (live.ModelRatio as Record<string, number>)['gpt-test'] = 1;
        (disk.ModelRatio as Record<string, number>)['gpt-test'] = 1;
        expect((await changePricingJob(job.id, 'cancel', ADMIN)).status).toBe('cancelled');
        expect(store.coordinator?.active_job_id).toBeNull();
        expect(store.prices).toHaveLength(3);
    });
    it('one global coordinator excludes concurrent jobs and overlapping workers', async () => {
        const value = input(),
            preview = await previewPricingPublish(value, ADMIN);
        const value2 = { ...value, output_cny_per_1m: Number((CHAT_FX * 8).toFixed(4)) };
        const preview2 = await previewPricingPublish(value2, ADMIN);
        const results = await Promise.allSettled([
            enqueuePricingPublish(value, preview.preview_token, ADMIN),
            enqueuePricingPublish(value2, preview2.preview_token, ADMIN),
        ]);
        expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
        const output = await Promise.all([runPricingPublisherOnce(), runPricingPublisherOnce()]);
        expect(output.filter((row) => row?.status === 'succeeded')).toHaveLength(1);
        expect(store.prices).toHaveLength(6);
        expect(mocks.put).toHaveBeenCalledTimes(2);
    });
    it('catalog mutation barrier rejects active intent until it is safely resolved', async () => {
        await mocks.db.$transaction(assertPricingCatalogWritable);
        const job = await queued();
        await expect(mocks.db.$transaction(assertPricingCatalogWritable)).rejects.toMatchObject({
            code: 'pricing_publish_busy',
        });
        await changePricingJob(job.id, 'cancel', ADMIN);
        await expect(mocks.db.$transaction(assertPricingCatalogWritable)).resolves.toBeUndefined();
    });
    it('six failed attempts pause automatic retries and retain the job for explicit recovery', async () => {
        const job = await queued();
        noWrite = true;
        for (let i = 0; i < 6; i++) {
            await runPricingPublisherOnce();
            vi.setSystemTime(Date.now() + 301_000);
        }
        expect(store.jobs[0].status).toBe('failed');
        expect(await runPricingPublisherOnce()).toBeNull();
        noWrite = false;
        await changePricingJob(job.id, 'retry', ADMIN);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
    });
});

describe('pricing plan invariants', () => {
    async function plan(value = input()) {
        return buildPublishPlan(
            await readPublishState(mocks.db as unknown as Parameters<typeof readPublishState>[0]),
            source(),
            value,
            NOW,
        );
    }
    it('requires a precise current tier and does not use a historical/default fallback', async () => {
        await expect(plan({ ...input(), tier: 'missing' })).rejects.toMatchObject({ code: 'pricing_tier_invalid' });
    });
    it('blocks expired channels, special billing rules, future prices and fixed SKUs', async () => {
        sourceChannels[0].status = 2;
        await expect(plan()).rejects.toMatchObject({ code: 'pricing_channel_unavailable' });
        sourceChannels[0].status = 1;
        live['billing_setting.billing_mode'] = { 'gpt-test': 'tiered_expr' };
        await expect(plan()).rejects.toMatchObject({ code: 'pricing_special_rule' });
        live['billing_setting.billing_mode'] = {};
        store.prices[1].effective_from = new Date(NOW + 1000);
        await expect(plan()).rejects.toMatchObject({ code: 'pricing_future_price' });
        store.prices[1].effective_from = new Date(NOW - 1000);
        store.models[1].slug = 'gpt-image-2-1k';
        await expect(plan()).rejects.toMatchObject({ code: 'fixed_sku_price' });
    });
    it('requires valid currency units and explicit complete dictionaries', async () => {
        live.QuotaPerUnit = '1234';
        await expect(plan()).rejects.toMatchObject({ code: 'pricing_units_mismatch' });
        live.QuotaPerUnit = QUOTA_PER_USD;
        live.ModelPrice = null;
        await expect(plan()).rejects.toMatchObject({ code: 'pricing_options_invalid' });
    });
    it('supports rc23 absence of later optional features and the actual ratio billing mode', async () => {
        delete live.ImageResolutionPrice;
        delete live['billing_setting.scheduled_discount'];
        live['billing_setting.billing_mode'] = { 'gpt-test': 'ratio' };
        disk = structuredClone(live);
        await queued();
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(mocks.put).toHaveBeenCalledTimes(2);
    });
    it.each([null, 'null', 'malformed', []])(
        'still rejects invalid present optional configuration %j',
        async (value) => {
            live.ImageResolutionPrice = value;
            await expect(plan()).rejects.toMatchObject({ code: 'pricing_options_invalid' });
            live.ImageResolutionPrice = {};
            live['billing_setting.scheduled_discount'] = value;
            await expect(plan()).rejects.toMatchObject({ code: 'pricing_options_invalid' });
            expect(mocks.put).not.toHaveBeenCalled();
        },
    );
    it.each([
        'ModelRatio',
        'CompletionRatio',
        'ModelPrice',
        'GroupRatio',
        'GroupGroupRatio',
        'billing_setting.billing_mode',
    ])('never treats missing required %s as an empty optional feature', async (key) => {
        const state = await readPublishState(mocks.db as unknown as Parameters<typeof readPublishState>[0]);
        const current = source();
        delete current.options[key];
        expect(() => buildPublishPlan(state, current, input(), NOW)).toThrowError(
            expect.objectContaining({ code: 'pricing_options_invalid' }),
        );
    });
    it('stops before PUT if an absent optional feature appears after confirmation', async () => {
        delete live.ImageResolutionPrice;
        delete live['billing_setting.scheduled_discount'];
        disk = structuredClone(live);
        await queued();
        live.ImageResolutionPrice = {};
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).not.toHaveBeenCalled();
    });
    it('locked effective completion metadata forbids an incompatible output price', async () => {
        const s = source();
        s.options.CompletionRatioMeta = { 'gpt-test': { ratio: 2, locked: true } };
        expect(() => buildPublishPlan({ models: [], groups: [], prices: [] }, s, input(), NOW)).toThrow();
        const state = await readPublishState(mocks.db as unknown as Parameters<typeof readPublishState>[0]);
        expect(() => buildPublishPlan(state, s, input(), NOW)).toThrow(/固定为 2/);
    });
    it('image ModelPrice publication preserves per-request basis and calculates shared groups', async () => {
        live.ModelPrice = { 'gpt-test': 1 };
        store.models.forEach((row) => {
            row.modality = 'image';
        });
        disk = structuredClone(live);
        const value = {
            ...input(),
            input_cny_per_1m: null,
            output_cny_per_1m: null,
            per_image_cny: Number((IMAGE_FX * 2).toFixed(4)),
        };
        expect((await plan(value)).rows[1].after.per_image_cny).toBe(Number((IMAGE_FX * 4).toFixed(4)));
        await queued(value);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(mocks.put.mock.calls.map((row) => row[0])).toEqual(['ModelPrice']);
    });
    it('never silently switches token/request basis or clears saved prices', async () => {
        await expect(
            plan({ ...input(), input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: 1 }),
        ).rejects.toMatchObject({ code: 'pricing_basis_change' });
        expect(pricingPublishInputSchema.safeParse({ ...input(), per_image_cny: 1 }).success).toBe(false);
        expect(pricingPublishInputSchema.safeParse({ ...input(), input_cny_per_1m: 0 }).success).toBe(false);
        expect(pricingPublishInputSchema.safeParse({ ...input(), cost_cny_per_1m: 0.00001 }).success).toBe(false);
    });
    it('rejects a positive output price rounded to a zero completion ratio before creating intent or writing', async () => {
        const value = { ...input(), input_cny_per_1m: 100, output_cny_per_1m: 0.0001 };
        expect(pricingPublishInputSchema.safeParse(value).success).toBe(true);
        await expect(previewPricingPublish(value, ADMIN)).rejects.toMatchObject({ code: 'pricing_precision' });
        expect(store.jobs).toHaveLength(0);
        expect(store.prices).toHaveLength(3);
        expect(mocks.put).not.toHaveBeenCalled();
    });
    it('allows an explicitly requested zero output price without treating it as precision loss', async () => {
        const result = await plan({ ...input(), input_cny_per_1m: 100, output_cny_per_1m: 0 });
        expect(result.target.CompletionRatio).toBe(0);
        expect(result.rows.every((row) => row.after.output_cny_per_1m === 0)).toBe(true);
    });
});
