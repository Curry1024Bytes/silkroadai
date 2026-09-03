import { describe, expect, it } from 'vitest';
import { ChannelGroupTopology, ChannelGroupTopologyError, type TopologyGroup } from '@/lib/channel-group-topology';

const TENANT = '00000000-0000-0000-0000-000000000001';

function group(over: Partial<TopologyGroup> = {}): TopologyGroup {
    return {
        key: 'sale',
        newapi_group: 'GPT-特惠反代',
        newapi_channel_ids: [6],
        is_default: true,
        enabled: true,
        tier_level: 0,
        ...over,
    };
}

describe('ChannelGroupTopology', () => {
    it('builds one deterministic owner map and default group', () => {
        const topology = new ChannelGroupTopology(TENANT, [
            group(),
            group({ key: 'image', newapi_group: '图片模型', newapi_channel_ids: [12], is_default: false }),
        ]);
        expect(topology.defaultGroup.key).toBe('sale');
        expect(topology.channelOwner.get(6)).toBe('sale');
        expect(topology.channelOwner.get(12)).toBe('image');
    });

    it.each([
        { rows: [], code: 'no_enabled_groups' },
        { rows: [group({ is_default: false })], code: 'invalid_default_count' },
        {
            rows: [
                group(),
                group({ key: 'other', newapi_group: 'other-group', newapi_channel_ids: [6], is_default: false }),
            ],
            code: 'duplicate_channel_owner',
        },
        { rows: [group({ newapi_channel_ids: [] })], code: 'tier_has_no_channels' },
        {
            rows: [group(), group({ key: 'other', newapi_channel_ids: [7], is_default: false })],
            code: 'duplicate_newapi_group',
        },
    ])('rejects an invalid topology: $code', ({ rows, code }) => {
        expect(() => new ChannelGroupTopology(TENANT, rows)).toThrowError(ChannelGroupTopologyError);
        try {
            new ChannelGroupTopology(TENANT, rows);
        } catch (error) {
            expect((error as ChannelGroupTopologyError).issues.some((issue) => issue.code === code)).toBe(true);
        }
    });

    it('validates tier existence and exact channel ownership', () => {
        const topology = new ChannelGroupTopology(TENANT, [
            group(),
            group({ key: 'image', newapi_group: '图片模型', newapi_channel_ids: [12], is_default: false }),
        ]);
        expect(topology.validateUpstreamMap({ sale: { channel_id: 6, upstream_model: 'gpt-5.4' } })).toEqual([]);
        expect(topology.validateUpstreamMap({ ghost: { channel_id: 6, upstream_model: 'gpt-5.4' } })).toContainEqual({
            code: 'unknown_tier',
            tier: 'ghost',
        });
        expect(
            topology.validateUpstreamMap({ sale: { channel_id: 12, upstream_model: 'gpt-image-2' } }),
        ).toContainEqual({ code: 'channel_not_owned_by_tier', tier: 'sale', channel_id: 12, owner: 'image' });
        expect(topology.validateUpstreamMap({})).toEqual([{ code: 'empty_upstream_map' }]);
        expect(topology.validateUpstreamMap({}, { allowEmpty: true })).toEqual([]);
    });
});
