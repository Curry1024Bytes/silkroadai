/** Full route -> saved quote -> signed batch -> real cost guard -> worker flow.
 * Only database/network boundaries and authentication are mocked. No service,
 * guard, signature, conversion or schema mock can hide contract mismatches. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { AdminPrincipal } from '@/lib/admin/auth';
import type { PricingCostConfig } from '@/lib/admin/pricing-cost-types';

const mocks = vi.hoisted(() => ({
    db: {} as Record<string, unknown>,
    auth: vi.fn(),
    options: vi.fn(),
    channels: vi.fn(),
    persisted: vi.fn(),
    put: vi.fn(),
    begin: vi.fn(),
    ack: vi.fn(),
    uncertain: vi.fn(),
    network: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: mocks.db }));
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: mocks.auth }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/newapi/client', () => ({
    getPricingPublishOptions: mocks.options,
    listChannelsForCatalogSync: mocks.channels,
    putPricingPublishOption: mocks.put,
}));
vi.mock('@/lib/newapi/persisted-pricing', () => ({ readPersistedPricingOptions: mocks.persisted }));
vi.mock('@/lib/admin/pricing-publish-journal', () => ({
    beginPricingWrite: mocks.begin,
    acknowledgePricingWrite: mocks.ack,
    readUncertainPricingWrites: mocks.uncertain,
}));

import { GET, POST as SAVE } from '@/app/api/admin/pricing/cost-rules/route';
import { POST as BULK } from '@/app/api/admin/pricing/cost-rules/bulk/route';
import { POST as PUBLISH } from '@/app/api/admin/pricing/cost-rules/publish/route';
import { runPricingPublisherOnce } from '@/lib/admin/pricing-publish';
import { listCostRules } from '@/lib/admin/pricing-cost-store';
import { resolvePricingCostSelection } from '@/lib/admin/pricing-cost-publication-guard';
import { QUOTA_PER_USD } from '@/lib/newapi/quota-units';
import { PRICE_KEYS } from '@/lib/admin/pricing-publish-plan';

const MODEL = '11111111-1111-4111-8111-111111111111';
const RULE = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const FOREIGN = '44444444-4444-4444-8444-444444444444';
const ADMIN: AdminPrincipal = { role: 'superadmin', tenant_id: 'tenant-a', user: null, viaBreakGlass: true };
const now = new Date('2026-09-15T04:00:00Z');
const config = (): PricingCostConfig => ({
    version: 1,
    basis: 'token',
    currency: 'credits',
    credits_per_cny: 5,
    upstream_multiplier: 0.5,
    markup_percent: 20,
    source_note: 'confirmed supplier quote',
    token_rates: { input: 10, output: 50, cache_read: null, cache_write: null },
    variants: [],
});
const initialModel = () => ({
    id: MODEL,
    tenant_id: 'tenant-a',
    slug: 'text-model',
    display_name: 'Text model',
    modality: 'chat',
    enabled: true,
    updated_at: now,
    upstream_map: { standard: { channel_id: 14, upstream_model: 'text-model' } },
});
const initialGroup = () => ({
    id: 'group-id',
    tenant_id: 'tenant-a',
    key: 'standard',
    display_name: 'Standard',
    newapi_group: 'Group',
    newapi_channel_ids: [14],
    enabled: true,
    is_default: true,
    tier_level: 0,
    updated_at: now,
});
const initialRule = () => ({
    id: RULE,
    model_id: MODEL,
    tier: 'standard',
    channel_id: 14,
    upstream_model: 'text-model',
    revision: 1,
    config: config(),
    created_by: null,
    updated_by: null,
    created_at: now,
    updated_at: now,
});
type TestRule = ReturnType<typeof initialRule>;
type TestModel = ReturnType<typeof initialModel>;
type TestJob = {
    id: string;
    preview_hash: string;
    plan: unknown;
    status: string;
    attempts: number;
    model_id: string;
    upstream_model: string;
    created_at: Date;
    updated_at: Date;
    next_attempt_at: Date | null;
    requested_by: string | null;
    tenant_id: string | null;
};
type TestPrice = {
    id: string;
    model_id: string;
    tier: string;
    effective_from: Date;
    input_cny_per_1m: number | null;
    output_cny_per_1m: number | null;
    per_image_cny: number | null;
    cost_cny_per_1m: number | null;
};
type Store = {
    models: TestModel[];
    groups: ReturnType<typeof initialGroup>[];
    rules: TestRule[];
    revisions: unknown[];
    prices: TestPrice[];
    jobs: TestJob[];
    coordinator: { id: string; revision: number; active_job_id: string | null };
};
let store: Store;
let live: Record<string, Record<string, number>>, disk: typeof live;
let tail: Promise<unknown>;
let transactionCount: number;

function dbFor(read: () => Store) {
    return {
        catalogModel: {
            findMany: async ({ where }: { where?: { tenant_id?: string } } = {}) =>
                read().models.filter((row) => !where?.tenant_id || where.tenant_id === row.tenant_id),
            findFirst: async ({ where }: { where: { id: string; tenant_id?: string } }) =>
                read().models.find(
                    (row) => row.id === where.id && (!where.tenant_id || where.tenant_id === row.tenant_id),
                ) ?? null,
        },
        channelGroup: {
            findMany: async ({ where }: { where?: { tenant_id?: string } } = {}) =>
                read().groups.filter((row) => !where?.tenant_id || where.tenant_id === row.tenant_id),
        },
        catalogPrice: {
            findMany: async () => read().prices,
            create: async ({ data }: { data: Omit<TestPrice, 'id'> }) => {
                const row = { ...data, id: `price-${read().prices.length}` };
                read().prices.push(row);
                return row;
            },
        },
        pricingCostRule: {
            findMany: async ({ where }: { where: { id?: { in: string[] }; model?: { tenant_id?: string } } }) =>
                read().rules.flatMap((rule) => {
                    const model = read().models.find((row) => row.id === rule.model_id)!;
                    return (!where.id || where.id.in.includes(rule.id)) &&
                        (!where.model?.tenant_id || model.tenant_id === where.model.tenant_id)
                        ? [{ ...rule, model }]
                        : [];
                }),
            findUnique: async ({ where }: { where: { model_id_tier: { model_id: string; tier: string } } }) =>
                read().rules.find(
                    (row) => row.model_id === where.model_id_tier.model_id && row.tier === where.model_id_tier.tier,
                ) ?? null,
            create: async ({ data }: { data: Partial<TestRule> }) => {
                const row = { ...initialRule(), ...data };
                read().rules.push(row);
                return row;
            },
            update: async ({
                where,
                data,
            }: {
                where: { id: string };
                data: Partial<Omit<TestRule, 'revision'>> & { revision: { increment: number } };
            }) => {
                const row = read().rules.find((rule) => rule.id === where.id)!;
                Object.assign(row, { ...data, revision: row.revision + data.revision.increment });
                return row;
            },
        },
        pricingCostRuleRevision: {
            create: async ({ data }: { data: unknown }) => {
                read().revisions.push(data);
                return data;
            },
        },
        channelGroupRetirementJob: { findFirst: async () => null },
        pricingPublishCoordinator: {
            findUnique: async () => read().coordinator,
            upsert: async () => {
                read().coordinator.revision++;
                return read().coordinator;
            },
            update: async ({
                where,
                data,
            }: {
                where: { active_job_id?: string };
                data: { active_job_id?: string | null; revision?: { increment: number } };
            }) => {
                if (where.active_job_id && where.active_job_id !== read().coordinator.active_job_id)
                    throw { code: 'P2025' };
                if ('active_job_id' in data) read().coordinator.active_job_id = data.active_job_id ?? null;
                if (data.revision) read().coordinator.revision += data.revision.increment;
                return read().coordinator;
            },
        },
        pricingPublishJob: {
            findUnique: async ({ where }: { where: { id?: string; preview_hash?: string } }) =>
                read().jobs.find((row) => (where.id ? row.id === where.id : row.preview_hash === where.preview_hash)) ??
                null,
            create: async ({ data }: { data: Omit<TestJob, 'id' | 'created_at' | 'updated_at' | 'attempts'> }) => {
                const row = { ...data, id: JOB, created_at: now, updated_at: now, attempts: 0 };
                read().jobs.push(row);
                return row;
            },
            update: async ({ where, data }: { where: { id: string }; data: Partial<TestJob> }) => {
                const row = read().jobs.find((job) => job.id === where.id)!;
                Object.assign(row, data);
                return row;
            },
        },
    };
}
function request(body?: unknown, raw?: string) {
    return new NextRequest('https://portal.test/api/admin/pricing/cost-rules', {
        method: body === undefined && raw === undefined ? 'GET' : 'POST',
        ...(body === undefined && raw === undefined
            ? {}
            : { body: raw ?? JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    });
}
const saveBody = () => ({ model_id: MODEL, tier: 'standard', expected_revision: 1, config: config() });
const selections = () => [{ rule_id: RULE, revision: 1 }];
async function preview() {
    const response = await PUBLISH(request({ action: 'preview', selections: selections() }));
    expect(response.status).toBe(200);
    return response.json();
}
async function confirm(data: Awaited<ReturnType<typeof preview>>, changes: Record<string, unknown> = {}) {
    return PUBLISH(
        request({
            action: 'publish',
            selections: selections(),
            preview_token: data.preview.preview_token,
            selection_token: data.selection_token,
            ...changes,
        }),
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubEnv('PORTAL_JWT_SECRET', 'local-test-only-cost-route-signature-secret');
    vi.stubGlobal('fetch', mocks.network.mockRejectedValue(new Error('Real network forbidden')));
    store = {
        models: [initialModel()],
        groups: [initialGroup()],
        rules: [initialRule()],
        revisions: [],
        prices: [
            {
                id: 'old-price',
                model_id: MODEL,
                tier: 'standard',
                input_cny_per_1m: 0.5,
                output_cny_per_1m: 2,
                per_image_cny: null,
                cost_cny_per_1m: 0.3,
                effective_from: now,
            },
        ],
        jobs: [],
        coordinator: { id: 'newapi', revision: 0, active_job_id: null },
    };
    live = {
        ModelRatio: { 'text-model': 1, untouched: 8 },
        CompletionRatio: { 'text-model': 2, untouched: 9 },
        ModelPrice: {},
        GroupRatio: { Group: 1 },
    };
    disk = structuredClone(live);
    tail = Promise.resolve();
    transactionCount = 0;
    Object.assign(
        mocks.db,
        dbFor(() => store),
        {
            $transaction: (run: (tx: ReturnType<typeof dbFor>) => Promise<unknown>) => {
                transactionCount++;
                const pending = tail.then(async () => {
                    const draft = structuredClone(store);
                    const result = await run(dbFor(() => draft));
                    store = draft;
                    return result;
                });
                tail = pending.catch(() => undefined);
                return pending;
            },
        },
    );
    mocks.auth.mockResolvedValue(ADMIN);
    mocks.options.mockImplementation(async () => ({
        ...structuredClone(live),
        GroupGroupRatio: {},
        QuotaPerUnit: String(QUOTA_PER_USD),
        'billing_setting.billing_mode': {},
        CompletionRatioMeta: { 'text-model': { ratio: live.CompletionRatio['text-model'], locked: false } },
    }));
    mocks.channels.mockResolvedValue([
        { id: 14, name: 'Supplier channel', status: 1, group: 'Group', models: 'text-model' },
    ]);
    mocks.persisted.mockImplementation(async () =>
        Object.fromEntries(PRICE_KEYS.map((key) => [key, JSON.stringify(disk[key])])),
    );
    mocks.put.mockImplementation(async (key: string, value: string) => {
        live[key] = JSON.parse(value);
        disk[key] = JSON.parse(value);
    });
    mocks.begin.mockResolvedValue('journal');
    mocks.ack.mockResolvedValue(undefined);
    mocks.uncertain.mockResolvedValue([]);
});
afterEach(() => {
    expect(mocks.network).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe('cost API authorization and validation', () => {
    it.each(['get', 'save', 'bulk', 'preview', 'confirm'])(
        'rejects unauthorized %s before database or upstream work',
        async (entry) => {
            mocks.auth.mockResolvedValue(null);
            const req = request({ invalid: 'body need not be parsed' });
            const response =
                entry === 'get'
                    ? await GET(req)
                    : entry === 'save'
                      ? await SAVE(req)
                      : entry === 'bulk'
                        ? await BULK(req)
                        : await PUBLISH(req);
            expect(response.status).toBe(401);
            expect(mocks.auth).toHaveBeenCalledWith(req, 'superadmin');
            expect(transactionCount).toBe(0);
            expect(mocks.options).not.toHaveBeenCalled();
            expect(mocks.put).not.toHaveBeenCalled();
        },
    );
    it.each([
        ['save', {}],
        ['save', { ...saveBody(), model_id: 'bad' }],
        ['save', { ...saveBody(), expected_revision: -1 }],
        ['save', { ...saveBody(), config: { ...config(), markup_percent: -1 } }],
        ['save', { ...saveBody(), config: { ...config(), retail_multiplier: 1.6 } }],
        ['save', { ...saveBody(), config: { ...config(), markup_percent: 0, retail_multiplier: 0.4 } }],
        ['bulk', { rules: [] }],
        ['preview', { action: 'preview', selections: [] }],
        ['preview', { action: 'preview', selections: [{ rule_id: RULE, revision: 0 }] }],
        ['preview', { action: 'preview', selections: selections(), per_image_cny: 0.01 }],
        ['confirm', { action: 'publish', selections: selections() }],
    ])('returns 400 for invalid %s input', async (entry, body) => {
        const response =
            entry === 'save'
                ? await SAVE(request(body))
                : entry === 'bulk'
                  ? await BULK(request(body))
                  : await PUBLISH(request(body));
        expect(response.status).toBe(400);
        expect(transactionCount).toBe(0);
        expect(mocks.options).not.toHaveBeenCalled();
        expect(mocks.put).not.toHaveBeenCalled();
    });
    it.each([SAVE, BULK, PUBLISH])('rejects invalid JSON before services', async (route) => {
        expect((await route(request(null, '{invalid'))).status).toBe(400);
        expect(transactionCount).toBe(0);
    });
    it('saves cost-only revisions without changing retail rows or making remote reads/writes', async () => {
        const response = await SAVE(request({ ...saveBody(), config: { ...config(), markup_percent: 30 } }));
        expect(response.status).toBe(200);
        expect((await response.json()).rule.revision).toBe(2);
        expect(store.prices).toHaveLength(1);
        expect(store.jobs).toHaveLength(0);
        expect(store.revisions).toHaveLength(1);
        expect(mocks.options).not.toHaveBeenCalled();
        expect(mocks.put).not.toHaveBeenCalled();
    });
});

describe('real saved-cost guard in batch route and worker', () => {
    it('carries the exact target multiplier through save, signed preview and the publication worker', async () => {
        const direct = { ...config(), upstream_multiplier: 1.3, retail_multiplier: 1.6, markup_percent: 0 };
        const response = await SAVE(request({ ...saveBody(), config: direct }));
        expect(response.status).toBe(200);
        expect((await response.json()).rule.config).toEqual(direct);
        expect(mocks.put).not.toHaveBeenCalled();
        const selected = [{ rule_id: RULE, revision: 2 }];
        const previewResponse = await PUBLISH(request({ action: 'preview', selections: selected }));
        expect(previewResponse.status).toBe(200);
        const data = await previewResponse.json();
        expect(data.cost_rows.map((row: { cost: number; retail: number }) => [row.cost, row.retail])).toEqual([
            [2.6, 3.2],
            [13, 16],
        ]);
        expect((await confirm(data, { selections: selected })).status).toBe(202);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(store.prices[1]).toMatchObject({ input_cny_per_1m: 3.2, output_cny_per_1m: 16 });
        expect(store.revisions[0]).toMatchObject({ config: direct });
    });

    it('previews derived final CNY, confirms signed v2 intent, and applies only after real guard and remote dual verification', async () => {
        const data = await preview();
        expect(data.cost_rows.map((row: { retail: number }) => row.retail)).toEqual([1.2, 6]);
        expect(store.jobs).toHaveLength(0);
        expect(mocks.put).not.toHaveBeenCalled();
        const response = await confirm(data);
        expect(response.status).toBe(202);
        expect((store.jobs[0].plan as { version: number }).version).toBe(2);
        expect(store.prices).toHaveLength(1);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
        expect(mocks.put).toHaveBeenCalledTimes(2);
        expect(store.prices[1]).toMatchObject({ input_cny_per_1m: 1.2, output_cny_per_1m: 6, cost_cny_per_1m: 0.3 });
        expect(store.coordinator.active_job_id).toBeNull();
    });
    it.each(['preview-token', 'selection-token', 'actor', 'rule-configuration', 'revision', 'selection'])(
        'rejects changed %s between preview and confirmation with zero remote writes',
        async (change) => {
            const data = await preview();
            const changes: Record<string, unknown> = {};
            if (change === 'preview-token') changes.preview_token = 'different-publication-preview';
            if (change === 'selection-token') changes.selection_token = 'b'.repeat(64);
            if (change === 'actor') mocks.auth.mockResolvedValue({ ...ADMIN, user: { id: 'another-admin' } });
            if (change === 'rule-configuration') store.rules[0].config.markup_percent = 99;
            if (change === 'revision') store.rules[0].revision = 2;
            if (change === 'selection') changes.selections = [{ rule_id: FOREIGN, revision: 1 }];
            const response = await confirm(data, changes);
            expect(response.status).toBe(409);
            expect(store.jobs).toHaveLength(0);
            expect(mocks.put).not.toHaveBeenCalled();
        },
    );
    it('real context guard blocks stored-rule drift after enqueue even when amounts were never edited by the client', async () => {
        const data = await preview();
        expect((await confirm(data)).status).toBe(202);
        // Deliberate DB fixture drift bypasses the normal mutation lock.
        store.rules[0].config.upstream_multiplier = 0.75;
        expect((await runPricingPublisherOnce())?.status).toBe('conflict');
        expect(mocks.put).not.toHaveBeenCalled();
        expect(store.prices).toHaveLength(1);
    });
    it('normal cost edits are blocked while a batch owns the coordinator; they cannot race the worker snapshot', async () => {
        const data = await preview();
        expect((await confirm(data)).status).toBe(202);
        const response = await SAVE(request({ ...saveBody(), config: { ...config(), markup_percent: 99 } }));
        expect(response.status).toBe(409);
        expect(store.rules[0].revision).toBe(1);
        expect(store.revisions).toHaveLength(0);
        expect((await runPricingPublisherOnce())?.status).toBe('succeeded');
    });
    it('rejects memory/persisted price divergence during preview before producing a signed selection', async () => {
        disk.ModelRatio.untouched = 99;
        const response = await PUBLISH(request({ action: 'preview', selections: selections() }));
        expect(response.status).toBe(409);
        expect((await response.json()).error).toBe('pricing_persistence_mismatch');
        expect(store.jobs).toHaveLength(0);
        expect(mocks.put).not.toHaveBeenCalled();
    });
    it('does not leak another tenant cost quote through list or selection helpers', async () => {
        const scopedAdmin: AdminPrincipal = { ...ADMIN, role: 'admin', tenant_id: 'tenant-b' };
        expect(await listCostRules(scopedAdmin)).toEqual([]);
        await expect(
            resolvePricingCostSelection(
                mocks.db as unknown as Parameters<typeof resolvePricingCostSelection>[0],
                selections(),
                scopedAdmin,
            ),
        ).rejects.toMatchObject({ code: 'pricing_cost_revision' });
        expect(mocks.put).not.toHaveBeenCalled();
    });
    it('redacts unexpected backend failures instead of exposing supplier or verification credentials', async () => {
        mocks.persisted.mockRejectedValue(new Error('mysql://reader:secret-password@private-host/new_api'));
        const response = await PUBLISH(request({ action: 'preview', selections: selections() }));
        expect(response.status).toBe(503);
        expect(await response.text()).not.toMatch(/secret-password|private-host/);
    });
});
