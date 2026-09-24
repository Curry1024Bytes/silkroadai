import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/newapi/quota-units', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/newapi/quota-units')>()),
    QUOTA_PER_USD: 500_000,
    USD_TO_CNY_RATE: 1,
}));

const state = vi.hoisted(() => ({
    options: {} as Record<string, unknown>,
    puts: [] as Array<[string, string]>,
    failPut: null as string | null,
    dropPut: null as string | null,
    groups: [] as unknown[],
    models: [] as unknown[],
    created: [] as unknown[],
    audits: [] as unknown[],
}));

vi.mock('@/lib/newapi/client', () => ({
    getPricingPublishOptions: vi.fn(async () => ({ ...state.options })),
    putPricingPublishOption: vi.fn(async (key: string, value: string) => {
        if (state.failPut === key) throw new Error('boom');
        state.puts.push([key, value]);
        if (state.dropPut !== key) state.options[key] = value;
    }),
    getPricingRuntimeModels: vi.fn(),
}));

vi.mock('@/lib/admin/pricing-publish-lock', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/admin/pricing-publish-lock')>()),
    assertPricingCatalogWritable: vi.fn(async () => {}),
}));

vi.mock('@/lib/db', () => {
    const db = {
        channelGroup: { findMany: vi.fn(async () => state.groups) },
        catalogModel: { findMany: vi.fn(async () => state.models) },
        catalogPrice: {
            create: vi.fn(async (args: { data: unknown }) => {
                state.created.push(args.data);
                return args.data;
            }),
        },
        adminAuditLog: {
            create: vi.fn(async (args: { data: unknown }) => {
                state.audits.push(args.data);
                return args.data;
            }),
        },
        newApiToken: { groupBy: vi.fn(async () => [{ tier: 'pool', _count: { _all: 7 } }]) },
        userTierMultiplier: { groupBy: vi.fn(async () => [{ tier_key: 'pool', _count: { _all: 2 } }]) },
    };
    return { prisma: { ...db, $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)) } };
});

import {
    loadSimplePricing,
    previewModel,
    previewTier,
    resyncCatalog,
    saveModel,
    saveTier,
    type SimplePricingContext,
} from '@/lib/admin/pricing-simple';
import type { AdminPrincipal } from '@/lib/admin/auth';

const TENANT = '00000000-0000-0000-0000-000000000001';
const admin = {
    user: { id: 'u1', email: 'a@x' },
    role: 'superadmin',
    tenant_id: TENANT,
    viaBreakGlass: false,
} as unknown as AdminPrincipal;
const context: SimplePricingContext = { admin, ip: '1.2.3.4', userAgent: 'vitest' };

function price(tier: string, input: number, output: number) {
    return {
        tier,
        input_cny_per_1m: input,
        output_cny_per_1m: output,
        per_image_cny: null,
        billing_details: null,
        cost_cny_per_1m: 0.5,
    };
}

beforeEach(() => {
    state.options = {
        ModelRatio: JSON.stringify({ 'gpt-5.5': 2.5 }),
        CompletionRatio: JSON.stringify({ 'gpt-5.5': 8 }),
        ModelPrice: JSON.stringify({}),
        CacheRatio: JSON.stringify({}),
        CreateCacheRatio: JSON.stringify({}),
        'billing_setting.billing_mode': JSON.stringify({}),
        'billing_setting.billing_expr': JSON.stringify({}),
        GroupRatio: JSON.stringify({ default: 1.2, official: 3.4 }),
        'group_ratio_setting.group_ratio': JSON.stringify({ default: 1.2 }),
    };
    state.puts = [];
    state.failPut = null;
    state.dropPut = null;
    state.created = [];
    state.audits = [];
    state.groups = [
        { id: 'g-official', key: 'official', display_name: '官方', newapi_group: 'official', tier_level: 1 },
        { id: 'g-pool', key: 'pool', display_name: '号池', newapi_group: 'default', tier_level: 0 },
    ];
    state.models = [
        {
            id: 'm1',
            slug: 'gpt-5.5',
            display_name: 'GPT-5.5',
            vendor: 'openai',
            modality: 'chat',
            upstream_map: {
                pool: { upstream_model: 'gpt-5.5' },
                official: { upstream_model: 'gpt-5.5' },
                gone: { upstream_model: 'x' },
            },
            // pool matches (5 × 1.2 = 6 / 48); official is stale.
            prices: [price('pool', 6, 48), price('official', 10, 80)],
        },
    ];
});

describe('loadSimplePricing', () => {
    it('builds tiers, cells and one upstream entry per model', async () => {
        const view = await loadSimplePricing(admin);
        expect(
            view.tiers.map((tier) => [
                tier.key,
                tier.ratio,
                tier.active_keys,
                tier.customer_overrides,
                tier.model_count,
            ]),
        ).toEqual([
            ['pool', 1.2, 7, 2, 1],
            ['official', 3.4, 0, 0, 1],
        ]);
        expect(view.models[0].cells.map((cell) => [cell.tier, cell.status])).toEqual([
            ['pool', 'ok'],
            ['official', 'mismatch'],
        ]);
        expect(view.models[0].cells[1].expected).toMatchObject({ input_cny_per_1m: 17, output_cny_per_1m: 136 });
        expect(view.upstream_models).toHaveLength(1);
        expect(view.upstream_models[0]).toMatchObject({
            name: 'gpt-5.5',
            base: { mode: 'token', input: 5, output: 40 },
        });
    });
});

describe('previews', () => {
    it('previews a tier change with override warnings and no writes', async () => {
        const preview = await previewTier(admin, 'g-pool', 2.4);
        expect(preview.writes.map((write) => write.key)).toEqual(['GroupRatio', 'group_ratio_setting.group_ratio']);
        expect(preview.rows).toHaveLength(1);
        expect(preview.rows[0].after).toMatchObject({ input_cny_per_1m: 12 });
        expect(preview.warnings[0]).toContain('2 位客户');
        expect(state.puts).toEqual([]);
    });

    it('previews a model change across every tier that uses it', async () => {
        const preview = await previewModel(admin, 'gpt-5.5', {
            mode: 'token',
            input: 10,
            output: 40,
            cache_read: null,
            cache_write: null,
        });
        expect(preview.rows.map((row) => [row.tier, row.after?.input_cny_per_1m])).toEqual([
            ['pool', 12],
            ['official', 34],
        ]);
    });

    it('rejects models no enabled tier maps to', async () => {
        await expect(previewModel(admin, 'nope', { mode: 'per_call', price: 1 })).rejects.toMatchObject({
            code: 'pricing_model_not_found',
        });
    });
});

describe('saves', () => {
    it('saves a tier ratio, snapshots its catalog rows and audits', async () => {
        const result = await saveTier(context, 'g-pool', 2.4, 1.2);
        expect(result).toEqual({
            unchanged: false,
            written_keys: ['GroupRatio', 'group_ratio_setting.group_ratio'],
            catalog_rows: 1,
        });
        expect(JSON.parse(state.options.GroupRatio as string).default).toBe(2.4);
        expect(state.created).toEqual([
            expect.objectContaining({
                model_id: 'm1',
                tier: 'pool',
                input_cny_per_1m: 12,
                output_cny_per_1m: 96,
                cost_cny_per_1m: 0.5,
            }),
        ]);
        expect(state.audits[0]).toMatchObject({ action: 'pricing_tier_ratio', target: 'pool', level: 'super' });
    });

    it('refuses a stale tier ratio without writing', async () => {
        await expect(saveTier(context, 'g-pool', 2.4, 1.5)).rejects.toMatchObject({ code: 'pricing_stale' });
        expect(state.puts).toEqual([]);
    });

    it('saves a model base price and refreshes every tier that uses it', async () => {
        const view = await loadSimplePricing(admin);
        const result = await saveModel(
            context,
            'gpt-5.5',
            { mode: 'token', input: 5, output: 30, cache_read: null, cache_write: null },
            view.upstream_models[0].state,
        );
        expect(result.written_keys).toEqual(['CompletionRatio']);
        expect(result.catalog_rows).toBe(2);
        expect(state.created.map((row) => (row as { tier: string }).tier)).toEqual(['pool', 'official']);
    });

    it('refuses a stale model state', async () => {
        await expect(saveModel(context, 'gpt-5.5', { mode: 'per_call', price: 1 }, 'stale')).rejects.toMatchObject({
            code: 'pricing_stale',
        });
        expect(state.puts).toEqual([]);
    });

    it('surfaces a failed write with what was already written', async () => {
        const view = await loadSimplePricing(admin);
        state.failPut = 'CompletionRatio';
        await expect(
            saveModel(
                context,
                'gpt-5.5',
                { mode: 'token', input: 6, output: 30, cache_read: null, cache_write: null },
                view.upstream_models[0].state,
            ),
        ).rejects.toMatchObject({
            code: 'pricing_write_failed',
            status: 502,
            message: expect.stringContaining('ModelRatio'),
        });
        expect(state.created).toEqual([]);
        expect(state.audits).toEqual([]);
    });

    it('fails verification when new-api does not keep the write', async () => {
        state.dropPut = 'GroupRatio';
        await expect(saveTier(context, 'g-official', 3, 3.4)).rejects.toMatchObject({ code: 'pricing_verify_failed' });
        expect(state.created).toEqual([]);
    });

    it('resyncs only stale catalog rows and never writes new-api', async () => {
        const result = await resyncCatalog(context);
        expect(result.catalog_rows).toBe(1);
        expect(state.created).toEqual([expect.objectContaining({ tier: 'official', input_cny_per_1m: 17 })]);
        expect(state.puts).toEqual([]);
    });
});
