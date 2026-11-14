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
    updates: [] as unknown[],
    logs: [] as unknown[],
    managed: [] as Array<{ newapi_group: string }>,
    costRules: [] as Array<Record<string, unknown>>,
    costWrites: [] as unknown[],
    costRevisions: [] as unknown[],
}));

vi.mock('@/lib/newapi/client', () => ({
    getPricingPublishOptions: vi.fn(async () => ({ ...state.options })),
    putPricingPublishOption: vi.fn(async (key: string, value: string) => {
        if (state.failPut === key) throw new Error('boom');
        state.puts.push([key, value]);
        if (state.dropPut !== key) state.options[key] = value;
    }),
    getPricingRuntimeModels: vi.fn(),
    queryLogs: vi.fn(async () => ({ items: state.logs, total: state.logs.length })),
}));

vi.mock('@/lib/admin/pricing-publish-lock', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/admin/pricing-publish-lock')>()),
    assertPricingCatalogWritable: vi.fn(async () => {}),
}));

vi.mock('@/lib/db', () => {
    const db = {
        channelGroup: {
            findMany: vi.fn(async () => state.groups),
            update: vi.fn(async (args: unknown) => {
                state.updates.push(args);
                return args;
            }),
        },
        catalogModel: {
            findMany: vi.fn(async () => state.models),
            findFirst: vi.fn(async (args: { where: { id: string } }) =>
                (state.models as Array<{ id: string }>).find((model) => model.id === args.where.id),
            ),
        },
        pricingCostRule: {
            findMany: vi.fn(async () => state.costRules),
            findUnique: vi.fn(
                async (args: { where: { model_id_tier?: { model_id: string; tier: string } } }) =>
                    state.costRules.find(
                        (rule) =>
                            rule.model_id === args.where.model_id_tier?.model_id &&
                            rule.tier === args.where.model_id_tier?.tier,
                    ) ?? null,
            ),
            create: vi.fn(async (args: { data: Record<string, unknown> }) => {
                state.costWrites.push({ action: 'create', ...args.data });
                const rule = { id: 'cost-new', revision: 1, updated_at: new Date(0), ...args.data };
                state.costRules.push(rule);
                return rule;
            }),
            update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
                state.costWrites.push({ action: 'update', id: args.where.id, ...args.data });
                const rule = state.costRules.find((row) => row.id === args.where.id)!;
                Object.assign(rule, args.data, { revision: Number(rule.revision) + 1 });
                return rule;
            }),
        },
        pricingCostRuleRevision: {
            create: vi.fn(async (args: { data: unknown }) => {
                state.costRevisions.push(args.data);
                return args.data;
            }),
        },
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
        pricingBillingGroup: { findMany: vi.fn(async () => state.managed) },
    };
    return { prisma: { ...db, $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)) } };
});

import {
    loadSimplePricing,
    lookupBillLog,
    previewModel,
    previewTier,
    previewVideoQuote,
    resyncCatalog,
    saveModel,
    savePurchaseRate,
    saveTier,
    saveVideoQuote,
    type SimplePricingContext,
} from '@/lib/admin/pricing-simple';
import type { AdminPrincipal } from '@/lib/admin/auth';

const EXPR = 'billing_setting.billing_expr';
const MODE = 'billing_setting.billing_mode';
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
    state.managed = [];
    state.created = [];
    state.audits = [];
    state.updates = [];
    state.logs = [];
    state.costRules = [];
    state.costWrites = [];
    state.costRevisions = [];
    state.groups = [
        {
            id: 'g-official',
            key: 'official',
            display_name: '官方',
            newapi_group: 'official',
            tier_level: 1,
            purchase_rate: null,
            newapi_channel_ids: [9],
            is_default: false,
            enabled: true,
        },
        {
            id: 'g-pool',
            key: 'pool',
            display_name: '号池',
            newapi_group: 'default',
            tier_level: 0,
            purchase_rate: '0.3',
            newapi_channel_ids: [13],
            is_default: true,
            enabled: true,
        },
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
                tier.purchase_rate,
            ]),
        ).toEqual([
            ['pool', 1.2, 7, 2, 1, 0.3],
            ['official', 3.4, 0, 0, 1, null],
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

    it('refuses to write the ratio of a group managed by sale rules', async () => {
        state.managed = [{ newapi_group: 'default' }];
        const view = await loadSimplePricing(admin);
        expect(view.tiers.find((tier) => tier.key === 'pool')?.sale_rules_managed).toBe(true);
        expect(view.tiers.find((tier) => tier.key === 'official')?.sale_rules_managed).toBe(false);
        await expect(saveTier(context, 'g-pool', 2.4, 1.2)).rejects.toMatchObject({
            code: 'pricing_sale_rules_managed',
        });
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

describe('purchase rate', () => {
    it('saves a tier purchase rate in Portal only and audits it', async () => {
        expect(await savePurchaseRate(context, 'g-official', 0.85)).toEqual({ purchase_rate: 0.85 });
        expect(state.updates).toEqual([{ where: { id: 'g-official' }, data: { purchase_rate: 0.85 } }]);
        expect(state.audits[0]).toMatchObject({ action: 'pricing_tier_purchase_rate', target: 'official' });
        expect(state.puts).toEqual([]);
    });

    it('clears a purchase rate', async () => {
        expect(await savePurchaseRate(context, 'g-pool', null)).toEqual({ purchase_rate: null });
        expect(state.updates).toEqual([{ where: { id: 'g-pool' }, data: { purchase_rate: null } }]);
    });

    it('rejects an invalid rate or unknown tier', async () => {
        await expect(savePurchaseRate(context, 'g-pool', 0)).rejects.toMatchObject({
            code: 'pricing_purchase_rate_invalid',
            status: 400,
        });
        await expect(savePurchaseRate(context, 'nope', 1)).rejects.toMatchObject({ code: 'pricing_tier_not_found' });
        expect(state.updates).toEqual([]);
    });
});

describe('lookupBillLog', () => {
    const row = (request_id: string, group: string) => ({
        request_id,
        created_at: 1_760_000_000,
        model_name: 'gpt-5.5',
        group,
        channel: 3,
        quota: 4200,
        prompt_tokens: 100,
        completion_tokens: 50,
        other: JSON.stringify({ cache_tokens: 20, group_ratio: 1.2 }),
    });

    it('returns the exact request and maps its group to a tier', async () => {
        state.logs = [row('other-id', 'official'), row('req-1', 'default')];
        const lookup = await lookupBillLog(admin, 'req-1');
        expect(lookup.tier).toBe('pool');
        expect(lookup.log).toMatchObject({ request_id: 'req-1', quota: 4200, usage: { cache_read: 20 } });
        expect(state.puts).toEqual([]);
    });

    it('returns a null tier for an unmapped group and 404 when nothing matches', async () => {
        state.logs = [row('req-2', 'vip')];
        expect((await lookupBillLog(admin, 'req-2')).tier).toBeNull();
        await expect(lookupBillLog(admin, 'missing')).rejects.toMatchObject({
            code: 'pricing_log_not_found',
            status: 404,
        });
    });
});

describe('video-token quotes', () => {
    // doubao-seedance-2-0-mini official ¥/1M, in canonical cell order.
    const OFFICIAL = [23, 14, 23, 14, 25.5, 15.5, 25.5, 15.5];
    const COMBOS: Array<[string, string]> = [
        ['480p', 'none'],
        ['480p', 'video'],
        ['720p', 'none'],
        ['720p', 'video'],
        ['1080p', 'none'],
        ['1080p', 'video'],
        ['4k', 'none'],
        ['4k', 'video'],
    ];
    const formula = (prices: number[]) =>
        COMBOS.map(([resolution, input], index) => {
            const call = `tier("${resolution}·${input}", u("tokens") * ${prices[index]} / 1000000)`;
            return index === COMBOS.length - 1
                ? call
                : `u("resolution") == "${resolution}" && u("video_input") == "${input}" ? ${call}`;
        }).join(' : ');
    const quote = (buy: number, sell: number) => ({
        official: COMBOS.map(([resolution, video_input], index) => ({
            resolution: resolution as '480p',
            video_input: video_input as 'none',
            price: OFFICIAL[index],
        })),
        buy_discount: buy,
        sell_discount: sell,
    });
    const SEEDANCE = 'doubao-seedance-2-0-mini-260615';

    beforeEach(() => {
        // Coefficients at the old ÷7.5 convention, billed at the pool ratio 1.2.
        state.options[MODE] = JSON.stringify({ [SEEDANCE]: 'tiered_expr' });
        state.options[EXPR] = JSON.stringify({
            [SEEDANCE]: formula([3.07, 1.87, 3.07, 1.87, 3.4, 2.07, 3.4, 2.07]),
        });
        state.models = [
            {
                id: '11111111-1111-4111-8111-111111111111',
                slug: SEEDANCE,
                display_name: 'Seedance 2.0 mini',
                vendor: 'volc',
                modality: 'video',
                enabled: true,
                upstream_map: { pool: { channel_id: 13, upstream_model: SEEDANCE } },
                prices: [],
            },
        ];
    });

    it('shows the stored quote, leaves unverified static rates blank and shows the live coefficients', async () => {
        const view = await loadSimplePricing(admin);
        const model = view.upstream_models.find((row) => row.name === SEEDANCE)!;
        expect(model.base).toMatchObject({ mode: 'video_token' });
        const videoQuote = model.video_quote!;
        expect(videoQuote).toMatchObject({
            model_id: '11111111-1111-4111-8111-111111111111',
            tier: 'pool',
            newapi_group: 'default',
            group_ratio: 1.2,
            rule: null,
            drift: false,
        });
        // The shared Seedance table is only a manual snapshot, not a live official source.
        // Do not turn it into a sale quote without the operator verifying every rate.
        expect(videoQuote.prefill).toBeNull();
    });

    it('previews the coefficients, margins and what new-api bills today', async () => {
        const preview = await previewVideoQuote(admin, SEEDANCE, quote(0.36, 0.45));
        expect(preview).toMatchObject({ unchanged: false, tier: 'pool', group_ratio: 1.2 });
        expect(preview.cells[0]).toMatchObject({
            resolution: '480p',
            video_input: 'none',
            official: 23,
            cost: 8.28,
            target: 10.35,
            // 10.35 ÷ 1.2 = 8.625, rounded up to two decimals.
            coefficient: 8.63,
            actual: 10.356,
            current_coefficient: 3.07,
        });
        expect(preview.cells[0].margin).toBe(0.200463);
        expect(preview.warnings.join(' ')).toContain('向上取整');
        expect(state.puts).toEqual([]);
    });

    it('refuses a sell discount below the buy discount', async () => {
        await expect(previewVideoQuote(admin, SEEDANCE, quote(0.45, 0.36))).rejects.toMatchObject({
            code: 'pricing_video_quote_invalid',
            status: 400,
        });
    });

    it('saves the quote, writes one option, snapshots the catalog and audits', async () => {
        const view = await loadSimplePricing(admin);
        const model = view.upstream_models.find((row) => row.name === SEEDANCE)!;
        const result = await saveVideoQuote(context, SEEDANCE, quote(0.36, 0.45), model.state, null);
        expect(result).toMatchObject({ unchanged: false, written_keys: [EXPR] });
        // Only the expression changes; the mode and every ratio are left alone.
        expect(state.puts.map(([key]) => key)).toEqual([EXPR]);
        expect(JSON.parse(state.puts[0][1])[SEEDANCE]).toBe(formula([8.63, 5.25, 8.63, 5.25, 9.57, 5.82, 9.57, 5.82]));
        // The quote is stored as this model's cost rule, with both discounts.
        expect(state.costWrites[0]).toMatchObject({
            action: 'create',
            channel_id: 13,
            upstream_model: SEEDANCE,
            config: expect.objectContaining({
                basis: 'video',
                video_unit: 'million_tokens',
                upstream_multiplier: 0.36,
                retail_multiplier: 0.45,
            }),
        });
        expect(state.costRevisions).toHaveLength(1);
        const snapshot = state.created[0] as { tier: string; billing_details: { cells: Array<{ price: number }> } };
        expect(snapshot.tier).toBe('pool');
        expect(snapshot.billing_details.cells[0].price).toBe(10.356);
        expect(state.audits[0]).toMatchObject({ action: 'pricing_video_quote', target: SEEDANCE });
    });

    it('refuses a stale model state or revision without writing anything', async () => {
        const view = await loadSimplePricing(admin);
        const model = view.upstream_models.find((row) => row.name === SEEDANCE)!;
        await expect(saveVideoQuote(context, SEEDANCE, quote(0.36, 0.45), 'stale', null)).rejects.toMatchObject({
            code: 'pricing_stale',
        });
        await expect(saveVideoQuote(context, SEEDANCE, quote(0.36, 0.45), model.state, 7)).rejects.toMatchObject({
            code: 'pricing_cost_revision',
        });
        expect(state.puts).toEqual([]);
        expect(state.costWrites).toEqual([]);
    });

    it('refuses to reprice a tier managed by sale rules', async () => {
        state.managed = [{ newapi_group: 'default' }];
        const view = await loadSimplePricing(admin);
        const model = view.upstream_models.find((row) => row.name === SEEDANCE)!;
        expect(model.video_quote?.sale_rules_managed).toBe(true);
        await expect(previewVideoQuote(admin, SEEDANCE, quote(0.36, 0.45))).rejects.toMatchObject({
            code: 'pricing_sale_rules_managed',
        });
        await expect(saveVideoQuote(context, SEEDANCE, quote(0.36, 0.45), model.state, null)).rejects.toMatchObject({
            code: 'pricing_sale_rules_managed',
        });
        expect(state.puts).toEqual([]);
    });

    it('flags a stored quote that no longer matches what new-api bills', async () => {
        state.costRules = [
            {
                id: 'cost-1',
                model_id: '11111111-1111-4111-8111-111111111111',
                tier: 'pool',
                revision: 3,
                channel_id: 13,
                upstream_model: SEEDANCE,
                updated_at: new Date('2026-11-06T00:00:00Z'),
                config: {
                    version: 1,
                    basis: 'video',
                    video_unit: 'million_tokens',
                    currency: 'cny',
                    credits_per_cny: 1,
                    upstream_multiplier: 0.36,
                    retail_multiplier: 0.45,
                    markup_percent: 0,
                    source_note: '',
                    token_rates: { input: null, output: null, cache_read: null, cache_write: null },
                    variants: COMBOS.map(([resolution, input], index) => ({
                        key: `${resolution}-${input}`,
                        label: `${resolution} ${input}`,
                        resolution,
                        audio: 'any',
                        reference_video: input === 'video' ? 'with' : 'without',
                        price: OFFICIAL[index],
                        minimum_units: 1,
                        step_units: 1,
                    })),
                },
            },
        ];
        const view = await loadSimplePricing(admin);
        const videoQuote = view.upstream_models.find((row) => row.name === SEEDANCE)!.video_quote!;
        // The live formula still holds the old ÷7.5 coefficients, not 官方价 × 0.45.
        expect(videoQuote.drift).toBe(true);
        expect(videoQuote.rule).toMatchObject({ id: 'cost-1', revision: 3 });
        expect(videoQuote.rule?.quote?.sell_discount).toBe(0.45);
        expect(videoQuote.prefill).toBeNull();
    });
});
