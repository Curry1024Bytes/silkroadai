import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, api } = vi.hoisted(() => ({
    db: {
        user: { findUnique: vi.fn() },
        channelGroup: { findMany: vi.fn() },
        catalogModel: { findMany: vi.fn() },
        customerOfficialReference: { findMany: vi.fn() },
        pricingCostRule: { findMany: vi.fn() },
        customerOfficialPriceRule: { findMany: vi.fn() },
        userTierMultiplier: { findMany: vi.fn() },
        customerPricingBinding: { findMany: vi.fn() },
        customerModelBillingGroup: { findMany: vi.fn() },
    },
    api: { getPricingPublishOptions: vi.fn(), listChannelsForCatalogSync: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/newapi/client', () => api);
vi.mock('@/lib/newapi/user-tier-multiplier', () => ({
    internalNewApiUserGroup: (id: string) => `portal-user-${id.replaceAll('-', '')}`,
}));
vi.mock('@/lib/newapi/quota-units', () => ({ QUOTA_PER_USD: 500_000, USD_TO_CNY_RATE: 1 }));

import { loadOfficialContext, publicOfficialView } from '../context';
import { flattenBase } from '../math';
import { readBasePrice } from '@/lib/admin/pricing-simple-core';
import { videoQuoteCostConfig } from '@/lib/admin/pricing-video-quote';
import { videoTokenCombosForModel, videoTokenKey } from '@/lib/admin/pricing-video-token-expression';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

const USER = '12345678-1234-4234-8234-123456789abc';
const MODEL_ID = '11111111-1111-4111-8111-111111111111';
const MODEL = 'doubao-seedance-2-5-260628';
const TIER = 'sd';
const GROUP = 'SD官转';
const INTERNAL_USER = `portal-user-${USER.replaceAll('-', '')}`;
const NATIVE_GROUP = `portal-price-${'a'.repeat(32)}`;
const MODE = 'billing_setting.billing_mode';
const EXPR = 'billing_setting.billing_expr';
const combos = videoTokenCombosForModel(MODEL);

function expression(scale = 1) {
    return combos
        .map((combo, index) => {
            const price = (combo.video_input === 'none' ? 100 : 50) * scale;
            const tier = `tier("${videoTokenKey(combo)}", u("tokens") * ${price} / 1000000)`;
            return index === combos.length - 1
                ? tier
                : `u("resolution") == "${combo.resolution}" && u("video_input") == "${combo.video_input}" ? ${tier} : `;
        })
        .join('');
}

function pricingOptions(): Record<string, unknown> {
    return {
        ModelRatio: {},
        CompletionRatio: {},
        ModelPrice: {},
        CacheRatio: {},
        CreateCacheRatio: {},
        GroupRatio: { [GROUP]: 0.3 },
        GroupGroupRatio: { [INTERNAL_USER]: { [NATIVE_GROUP]: 0.2 } },
        [MODE]: { [MODEL]: 'tiered_expr' },
        [EXPR]: { [MODEL]: expression() },
    };
}

function sourceChannels() {
    return [
        {
            id: 13,
            status: 1,
            name: 'Seedance source',
            group: GROUP,
            models: MODEL,
            key: 'PRIVATE_CHANNEL_KEY',
            channel_info: { is_multi_key: true, key_status: { PRIVATE_NESTED_KEY: 1 } as Record<string, number> },
            base_url: 'https://supplier.invalid',
            balance: 100,
            used_quota: 200,
            response_time: 300,
            test_time: 400,
        },
    ];
}

function activeRegistry() {
    return {
        tier_key: TIER,
        model_id: MODEL_ID,
        model_name: MODEL,
        public_group: GROUP,
        internal_group: NATIVE_GROUP,
        status: 'active',
        source_channel_ids: [13],
        replica_channel_ids: [113],
    };
}

type Reference = {
    id: string;
    model_id: string;
    tier_key: string;
    shape: string;
    cells: unknown;
    revision: number;
    source_note: string;
};
type Binding = { tier_key: string; public_group: string; model_groups: string[]; status: string; revision: number };
let options: Record<string, unknown>;
let references: Reference[];
let channels: ReturnType<typeof sourceChannels>;
let bindings: Binding[];
let registry: ReturnType<typeof activeRegistry>[];

function explicitReference(): Reference {
    return {
        id: 'reference-a',
        model_id: MODEL_ID,
        tier_key: TIER,
        shape: flattenBase(readBasePrice(options, MODEL)!, 1).shape,
        cells: combos.map((combo) => ({
            key: videoTokenKey(combo),
            official_cny: combo.video_input === 'none' ? 200 : 100,
        })),
        revision: 2,
        source_note: '人工核对官方价格表',
    };
}

function savedVideoOfficialMatrix() {
    return {
        model_id: MODEL_ID,
        tier: TIER,
        channel_id: 13,
        upstream_model: MODEL,
        revision: 5,
        config: videoQuoteCostConfig(
            {
                official: combos.map((combo) => ({ ...combo, price: combo.video_input === 'none' ? 100 : 50 })),
                buy_discount: 0.1,
                sell_discount: 0.3,
            },
            MODEL,
        ),
    };
}

const firstModel = (context: Awaited<ReturnType<typeof loadOfficialContext>>) => context.tiers[0].models[0];

beforeEach(() => {
    vi.clearAllMocks();
    options = pricingOptions();
    references = [explicitReference()];
    channels = sourceChannels();
    bindings = [];
    registry = [];
    db.user.findUnique.mockResolvedValue({
        id: USER,
        tenant_id: null,
        newapi_user_id: 7,
        newapi_access_token: 'PRIVATE_CUSTOMER_AUTH',
    });
    db.channelGroup.findMany.mockResolvedValue([
        {
            key: TIER,
            display_name: 'Seedance',
            newapi_group: GROUP,
            newapi_channel_ids: [13],
            enabled: true,
            is_default: true,
            tier_level: 0,
        },
    ]);
    db.catalogModel.findMany.mockResolvedValue([
        {
            id: MODEL_ID,
            slug: MODEL,
            display_name: 'Seedance 2.5',
            upstream_map: { [TIER]: { channel_id: 13, upstream_model: MODEL } },
        },
    ]);
    db.customerOfficialReference.findMany.mockImplementation(async () => references);
    db.pricingCostRule.findMany.mockResolvedValue([savedVideoOfficialMatrix()]);
    db.customerOfficialPriceRule.findMany.mockResolvedValue([]);
    db.userTierMultiplier.findMany.mockResolvedValue([]);
    db.customerPricingBinding.findMany.mockImplementation(async () => bindings);
    db.customerModelBillingGroup.findMany.mockImplementation(async () => registry);
    api.getPricingPublishOptions.mockImplementation(async () => options);
    api.listChannelsForCatalogSync.mockImplementation(async () => channels);
});

describe('real official pricing context', () => {
    it('prefers an explicitly confirmed official reference to the saved video cost matrix', async () => {
        const context = await loadOfficialContext(USER);
        const model = firstModel(context);

        expect(model.reference_available).toBe(true);
        expect(model.reference_revision).toBe('reference:reference-a:2');
        expect(model.reference_source).toBe('人工核对官方价格表');
        expect(model.cells.find((cell) => cell.key === '720p·none')).toMatchObject({
            official_cny: 200,
            base_cny: 100,
            public_cny: 30,
            cost_cny: 10,
        });
        expect(model.public_official_multiplier).toBe(0.15);
        expect(db.customerOfficialReference.findMany).toHaveBeenCalledWith({
            where: { tenant_id: PLATFORM_TENANT_ID },
        });
    });

    it('uses the saved complete video official matrix only when no explicit reference exists', async () => {
        references = [];
        const model = firstModel(await loadOfficialContext(USER));

        expect(model.reference_available).toBe(true);
        expect(model.reference_revision).toMatch(/^video:5:[a-f0-9]{64}$/);
        expect(model.cells.find((cell) => cell.key === '720p·none')?.official_cny).toBe(100);
        expect(model.public_official_multiplier).toBe(0.3);
    });

    it('never treats a readable public quote as an official reference when official sources are missing', async () => {
        references = [];
        db.pricingCostRule.findMany.mockResolvedValue([]);
        const model = firstModel(await loadOfficialContext(USER));

        expect(model.reference_available).toBe(false);
        expect(model.reference_revision).toBeNull();
        expect(model.public_official_multiplier).toBeNull();
        expect(model.unavailable_reason).toContain('尚未确认官方基准');
        expect(model.cells.find((cell) => cell.key === '720p·none')).toMatchObject({
            base_cny: 100,
            public_cny: 30,
            official_cny: 0,
        });
    });

    it('reads the actual native user ratio for an active binding instead of public or legacy multipliers', async () => {
        bindings = [
            { tier_key: TIER, public_group: GROUP, model_groups: [NATIVE_GROUP], status: 'active', revision: 3 },
        ];
        registry = [activeRegistry()];
        db.userTierMultiplier.findMany.mockResolvedValue([
            { tier_key: TIER, newapi_billing_group: GROUP, multiplier: 0.8 },
        ]);
        const context = await loadOfficialContext(USER);
        const model = firstModel(context);

        expect(context.tiers[0].binding_status).toBe('active');
        expect(model.reference_available).toBe(true);
        expect(model.current_ratio).toBe(0.2);
        expect(model.current_official_multiplier).toBe(0.1);
    });

    it('fails closed for a missing native ratio, missing registry, wrong public group or inactive registry', async () => {
        bindings = [
            { tier_key: TIER, public_group: GROUP, model_groups: [NATIVE_GROUP], status: 'active', revision: 3 },
        ];
        registry = [activeRegistry()];
        options.GroupGroupRatio = {};
        expect(firstModel(await loadOfficialContext(USER))).toMatchObject({
            reference_available: false,
            unavailable_reason: expect.stringMatching(/核对|绑定|分组/),
        });

        options = pricingOptions();
        const invalidRegistries = [
            [],
            [{ ...activeRegistry(), public_group: 'OTHER' }],
            [{ ...activeRegistry(), status: 'preparing' }],
            [{ ...activeRegistry(), replica_channel_ids: [] }],
        ];
        for (const invalidRegistry of invalidRegistries) {
            registry = invalidRegistry;
            expect(firstModel(await loadOfficialContext(USER))).toMatchObject({
                reference_available: false,
                unavailable_reason: expect.stringMatching(/核对|绑定|分组/),
            });
        }
    });

    it('rejects an unknown customer before reading pricing or provider configuration', async () => {
        db.user.findUnique.mockResolvedValue(null);
        await expect(loadOfficialContext(USER)).rejects.toMatchObject({ code: 'customer_missing', status: 404 });
        expect(api.getPricingPublishOptions).not.toHaveBeenCalled();
        expect(api.listChannelsForCatalogSync).not.toHaveBeenCalled();
    });

    it('marks a model alias unavailable rather than pricing it as the upstream model', async () => {
        db.catalogModel.findMany.mockResolvedValue([
            {
                id: MODEL_ID,
                slug: 'artsdance-2.5',
                display_name: 'Artsdance',
                upstream_map: { [TIER]: { channel_id: 13, upstream_model: MODEL } },
            },
        ]);
        const model = firstModel(await loadOfficialContext(USER));
        expect(model.reference_available).toBe(false);
        expect(model.unavailable_reason).toContain('目录模型名与实际计费模型名不同');
        expect(model.cells).toEqual([]);
    });

    it('refuses ambiguous duplicate official rules instead of selecting the first rule', async () => {
        db.customerOfficialPriceRule.findMany.mockResolvedValue([
            { id: 'rule-a', tier_key: TIER, model_key: '*', official_multiplier: 0.2, revision: 1 },
            { id: 'rule-b', tier_key: TIER, model_key: '*', official_multiplier: 0.15, revision: 1 },
        ]);
        const model = firstModel(await loadOfficialContext(USER));
        expect(model.reference_available).toBe(false);
        expect(model.unavailable_reason).toContain('客户定价规则重复');
    });

    it('refuses changed or incomplete explicit references without falling back to the video official matrix', async () => {
        references[0].shape = 'old-shape';
        expect(firstModel(await loadOfficialContext(USER))).toMatchObject({
            reference_available: false,
            unavailable_reason: expect.stringContaining('已确认官方基准不同'),
        });

        references = [{ ...explicitReference(), cells: [{ key: '720p·none', official_cny: 200 }] }];
        expect(firstModel(await loadOfficialContext(USER))).toMatchObject({
            reference_available: false,
            unavailable_reason: expect.stringContaining('完整覆盖全部计费档位'),
        });
    });

    it('keeps the version stable across authentication-key rotation and provider live-counter changes', async () => {
        const before = await loadOfficialContext(USER);
        db.user.findUnique.mockResolvedValue({
            id: USER,
            tenant_id: null,
            newapi_user_id: 7,
            newapi_access_token: 'ROTATED_CUSTOMER_AUTH',
        });
        channels[0] = {
            ...channels[0],
            key: 'ROTATED_CHANNEL_KEY',
            channel_info: { is_multi_key: false, key_status: { ROTATED_NESTED_KEY: 0 } },
            balance: 999,
            used_quota: 999,
            response_time: 999,
            test_time: 999,
        };
        const after = await loadOfficialContext(USER);

        expect(after.version).toBe(before.version);
        const states = JSON.stringify(after.model_states);
        expect(states).not.toContain('KEY');
        expect(states).not.toContain('balance');
        expect(states).not.toContain('used_quota');
        expect(states).not.toContain('response_time');
        expect(states).not.toContain('test_time');
    });

    it('changes the version when real prices, source configuration or official provenance change', async () => {
        const initialVersion = (await loadOfficialContext(USER)).version;
        options[EXPR] = { [MODEL]: expression(2) };
        expect((await loadOfficialContext(USER)).version).not.toBe(initialVersion);

        options = pricingOptions();
        channels[0].base_url = 'https://changed-supplier.invalid';
        expect((await loadOfficialContext(USER)).version).not.toBe(initialVersion);

        channels = sourceChannels();
        references[0].source_note = '重新核对的官方价格来源';
        expect((await loadOfficialContext(USER)).version).not.toBe(initialVersion);
    });

    it('returns only the public official-pricing view and never exposes credentials, options or provider objects', async () => {
        const context = await loadOfficialContext(USER);
        const view = publicOfficialView(context);

        expect(Object.keys(view).sort()).toEqual(['rules', 'tiers', 'version']);
        expect(view).toEqual({ version: context.version, tiers: context.tiers, rules: context.rules });
        const serialized = JSON.stringify(view);
        expect(serialized).not.toContain('PRIVATE_CUSTOMER_AUTH');
        expect(serialized).not.toContain('PRIVATE_CHANNEL_KEY');
        expect(serialized).not.toContain('PRIVATE_NESTED_KEY');
        expect(serialized).not.toContain('supplier.invalid');
        expect(serialized).not.toContain('newapi_access_token');
        expect(serialized).not.toContain('channel_info');
        expect(serialized).not.toContain('GroupGroupRatio');
        expect(serialized).not.toContain('ModelRatio');
    });
});
