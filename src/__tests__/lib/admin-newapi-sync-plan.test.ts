import { afterEach, describe, expect, it, vi } from 'vitest';

const forbiddenIo = vi.hoisted(() => ({ getOption: vi.fn(), putOption: vi.fn(), findFirst: vi.fn() }));
vi.mock('@/lib/newapi/client', () => ({ getOption: forbiddenIo.getOption, putOption: forbiddenIo.putOption }));
vi.mock('@/lib/db', () => ({ prisma: { channelGroup: { findFirst: forbiddenIo.findFirst } } }));

import {
    buildNewApiSyncPlan,
    currentSyncPrice,
    type SyncGroup,
    type SyncModel,
    type SyncPrice,
    type SyncState,
} from '@/lib/admin/newapi-sync-plan';
import type { NewApiSyncSource, SyncChannel } from '@/lib/admin/newapi-sync-source';
import { CHAT_FX, IMAGE_FX } from '@/lib/newapi/pricing-sync';

const NOW = Date.parse('2026-09-11T08:00:00.000Z');
const TIER = 'gpt特惠分组';
const GROUP = 'GPT-特惠反代';
const MODEL = 'gpt-5.4';
const rounded = (value: number) => Number(value.toFixed(4));

function group(overrides: Partial<SyncGroup> = {}): SyncGroup {
    return {
        id: 'group-1',
        key: TIER,
        display_name: '特惠',
        newapi_group: GROUP,
        newapi_channel_ids: [6],
        enabled: true,
        is_default: true,
        tier_level: 1,
        updated_at: '2026-09-10T08:00:00.000Z',
        ...overrides,
    };
}
function model(overrides: Partial<SyncModel> = {}): SyncModel {
    return {
        id: 'model-1',
        slug: MODEL,
        display_name: 'GPT 5.4',
        vendor: 'openai',
        modality: 'chat',
        enabled: true,
        sort_order: 3,
        upstream_map: { [TIER]: { channel_id: 6, upstream_model: MODEL } },
        updated_at: '2026-09-10T08:00:00.000Z',
        ...overrides,
    };
}
function price(overrides: Partial<SyncPrice> = {}): SyncPrice {
    return {
        id: 'price-1',
        model_id: 'model-1',
        tier: TIER,
        effective_from: '2026-09-10T08:00:00.000Z',
        input_cny_per_1m: 1,
        output_cny_per_1m: 4,
        per_image_cny: null,
        cost_cny_per_1m: 0.15,
        ...overrides,
    };
}
function channel(overrides: Partial<SyncChannel> = {}): SyncChannel {
    return { id: 6, name: 'GPT channel', status: 1, groups: [GROUP], models: [MODEL], ...overrides };
}
function state(overrides: Partial<SyncState> = {}): SyncState {
    return { groups: [group()], models: [model()], prices: [], ...overrides };
}
function source(overrides: Partial<NewApiSyncSource> = {}): NewApiSyncSource {
    return {
        groups: { [GROUP]: '特惠' },
        channels: [channel()],
        prices: {
            modelRatio: JSON.stringify({ [MODEL]: 0.5 }),
            completionRatio: JSON.stringify({ [MODEL]: 4 }),
            modelPrice: '{}',
            groupRatio: JSON.stringify({ [GROUP]: 0.2 }),
        },
        ...overrides,
    };
}

afterEach(() => {
    expect(forbiddenIo.getOption).not.toHaveBeenCalled();
    expect(forbiddenIo.putOption).not.toHaveBeenCalled();
    expect(forbiddenIo.findFirst).not.toHaveBeenCalled();
});

const ready = () => rounded(0.5 * CHAT_FX * 0.2);
const livePrice = () => price({ input_cny_per_1m: ready(), output_cny_per_1m: rounded(ready() * 4) });
function withExternal(overrides: { ratio?: boolean; groups?: Record<string, string> } = {}): NewApiSyncSource {
    const upstream = source({
        groups: { [GROUP]: '特惠', ...(overrides.groups ?? { 外接: '外接档' }) },
        channels: [
            channel(),
            ...Object.keys(overrides.groups ?? { 外接: '' }).map((name, index) =>
                channel({ id: 13 + index, name: `ext ${index}`, groups: [name], models: ['claude-new'] }),
            ),
        ],
    });
    const names = Object.keys(overrides.groups ?? { 外接: '' });
    upstream.prices.modelRatio = { [MODEL]: 0.5, 'claude-new': 1.5 };
    upstream.prices.completionRatio = { [MODEL]: 4, 'claude-new': 5 };
    upstream.prices.groupRatio = {
        [GROUP]: 0.2,
        ...(overrides.ratio === false ? {} : Object.fromEntries(names.map((name) => [name, 1]))),
    };
    return upstream;
}

describe('buildNewApiSyncPlan prices', () => {
    it('adds a missing catalog price from global model ratios', () => {
        const plan = buildNewApiSyncPlan(state(), source(), NOW);
        expect(plan.groups).toHaveLength(0);
        expect(plan.models).toHaveLength(0);
        expect(plan.prices).toHaveLength(1);
        expect(plan.prices[0]).toMatchObject({
            slug: MODEL,
            tier: TIER,
            current: null,
            next: { input_cny_per_1m: ready(), output_cny_per_1m: rounded(ready() * 4), per_image_cny: null },
            item: { kind: 'price', change: 'create' },
        });
        expect(plan.summary).toMatchObject({ prices_updated: 1, models_published: 0, models_unpublished: 0 });
        expect(plan.blocked).toBeNull();
    });

    it('follows changed new-api prices as a new version and preserves current cost/history', () => {
        const prior = price();
        const input = state({ prices: [prior, price({ id: 'old', effective_from: '2026-08-01T00:00:00.000Z' })] });
        const before = structuredClone(input);
        const plan = buildNewApiSyncPlan(input, source(), NOW);
        expect(plan.prices[0].item.change).toBe('update');
        expect(plan.prices[0].current).toEqual(prior);
        expect(plan.prices[0].current?.cost_cny_per_1m).toBe(0.15);
        expect(input).toEqual(before);
    });

    it('counts identical prices as unchanged without adding another version', () => {
        const plan = buildNewApiSyncPlan(state({ prices: [livePrice()] }), source(), NOW);
        expect(plan.items).toEqual([]);
        expect(plan.unchanged).toEqual({ groups: 1, models: 1, prices: 1 });
    });

    it('does not default missing CompletionRatio into an apparently valid catalog price', () => {
        const upstream = source();
        upstream.prices.completionRatio = '{}';
        const plan = buildNewApiSyncPlan(state(), upstream, NOW);
        expect(plan.prices).toHaveLength(0);
        expect(plan.models).toHaveLength(0);
        expect(plan.warnings.join(' ')).toContain('CompletionRatio');
    });

    it('does not overwrite scheduled future prices or write an immediate competing version', () => {
        const plan = buildNewApiSyncPlan(
            state({
                prices: [
                    price(),
                    price({ id: 'future', effective_from: '2026-09-12T08:00:00.000Z', input_cny_per_1m: 9 }),
                ],
            }),
            source(),
            NOW,
        );
        expect(plan.prices).toEqual([]);
        expect(plan.warnings.join(' ')).toContain('未来生效价格');
    });

    it.each(['1k', '2k', '4k'])('preserves fixed image SKU %s even when new-api reports a different price', (size) => {
        const slug = `gpt-image-2-${size}`;
        const image = model({
            slug,
            modality: 'image',
            upstream_map: { [TIER]: { channel_id: 6, upstream_model: slug } },
        });
        const upstream = source({ channels: [channel({ models: [slug] })] });
        upstream.prices.modelPrice = JSON.stringify({ [slug]: 10 });
        const previous = price({ input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: 1.5 });
        const plan = buildNewApiSyncPlan(state({ models: [image], prices: [previous] }), upstream, NOW);
        expect(plan.prices).toEqual([]);
        expect(plan.unchanged.prices).toBe(1);
        expect(previous.per_image_cny).toBe(1.5);
    });

    it('does not invent or publish a fixed SKU missing its protected catalog price', () => {
        const slug = 'gpt-image-2-1k';
        const image = model({
            slug,
            modality: 'image',
            enabled: false,
            upstream_map: { [TIER]: { channel_id: 6, upstream_model: slug } },
        });
        const upstream = source({ channels: [channel({ models: [slug] })] });
        upstream.prices.modelPrice = { [slug]: 10 };
        const plan = buildNewApiSyncPlan(state({ models: [image] }), upstream, NOW);
        expect(plan.prices).toEqual([]);
        expect(plan.models).toEqual([]);
        expect(plan.warnings.join(' ')).toContain('固定图片规格');
    });

    it('converts an ordinary fixed image price using the configured group and image conversion', () => {
        const slug = 'grok-imagine-image';
        const image = model({
            slug,
            modality: 'image',
            upstream_map: { [TIER]: { channel_id: 6, upstream_model: slug } },
        });
        const upstream = source({ channels: [channel({ models: [slug] })] });
        upstream.prices.modelPrice = { [slug]: 0.12 };
        const plan = buildNewApiSyncPlan(state({ models: [image] }), upstream, NOW);
        expect(plan.prices[0].next).toEqual({
            input_cny_per_1m: null,
            output_cny_per_1m: null,
            per_image_cny: rounded(0.12 * IMAGE_FX * 0.2),
        });
    });

    it('flags token-priced images instead of creating fixed-price images', () => {
        const upstream = source({ channels: [channel({ models: ['gpt-image-2'] })] });
        upstream.prices.modelRatio = { 'gpt-image-2': 2.5 };
        upstream.prices.completionRatio = { 'gpt-image-2': 6 };
        const plan = buildNewApiSyncPlan(state({ models: [] }), upstream, NOW);
        expect(plan.prices).toEqual([]);
        expect(plan.models).toEqual([]);
        expect(plan.warnings.join(' ')).toContain('计费方式无法');
    });

    it('flags per-request chat models instead of presenting a misleading per-image price', () => {
        const upstream = source();
        upstream.prices.modelPrice = { [MODEL]: 0.12 };
        const plan = buildNewApiSyncPlan(state(), upstream, NOW);
        expect(plan.prices).toEqual([]);
        expect(plan.warnings.join(' ')).toContain('计费方式无法');
    });
});

describe('buildNewApiSyncPlan follows new-api channels', () => {
    it('creates and enables a new usable group that has channels and a GroupRatio, and publishes its models', () => {
        const plan = buildNewApiSyncPlan(state({ prices: [livePrice()] }), withExternal(), NOW);
        expect(plan.blocked).toBeNull();
        expect(plan.groups).toHaveLength(1);
        expect(plan.groups[0].next).toMatchObject({ enabled: true, is_default: false, newapi_channel_ids: [13] });
        expect(plan.groups[0].next.key).toMatch(/^[a-z0-9-]+$/);
        const created = plan.models.find((change) => change.next.slug === 'claude-new');
        expect(created?.item.change).toBe('create');
        expect(created?.next).toMatchObject({
            enabled: true,
            upstream_map: { [plan.groups[0].next.key]: { channel_id: 13, upstream_model: 'claude-new' } },
        });
        expect(plan.prices.map((change) => change.slug)).toEqual(['claude-new']);
        expect(plan.summary).toMatchObject({ groups_created: 1, models_published: 1, prices_updated: 1 });
    });

    it('does not create a tier for a group without a GroupRatio', () => {
        const plan = buildNewApiSyncPlan(state({ prices: [livePrice()] }), withExternal({ ratio: false }), NOW);
        expect(plan.groups).toEqual([]);
        expect(plan.models).toEqual([]);
        expect(plan.warnings.join(' ')).toContain('没有设置分组倍率');
    });

    it('creates separate ASCII keys for different Chinese group names without renaming the legacy key', () => {
        const plan = buildNewApiSyncPlan(
            state({ prices: [livePrice()] }),
            withExternal({ groups: { 外接一: '外接一', 外接二: '外接二' } }),
            NOW,
        );
        const keys = plan.groups.map((change) => change.next.key);
        expect(keys).toHaveLength(2);
        expect(new Set(keys).size).toBe(2);
        expect(keys.every((key) => /^[a-z0-9-]+$/.test(key))).toBe(true);
        expect(plan.groups.every((change) => change.current === null)).toBe(true);
        expect(plan.blocked).toBeNull();
    });

    it('publishes an unpublished model once a channel sells it and the price is ready', () => {
        const plan = buildNewApiSyncPlan(state({ models: [model({ enabled: false })] }), source(), NOW);
        expect(plan.models[0].item.change).toBe('publish');
        expect(plan.models[0].next.enabled).toBe(true);
        expect(plan.prices).toHaveLength(1);
        expect(plan.summary.models_published).toBe(1);
    });

    it('does not publish a model whose new-api price is missing', () => {
        const upstream = source();
        upstream.prices.modelRatio = {};
        const plan = buildNewApiSyncPlan(state({ models: [model({ enabled: false })] }), upstream, NOW);
        expect(plan.models).toEqual([]);
        expect(plan.warnings.join(' ')).toContain('未读取到 new-api 价格');
    });

    it('repoints the registry and model mapping when the channel is replaced, keeping custom metadata', () => {
        const input = state({
            groups: [group({ display_name: '运营自定义名称' })],
            models: [model({ display_name: '自定义模型名', vendor: 'custom-vendor' })],
            prices: [livePrice()],
        });
        const before = structuredClone(input);
        const plan = buildNewApiSyncPlan(input, source({ channels: [channel({ id: 14 })] }), NOW);
        expect(plan.groups[0].next).toMatchObject({
            key: TIER,
            display_name: '运营自定义名称',
            newapi_channel_ids: [14],
        });
        expect(plan.models[0].item.change).toBe('update');
        expect(plan.models[0].next).toMatchObject({
            display_name: '自定义模型名',
            vendor: 'custom-vendor',
            enabled: true,
            upstream_map: { [TIER]: { channel_id: 14, upstream_model: MODEL } },
        });
        expect(input).toEqual(before);
    });

    it('repoints unpublished models too, preserving a custom upstream alias', () => {
        const alias = 'claude-legacy-name';
        const upstream = source({ channels: [channel({ id: 14, models: [MODEL, alias] })] });
        upstream.prices.modelRatio = { [MODEL]: 0.5 };
        const plan = buildNewApiSyncPlan(
            state({
                models: [
                    model(),
                    model({
                        id: 'disabled',
                        slug: 'friendly-name',
                        enabled: false,
                        upstream_map: { [TIER]: { channel_id: 6, upstream_model: alias } },
                    }),
                ],
                prices: [livePrice()],
            }),
            upstream,
            NOW,
        );
        expect(plan.models.find((change) => change.next.id === 'disabled')?.next).toMatchObject({
            enabled: false,
            upstream_map: { [TIER]: { channel_id: 14, upstream_model: alias } },
        });
    });

    it('picks the first channel of the tier when several channels sell the model', () => {
        const plan = buildNewApiSyncPlan(
            state({ prices: [livePrice()] }),
            source({ channels: [channel({ id: 13 }), channel({ id: 14 })] }),
            NOW,
        );
        expect(plan.groups[0].next.newapi_channel_ids).toEqual([13, 14]);
        expect(plan.models[0].next.upstream_map[TIER]).toEqual({ channel_id: 13, upstream_model: MODEL });
    });

    it.each(['deleted', 'disabled', 'model-removed'] as const)(
        'unpublishes a model whose channel was %s without deleting it or its price history',
        (failure) => {
            const input = state({ prices: [price()] });
            const before = structuredClone(input);
            const spare = channel({ id: 7, name: 'spare', models: ['other'] });
            const upstream = source({
                channels:
                    failure === 'deleted'
                        ? [spare]
                        : [channel(failure === 'disabled' ? { status: 2 } : { models: [] }), spare],
            });
            const plan = buildNewApiSyncPlan(input, upstream, NOW);
            const unpublished = plan.models.find((change) => change.next.slug === MODEL);
            expect(unpublished?.item.change).toBe('unpublish');
            expect(unpublished?.next.enabled).toBe(false);
            expect(unpublished?.next.upstream_map).toEqual(
                failure === 'model-removed' ? { [TIER]: { channel_id: 6, upstream_model: MODEL } } : {},
            );
            expect(plan.prices).toEqual([]);
            expect(plan.summary.models_unpublished).toBe(1);
            expect(plan.blocked).toBeNull();
            expect(input).toEqual(before);
        },
    );

    it('blocks the sync when the default tier would lose every channel', () => {
        const plan = buildNewApiSyncPlan(state({ prices: [price()] }), source({ channels: [] }), NOW);
        expect(plan.blocked).toContain('默认档次');
    });

    it('disables a non-default tier that lost all channels and drops it from published models', () => {
        const input = state({
            groups: [
                group(),
                group({ id: 'group-2', key: 'side', newapi_group: 'side', newapi_channel_ids: [9], is_default: false }),
            ],
            models: [
                model({
                    upstream_map: {
                        [TIER]: { channel_id: 6, upstream_model: MODEL },
                        side: { channel_id: 9, upstream_model: MODEL },
                    },
                }),
            ],
            prices: [livePrice()],
        });
        const plan = buildNewApiSyncPlan(input, source(), NOW);
        expect(plan.blocked).toBeNull();
        expect(plan.groups.find((change) => change.next.key === 'side')?.next).toMatchObject({
            enabled: false,
            newapi_channel_ids: [],
        });
        expect(plan.models[0].next).toMatchObject({
            enabled: true,
            upstream_map: { [TIER]: { channel_id: 6, upstream_model: MODEL } },
        });
    });

    it('does not guess among multiple source groups for an unregistered channel', () => {
        const upstream = withExternal();
        upstream.channels[1].groups = ['外接', GROUP];
        const plan = buildNewApiSyncPlan(state({ prices: [livePrice()] }), upstream, NOW);
        expect(plan.warnings.join(' ')).toContain('同时属于多个分组');
        expect(plan.groups).toEqual([]);
        expect(plan.models).toEqual([]);
    });

    it('respects an existing unique owner when a channel advertises multiple source groups', () => {
        const upstream = source({
            groups: { [GROUP]: '特惠', extra: '另一个档' },
            channels: [channel({ groups: [GROUP, 'extra'] })],
        });
        upstream.prices.groupRatio = { [GROUP]: 0.2, extra: 1 };
        const plan = buildNewApiSyncPlan(state({ prices: [livePrice()] }), upstream, NOW);
        expect(plan.warnings).toEqual([]);
        expect(plan.items).toEqual([]);
    });

    it('does not touch duplicate Portal owners of one new-api group', () => {
        const input = state({
            groups: [group(), group({ id: 'duplicate', key: 'other', is_default: false, enabled: false })],
        });
        const plan = buildNewApiSyncPlan(input, source(), NOW);
        expect(plan.groups).toEqual([]);
        expect(plan.warnings.join(' ')).toContain('对应多个 Portal 档次');
    });
});

describe('currentSyncPrice', () => {
    it('uses the latest effective price for the exact model and tier, preserving future and other-tier rows', () => {
        const current = price({ id: 'current' });
        const input = state({
            prices: [
                price({ id: 'future', effective_from: '2026-09-12T00:00:00.000Z' }),
                price({ id: 'wrong-model', model_id: 'other' }),
                price({ id: 'wrong-tier', tier: 'other' }),
                price({ id: 'old', effective_from: '2026-09-01T00:00:00.000Z' }),
                current,
            ],
        });
        expect(currentSyncPrice(input, 'model-1', TIER, NOW)).toEqual(current);
    });
});
