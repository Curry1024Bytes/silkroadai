import { describe, expect, it } from 'vitest';
import {
    buildModelPublishPlan,
    redactModelPublishPlan,
    type ModelPublishChannel,
    type ModelPublishGroup,
    type ModelPublishModel,
} from '../model-publish';

const groups: ModelPublishGroup[] = [
    { key: 'cheap', enabled: true, newapi_channel_ids: [10], newapi_group: 'cheap-group', is_default: true },
    { key: 'official', enabled: true, newapi_channel_ids: [20], newapi_group: 'official-group', is_default: false },
];

function channel(id: number, overrides: Partial<ModelPublishChannel> = {}): ModelPublishChannel {
    return { id, name: `channel-${id}`, models: 'legacy-model', model_mapping: JSON.stringify({}), ...overrides };
}

function model(overrides: Partial<ModelPublishModel> = {}): ModelPublishModel {
    return {
        slug: 'portal-gpt',
        enabled: true,
        upstream_map: { cheap: { channel_id: 10, upstream_model: 'vendor-gpt' } },
        ...overrides,
    };
}

describe('buildModelPublishPlan', () => {
    it('adds a Portal alias and mapping while preserving unrelated channel fields', () => {
        const original = channel(10, {
            models: 'legacy-model',
            model_mapping: JSON.stringify({ legacy: 'upstream-legacy' }),
            secret_key: 'keep',
        });
        const plan = buildModelPublishPlan({ models: [model()], groups, channels: [original] });
        expect(plan.blocked).toBe(false);
        expect(plan.changed_channels).toBe(1);
        expect(plan.channels[0].next).toMatchObject({
            id: 10,
            models: 'legacy-model,portal-gpt',
            model_mapping: JSON.stringify({ legacy: 'upstream-legacy', 'portal-gpt': 'vendor-gpt' }),
            secret_key: 'keep',
        });
    });

    it('preserves array-shaped new-api model fields as arrays', () => {
        const plan = buildModelPublishPlan({
            models: [model()],
            groups,
            channels: [channel(10, { models: ['legacy-model'], model_mapping: {} })],
        });
        expect(plan.blocked).toBe(false);
        expect(plan.channels[0].next.models).toEqual(['legacy-model', 'portal-gpt']);
        expect(plan.channels[0].next.model_mapping).toEqual({ 'portal-gpt': 'vendor-gpt' });
    });

    it('publishes the same Portal model to multiple channels through different tiers', () => {
        const plan = buildModelPublishPlan({
            models: [
                model({
                    upstream_map: {
                        cheap: { channel_id: 10, upstream_model: 'cheap-gpt' },
                        official: { channel_id: 20, upstream_model: 'official-gpt' },
                    },
                }),
            ],
            groups,
            channels: [channel(10), channel(20)],
        });
        expect(plan.blocked).toBe(false);
        expect(plan.channels.map((item) => item.next.model_mapping)).toEqual([
            JSON.stringify({ 'portal-gpt': 'cheap-gpt' }),
            JSON.stringify({ 'portal-gpt': 'official-gpt' }),
        ]);
    });

    it('fans out one tier mapping to every registered channel in that tier', () => {
        const fanoutGroups: ModelPublishGroup[] = [
            {
                key: 'cheap',
                enabled: true,
                newapi_channel_ids: [10, 11],
                newapi_group: 'cheap-group',
                is_default: true,
            },
        ];
        const plan = buildModelPublishPlan({
            models: [model({ upstream_map: { cheap: { channel_id: 10, upstream_model: 'cheap-gpt' } } })],
            groups: fanoutGroups,
            channels: [channel(10), channel(11)],
        });
        expect(plan.blocked).toBe(false);
        expect(plan.channels.map((item) => item.next.model_mapping)).toEqual([
            JSON.stringify({ 'portal-gpt': 'cheap-gpt' }),
            JSON.stringify({ 'portal-gpt': 'cheap-gpt' }),
        ]);
    });

    it('is idempotent when channels already match the Portal catalog', () => {
        const current = channel(10, {
            models: 'legacy-model,portal-gpt',
            model_mapping: JSON.stringify({ 'portal-gpt': 'vendor-gpt' }),
        });
        const plan = buildModelPublishPlan({ models: [model()], groups, channels: [current] });
        expect(plan.blocked).toBe(false);
        expect(plan.changed_channels).toBe(0);
        expect(plan.unchanged_channels).toBe(1);
    });

    it.each([null, ''])('treats an empty new-api mapping field (%s) as an empty mapping', (model_mapping) => {
        const plan = buildModelPublishPlan({
            models: [model()],
            groups,
            channels: [channel(10, { models: '', model_mapping })],
        });
        expect(plan.blocked).toBe(false);
        expect(plan.channels[0].next).toMatchObject({
            models: 'portal-gpt',
            model_mapping: JSON.stringify({ 'portal-gpt': 'vendor-gpt' }),
        });
    });

    it('previews an existing mapping update and applies the Portal mapping as source of truth', () => {
        const plan = buildModelPublishPlan({
            models: [model()],
            groups,
            channels: [
                channel(10, {
                    models: 'portal-gpt',
                    model_mapping: JSON.stringify({ 'portal-gpt': 'other-upstream' }),
                }),
            ],
        });
        expect(plan.blocked).toBe(false);
        expect(plan.channels[0].changed_mappings).toEqual({
            'portal-gpt': { from: 'other-upstream', to: 'vendor-gpt' },
        });
        expect(plan.channels[0].next.model_mapping).toBe(JSON.stringify({ 'portal-gpt': 'vendor-gpt' }));
    });

    it('preserves disabled Portal aliases and unrelated channel models and mappings', () => {
        const plan = buildModelPublishPlan({
            models: [model({ enabled: false })],
            groups,
            channels: [
                channel(10, {
                    models: 'legacy-model,portal-gpt',
                    model_mapping: JSON.stringify({ legacy: 'upstream-legacy', 'portal-gpt': 'vendor-gpt' }),
                }),
            ],
        });
        expect(plan.blocked).toBe(false);
        expect(plan.channels[0].changed).toBe(false);
        expect(plan.channels[0].next.models).toBe('legacy-model,portal-gpt');
        expect(plan.channels[0].next.model_mapping).toBe(
            JSON.stringify({ legacy: 'upstream-legacy', 'portal-gpt': 'vendor-gpt' }),
        );
        expect(plan.channels[0].removed_models).toEqual([]);
        expect(plan.channels[0].removed_mappings).toEqual({});
    });

    it('does not remove the same slug from channels that are outside its Portal mapping', () => {
        const unrelated = channel(20, {
            models: 'legacy-model,portal-gpt',
            model_mapping: JSON.stringify({ 'portal-gpt': 'independently-managed' }),
        });
        const plan = buildModelPublishPlan({
            models: [model({ enabled: false })],
            groups,
            channels: [channel(10), unrelated],
        });
        expect(plan.blocked).toBe(false);
        expect(plan.channels[1].changed).toBe(false);
        expect(plan.channels[1].next).toEqual(unrelated);
    });

    it('blocks invalid topology and missing channels before any write', () => {
        const plan = buildModelPublishPlan({
            models: [model({ upstream_map: { missing: { channel_id: 999, upstream_model: 'x' } } })],
            groups,
            channels: [channel(10)],
        });
        expect(plan.blocked).toBe(true);
        expect(plan.issues).toEqual([{ code: 'unknown_tier', tier: 'missing', model: 'portal-gpt' }]);
    });

    it('redacts complete channel objects from a preview payload', () => {
        const plan = buildModelPublishPlan({
            models: [model()],
            groups,
            channels: [channel(10, { key: 'secret-value' })],
        });
        const preview = redactModelPublishPlan(plan);
        expect(preview.channels[0]).not.toHaveProperty('next');
        expect(JSON.stringify(preview)).not.toContain('secret-value');
    });

    it('blocks malformed channel fields instead of silently clearing them', () => {
        const plan = buildModelPublishPlan({
            models: [model()],
            groups,
            channels: [channel(10, { models: undefined, model_mapping: JSON.stringify({ bad: 1 }) })],
        });
        expect(plan.blocked).toBe(true);
        expect(plan.issues).toEqual([
            { code: 'invalid_channel_models', channel_id: 10 },
            { code: 'invalid_channel_mapping', channel_id: 10 },
        ]);
        expect(plan.channels[0].changed).toBe(false);
    });

    it('blocks malformed upstream map entries before channel planning', () => {
        const plan = buildModelPublishPlan({
            models: [model({ upstream_map: { cheap: null } })],
            groups,
            channels: [channel(10)],
        });
        expect(plan.blocked).toBe(true);
        expect(plan.issues).toContainEqual({ code: 'invalid_upstream_map', model: 'portal-gpt', tier: 'cheap' });
    });

    it('blocks publication when there are no active tiers so stale aliases cannot be cleared', () => {
        const plan = buildModelPublishPlan({
            models: [model({ enabled: false })],
            groups: [],
            channels: [
                channel(10, {
                    models: 'legacy-model,portal-gpt',
                    model_mapping: JSON.stringify({ 'portal-gpt': 'vendor-gpt' }),
                }),
            ],
        });
        expect(plan.blocked).toBe(true);
        expect(plan.issues).toContainEqual({ code: 'no_active_groups' });
        expect(plan.channels[0].removed_models).toEqual([]);
    });
});
