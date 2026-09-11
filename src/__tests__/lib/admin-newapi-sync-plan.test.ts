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

describe('buildNewApiSyncPlan prices', () => {
    it('proposes a missing catalog price from global model ratios, not absent channel price fields', () => {
        const plan = buildNewApiSyncPlan(state(), source(), NOW);
        expect(plan.groups).toHaveLength(0);
        expect(plan.models).toHaveLength(0);
        expect(plan.prices).toHaveLength(1);
        const input = rounded(0.5 * CHAT_FX * 0.2);
        expect(plan.prices[0]).toMatchObject({
            slug: MODEL,
            tier: TIER,
            current: null,
            next: { input_cny_per_1m: input, output_cny_per_1m: rounded(input * 4), per_image_cny: null },
            item: { change: 'new', selectable: true, defaultSelected: true },
        });
    });

    it('offers changed existing prices as unchecked versions and preserves current cost/history', () => {
        const prior = price();
        const input = state({ prices: [prior, price({ id: 'old', effective_from: '2026-08-01T00:00:00.000Z' })] });
        const before = structuredClone(input);
        const plan = buildNewApiSyncPlan(input, source(), NOW);
        expect(plan.prices[0].item).toMatchObject({ change: 'update', defaultSelected: false, selectable: true });
        expect(plan.prices[0].current).toEqual(prior);
        expect(plan.prices[0].current?.cost_cny_per_1m).toBe(0.15);
        expect(input).toEqual(before);
    });

    it('counts identical prices as unchanged without adding another version', () => {
        const input = rounded(0.5 * CHAT_FX * 0.2);
        const plan = buildNewApiSyncPlan(
            state({ prices: [price({ input_cny_per_1m: input, output_cny_per_1m: rounded(input * 4) })] }),
            source(),
            NOW,
        );
        expect(plan.prices).toEqual([]);
        expect(plan.unchanged.prices).toBe(1);
    });

    it('does not default missing CompletionRatio into an apparently valid catalog price', () => {
        const upstream = source();
        upstream.prices.completionRatio = '{}';
        const plan = buildNewApiSyncPlan(state(), upstream, NOW);
        expect(plan.prices).toHaveLength(0);
        expect(plan.items.find((row) => row.kind === 'price')).toMatchObject({
            change: 'missing',
            selectable: false,
            defaultSelected: false,
        });
        expect(plan.items.find((row) => row.kind === 'price')?.notes.join(' ')).toContain('CompletionRatio');
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
        const row = plan.items.find((item) => item.kind === 'price');
        expect(row).toMatchObject({ selectable: false, defaultSelected: false });
        expect(row?.notes.join(' ')).toContain('未来生效价格');
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

    it('does not invent the initial price for a fixed SKU missing its protected catalog price', () => {
        const slug = 'gpt-image-2-1k';
        const image = model({
            slug,
            modality: 'image',
            upstream_map: { [TIER]: { channel_id: 6, upstream_model: slug } },
        });
        const upstream = source({ channels: [channel({ models: [slug] })] });
        upstream.prices.modelPrice = { [slug]: 10 };
        const plan = buildNewApiSyncPlan(state({ models: [image] }), upstream, NOW);
        expect(plan.prices).toEqual([]);
        expect(plan.items.find((row) => row.kind === 'price')?.notes.join(' ')).toContain('固定图片规格');
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

    it('flags token-priced images instead of turning them into fixed-price images', () => {
        const upstream = source({ channels: [channel({ models: ['gpt-image-2'] })] });
        upstream.prices.modelRatio = { 'gpt-image-2': 2.5 };
        upstream.prices.completionRatio = { 'gpt-image-2': 6 };
        const plan = buildNewApiSyncPlan(state({ models: [] }), upstream, NOW);
        expect(plan.prices).toEqual([]);
        expect(plan.items.find((row) => row.kind === 'price')?.notes.join(' ')).toContain('计费方式无法');
    });

    it('flags per-request chat models instead of presenting a misleading per-image price', () => {
        const upstream = source();
        upstream.prices.modelPrice = { [MODEL]: 0.12 };
        const plan = buildNewApiSyncPlan(state(), upstream, NOW);
        expect(plan.prices).toEqual([]);
        expect(plan.items.find((row) => row.kind === 'price')?.notes.join(' ')).toContain('计费方式无法');
    });
});

describe('buildNewApiSyncPlan group/model candidates', () => {
    it('creates new groups and models as disabled candidates with explicit activation options', () => {
        const plan = buildNewApiSyncPlan(state({ groups: [], models: [] }), source(), NOW);
        expect(plan.groups).toHaveLength(1);
        expect(plan.groups[0].next).toMatchObject({ enabled: false, is_default: false, newapi_channel_ids: [6] });
        expect(plan.groups[0].next.key).toMatch(/^[a-z0-9-]+$/);
        expect(plan.groups[0].item).toMatchObject({ canActivate: true, defaultSelected: true });
        expect(plan.models[0].next.enabled).toBe(false);
        expect(plan.models[0].item).toMatchObject({ canActivate: true, defaultSelected: true });
        expect(plan.models[0].item.dependsOn).toContain(plan.groups[0].item.id);
        expect(plan.prices[0].item.dependsOn).toEqual(
            expect.arrayContaining([plan.groups[0].item.id, plan.models[0].item.id]),
        );
    });

    it('does not reactivate disabled existing groups or models when metadata is unchanged', () => {
        const plan = buildNewApiSyncPlan(
            state({ groups: [group({ enabled: false, is_default: false })], models: [model({ enabled: false })] }),
            source(),
            NOW,
        );
        expect(plan.groups[0].next.enabled).toBe(false);
        expect(plan.groups[0].item).toMatchObject({ canActivate: true, defaultSelected: false });
        expect(plan.models[0].next.enabled).toBe(false);
        expect(plan.models[0].item).toMatchObject({ canActivate: true, defaultSelected: false });
    });

    it('does not offer activation for an unpublished model that still has no upstream mapping', () => {
        const plan = buildNewApiSyncPlan(
            state({ models: [model({ slug: 'orphaned-model', enabled: false, upstream_map: {} })] }),
            source({ channels: [channel({ models: [] })] }),
            NOW,
        );
        expect(plan.models).toEqual([]);
        const orphan = plan.items.find((row) => row.kind === 'model');
        expect(orphan).toMatchObject({
            change: 'unavailable',
            selectable: false,
            defaultSelected: false,
            canActivate: false,
        });
        expect(orphan?.notes.join(' ')).toContain('没有可用渠道映射');
    });

    it('can fill a missing price for an unchanged unpublished model without selecting a model write', () => {
        const plan = buildNewApiSyncPlan(state({ models: [model({ enabled: false })] }), source(), NOW);
        expect(plan.models[0].current?.upstream_map).toEqual(plan.models[0].next.upstream_map);
        expect(plan.models[0].item).toMatchObject({ defaultSelected: false, canActivate: true });
        expect(plan.prices).toHaveLength(1);
        expect(plan.prices[0].item).toMatchObject({ selectable: true, defaultSelected: true, dependsOn: [] });
        expect(plan.models[0].next.enabled).toBe(false);
    });

    it('keeps legacy Chinese tier keys and existing display metadata unchanged', () => {
        const input = state({
            groups: [group({ display_name: '运营自定义名称' })],
            models: [model({ display_name: '自定义模型名', vendor: 'custom-vendor' })],
        });
        const plan = buildNewApiSyncPlan(input, source({ channels: [channel({ id: 14 })] }), NOW);
        expect(plan.groups[0].next).toMatchObject({ key: TIER, display_name: '运营自定义名称' });
        expect(plan.models[0].next).toMatchObject({ display_name: '自定义模型名', vendor: 'custom-vendor' });
        expect(Object.keys(plan.models[0].next.upstream_map)).toEqual([TIER]);
    });

    it('does not automatically choose among multiple source groups for an unregistered channel', () => {
        const upstream = source({
            groups: { first: '第一档', second: '第二档' },
            channels: [channel({ groups: ['first', 'second'] })],
        });
        const plan = buildNewApiSyncPlan(state({ groups: [], models: [] }), upstream, NOW);
        expect(plan.warnings.join(' ')).toContain('归属不明确');
        expect(plan.models).toHaveLength(0);
        expect(plan.groups.every((change) => !change.next.enabled && change.next.newapi_channel_ids.length === 0)).toBe(
            true,
        );
        expect(plan.groups.every((change) => !change.item.canActivate)).toBe(true);
    });

    it('respects an existing unique owner when a channel advertises multiple source groups', () => {
        const upstream = source({
            groups: { [GROUP]: '特惠', extra: '另一个档' },
            channels: [channel({ groups: [GROUP, 'extra'] })],
        });
        const plan = buildNewApiSyncPlan(state(), upstream, NOW);
        expect(plan.warnings).toEqual([]);
        expect(plan.groups.find((change) => change.next.newapi_group === 'extra')?.next.newapi_channel_ids).toEqual([]);
        expect(plan.models).toHaveLength(0);
        expect(plan.prices[0].tier).toBe(TIER);
    });

    it('does not auto-assign a registered channel when its upstream group has changed', () => {
        const upstream = source({
            groups: { [GROUP]: '特惠', changed: '改组' },
            channels: [channel({ groups: ['changed'] })],
        });
        const plan = buildNewApiSyncPlan(state(), upstream, NOW);
        expect(plan.warnings.join(' ')).toContain('分组已改变');
        expect(plan.models).toEqual([]);
        expect(plan.groups.some((change) => change.current?.key === TIER)).toBe(false);
        expect(plan.items.find((row) => row.kind === 'group' && row.title === '特惠')).toMatchObject({
            change: 'unavailable',
            selectable: false,
        });
    });

    it('does not choose between two equally valid replacement channels for one model', () => {
        const upstream = source({ channels: [channel({ id: 13 }), channel({ id: 14 })] });
        const plan = buildNewApiSyncPlan(state(), upstream, NOW);
        expect(plan.groups[0].item).toMatchObject({ selectable: false, defaultSelected: false });
        expect(plan.models).toEqual([]);
        const unavailable = plan.items.find((row) => row.kind === 'model');
        expect(unavailable).toMatchObject({ selectable: false, change: 'unavailable' });
        expect(unavailable?.notes.join(' ')).toContain('多个替换渠道');
    });

    it('does not attach an inactive new tier to an already published model', () => {
        const upstream = source({
            groups: { [GROUP]: '特惠', newgroup: '新档' },
            channels: [channel(), channel({ id: 13, groups: ['newgroup'] })],
        });
        const plan = buildNewApiSyncPlan(state(), upstream, NOW);
        expect(plan.groups[0].next.enabled).toBe(false);
        expect(plan.models).toEqual([]);
        expect(plan.prices.every((change) => change.tier === TIER)).toBe(true);
    });

    it('creates separate ASCII candidate keys for different Chinese names without renaming the legacy key', () => {
        const upstream = source({
            groups: { [GROUP]: '特惠', 外接一: '外接一', 外接二: '外接二' },
            channels: [
                channel(),
                channel({ id: 13, groups: ['外接一'], models: [] }),
                channel({ id: 14, groups: ['外接二'], models: [] }),
            ],
        });
        const plan = buildNewApiSyncPlan(state(), upstream, NOW);
        const keys = plan.groups.map((change) => change.next.key);
        expect(keys).toHaveLength(2);
        expect(new Set(keys).size).toBe(2);
        expect(keys.every((key) => /^[a-z0-9-]+$/.test(key))).toBe(true);
        expect(plan.groups.every((change) => change.current === null)).toBe(true);
    });
});

describe('buildNewApiSyncPlan replacement safety', () => {
    it('requires registry and model mapping replacement together', () => {
        const input = state();
        const before = structuredClone(input);
        const plan = buildNewApiSyncPlan(input, source({ channels: [channel({ id: 14 })] }), NOW);
        expect(plan.groups[0].next.newapi_channel_ids).toEqual([14]);
        expect(plan.models[0].next.upstream_map[TIER]).toEqual({ channel_id: 14, upstream_model: MODEL });
        expect(plan.groups[0].item.dependsOn).toContain(plan.models[0].item.id);
        expect(plan.models[0].item.dependsOn).toContain(plan.groups[0].item.id);
        expect(plan.groups[0].item.selectable).toBe(true);
        expect(plan.models[0].item.selectable).toBe(true);
        expect(input).toEqual(before);
    });

    it('migrates disabled models too, preserving the custom upstream alias and publication status', () => {
        const alias = 'claude-legacy-name';
        const input = state({
            models: [
                model(),
                model({
                    id: 'disabled',
                    slug: 'friendly-name',
                    enabled: false,
                    upstream_map: { [TIER]: { channel_id: 6, upstream_model: alias } },
                }),
            ],
        });
        const plan = buildNewApiSyncPlan(
            input,
            source({ channels: [channel({ id: 14, models: [MODEL, alias] })] }),
            NOW,
        );
        const disabled = plan.models.find((change) => change.next.id === 'disabled');
        expect(disabled?.next).toMatchObject({
            enabled: false,
            upstream_map: { [TIER]: { channel_id: 14, upstream_model: alias } },
        });
        expect(plan.groups[0].item.dependsOn).toContain(disabled?.item.id);
    });

    it('blocks a registry replacement when even an unpublished model has no compatible replacement', () => {
        const input = state({
            models: [
                model(),
                model({
                    id: 'disabled',
                    slug: 'old-model',
                    enabled: false,
                    upstream_map: { [TIER]: { channel_id: 6, upstream_model: 'old-model' } },
                }),
            ],
        });
        const plan = buildNewApiSyncPlan(input, source({ channels: [channel({ id: 14 })] }), NOW);
        expect(plan.groups[0].item).toMatchObject({ selectable: false, defaultSelected: false });
        expect(plan.groups[0].item.notes.join(' ')).toContain('无法迁移');
        expect(plan.models.find((change) => change.next.slug === MODEL)?.item).toMatchObject({
            selectable: false,
            defaultSelected: false,
        });
        expect(plan.prices.every((change) => !change.item.selectable)).toBe(true);
    });

    it.each(['deleted', 'disabled', 'model-removed'] as const)(
        'reports a %s source without deleting catalog models, mappings, groups, or price history',
        (failure) => {
            const input = state({ prices: [price()] });
            const before = structuredClone(input);
            const upstream = source({
                channels:
                    failure === 'deleted' ? [] : [channel(failure === 'disabled' ? { status: 2 } : { models: [] })],
            });
            const plan = buildNewApiSyncPlan(input, upstream, NOW);
            expect(plan.models).toEqual([]);
            expect(plan.prices).toEqual([]);
            expect(plan.groups).toEqual([]);
            expect(plan.items.find((row) => row.kind === 'model')).toMatchObject({
                change: 'unavailable',
                selectable: false,
                defaultSelected: false,
            });
            expect(input).toEqual(before);
        },
    );

    it('blocks ambiguous duplicate Portal owners instead of guessing one', () => {
        const input = state({ groups: [group(), group({ id: 'duplicate', key: 'other', is_default: false })] });
        const plan = buildNewApiSyncPlan(input, source(), NOW);
        expect(plan.groups).toEqual([]);
        expect(plan.models).toEqual([]);
        expect(plan.prices).toEqual([]);
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
