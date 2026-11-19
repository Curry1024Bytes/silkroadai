import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    options: vi.fn(),
    channels: vi.fn(),
    guard: vi.fn(),
    transaction: vi.fn(),
    groups: { findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    models: { findMany: vi.fn(), update: vi.fn() },
    internal: { findMany: vi.fn(), updateMany: vi.fn() },
    channel: vi.fn(),
    channelStatus: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        channelGroup: m.groups,
        catalogModel: m.models,
        customerModelBillingGroup: m.internal,
        $transaction: m.transaction,
    },
}));
vi.mock('@/lib/newapi/client', () => ({
    getCatalogSyncOptions: m.options,
    listChannelsForCatalogSync: m.channels,
    getChannelStrict: m.channel,
    setChannelStatusStrict: m.channelStatus,
}));
vi.mock('@/lib/admin/pricing-publish-lock', () => ({ assertPricingCatalogWritable: m.guard }));
import {
    readGroupMirrorSource,
    planGroupMirror,
    reconcileMirroredMap,
    mirrorChannelGroups,
    __resetGroupMirrorForTests,
} from '@/lib/channel-group-mirror';
import { ChannelGroupTopology } from '@/lib/channel-group-topology';
import { mirrorsNewApiGroups } from '@/lib/channel-group-source';

const row = (extra = {}) => ({
    id: 'g1',
    key: 'stable-key',
    newapi_group: 'GPT特惠反代',
    display_name: '旧名字',
    enabled: true,
    is_default: true,
    newapi_channel_ids: [2],
    tier_level: 0,
    upstream_present: true,
    upstream_synced_at: null,
    ...extra,
});
const source = { groups: [{ name: 'GPT特惠反代', label: 'GPT特惠反代', selectable: true, channels: [2] }] };

beforeEach(() => {
    vi.clearAllMocks();
    __resetGroupMirrorForTests();
    m.options.mockResolvedValue({
        UserUsableGroups: '{"GPT特惠反代":"GPT特惠反代"}',
        GroupRatio: '{"GPT特惠反代":0.12}',
    });
    m.channels.mockResolvedValue([{ id: 2, group: 'GPT特惠反代', status: 1 }]);
    m.groups.findMany.mockResolvedValue([row()]);
    m.models.findMany.mockResolvedValue([]);
    m.internal.findMany.mockResolvedValue([]);
    m.internal.updateMany.mockResolvedValue({ count: 1 });
    m.channelStatus.mockResolvedValue(undefined);
    m.guard.mockResolvedValue(undefined);
    m.transaction.mockImplementation(async (fn) => fn({ channelGroup: m.groups, catalogModel: m.models }));
});
afterEach(() => vi.unstubAllEnvs());

describe('authoritative new-api group mirror', () => {
    it.each([
        { status: 2, models: 'model-a', group: 'GPT特惠反代' },
        { status: 1, models: 'another-model', group: 'GPT特惠反代' },
        { status: 1, models: 'model-a', group: 'other-group' },
    ])('pauses registered replicas when their source changes: %j', async (changed) => {
        m.groups.findMany.mockResolvedValue([row({ display_name: 'GPT特惠反代', upstream_synced_at: new Date() })]);
        m.internal.findMany.mockResolvedValue([
            {
                id: 'binding',
                status: 'active',
                internal_group: 'internal',
                public_group: 'GPT特惠反代',
                model_name: 'model-a',
                source_channel_ids: [2],
                replica_channel_ids: [99],
            },
        ]);
        m.channels.mockResolvedValue([
            { id: 2, ...changed },
            { id: 99, group: 'internal', models: 'model-a', status: 1 },
        ]);
        m.channel.mockResolvedValue({ id: 99, group: 'internal', status: 1 });
        await mirrorChannelGroups();
        expect(m.channelStatus).toHaveBeenCalledExactlyOnceWith(99, 2);
        expect(m.internal.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ['binding'] }, status: 'active' },
            data: { status: 'stale' },
        });
    });

    it('never disables a public/source channel when a replica registration has drifted', async () => {
        m.internal.findMany.mockResolvedValue([
            {
                id: 'binding',
                status: 'active',
                internal_group: 'internal',
                public_group: 'GPT特惠反代',
                model_name: 'model-a',
                source_channel_ids: [2],
                replica_channel_ids: [99],
            },
        ]);
        m.channels.mockResolvedValue([{ id: 2, group: 'GPT特惠反代', models: 'model-a', status: 2 }]);
        m.channel.mockResolvedValue({ id: 99, group: 'GPT特惠反代', status: 1 });
        await expect(mirrorChannelGroups()).rejects.toThrow('shutdown needs reconciliation');
        expect(m.channelStatus).not.toHaveBeenCalled();
        expect(m.internal.updateMany).toHaveBeenCalled();
    });
    it('excludes only registered internal groups and channel replicas from the public registry', async () => {
        m.internal.findMany.mockResolvedValue([{ internal_group: 'managed-model-a', replica_channel_ids: [12] }]);
        m.options.mockResolvedValue({
            GroupRatio: '{"sale":1,"managed-model-a":1,"portal-model-user-owned":1}',
            UserUsableGroups:
                '{"sale":"Public","managed-model-a":"Internal","portal-model-user-owned":"Another public group"}',
        });
        m.channels.mockResolvedValue([
            { id: 2, group: 'sale', status: 1 },
            { id: 12, group: 'managed-model-a,sale', status: 1 },
            { id: 13, group: 'portal-model-user-owned', status: 1 },
        ]);
        expect((await readGroupMirrorSource()).groups).toEqual([
            { name: 'sale', label: 'Public', selectable: true, channels: [2] },
            { name: 'portal-model-user-owned', label: 'Another public group', selectable: true, channels: [13] },
        ]);
    });
    it('is opt-in and only applies to the platform tenant', () => {
        vi.stubEnv('NEWAPI_GROUP_SYNC_MODE', 'mirror');
        expect(mirrorsNewApiGroups()).toBe(true);
        expect(mirrorsNewApiGroups('partner-1')).toBe(false);
        vi.stubEnv('NEWAPI_GROUP_SYNC_MODE', '');
        expect(mirrorsNewApiGroups()).toBe(false);
    });
    it('reads pricing groups, non-selectable groups and every channel membership including disabled/shared channels', async () => {
        m.options.mockResolvedValue({
            GroupRatio: '{"sale":1,"private":2,"empty":1}',
            UserUsableGroups: '{"sale":"特惠","empty":"空组","hidden":"@内部"}',
        });
        m.channels.mockResolvedValue([
            { id: 2, group: 'sale,private', status: 2 },
            { id: 3, group: 'orphan', status: 1 },
        ]);
        expect((await readGroupMirrorSource()).groups).toEqual([
            { name: 'sale', label: '特惠', selectable: true, channels: [2] },
            { name: 'private', label: 'private', selectable: false, channels: [2] },
            { name: 'empty', label: '空组', selectable: true, channels: [] },
            { name: 'hidden', label: '@内部', selectable: false, channels: [] },
            { name: 'orphan', label: 'orphan', selectable: false, channels: [3] },
        ]);
    });
    it.each([null, 'bad json', '[]', '{"sale":null}', '{"sale":2}'])(
        'rejects incomplete usable groups %s without writes',
        async (raw) => {
            m.options.mockResolvedValue({ GroupRatio: '{}', UserUsableGroups: raw });
            await expect(mirrorChannelGroups()).rejects.toThrow();
            expect(m.transaction).not.toHaveBeenCalled();
        },
    );
    it('refuses an incomplete channel list before archiving anything', async () => {
        m.channels.mockResolvedValue([{ id: 1 }]);
        await expect(mirrorChannelGroups()).rejects.toThrow('Incomplete channel membership');
        expect(m.transaction).not.toHaveBeenCalled();
    });
    it('does not convert a failed paginated read into deletion', async () => {
        m.channels.mockRejectedValue(new Error('Incomplete channel list'));
        await expect(mirrorChannelGroups()).rejects.toThrow();
        expect(m.groups.update).not.toHaveBeenCalled();
    });
    it('preserves the stable key and default while following labels, selectable state and channel changes', () => {
        const before = row({ enabled: false, newapi_channel_ids: [] });
        const plan = planGroupMirror([before], source);
        expect(plan.creates).toEqual([]);
        expect(plan.updates).toEqual([
            {
                row: before,
                data: { display_name: 'GPT特惠反代', enabled: true, newapi_channel_ids: [2], upstream_present: true },
            },
        ]);
        expect(before.key).toBe('stable-key');
        expect(before.is_default).toBe(true);
    });
    it('archives absent seed groups and restores the same key if the group is re-added upstream', () => {
        const old = row({ id: 'old', key: 'pool', newapi_group: 'default', is_default: false });
        const removed = planGroupMirror([old], source);
        expect(removed.updates[0].data).toMatchObject({
            enabled: false,
            upstream_present: false,
            newapi_channel_ids: [],
        });
        const restored = planGroupMirror([{ ...old, ...removed.updates[0].data }], {
            groups: [{ name: 'default', label: '回来', selectable: true, channels: [9] }],
        });
        expect(restored.creates).toEqual([]);
        expect(restored.updates[0].row.key).toBe('pool');
        expect(restored.updates[0].data).toMatchObject({
            enabled: true,
            upstream_present: true,
            newapi_channel_ids: [9],
        });
    });
    it('treats a true group rename as delete+add without silently moving existing keys to the renamed group', () => {
        const plan = planGroupMirror([row()], {
            groups: [{ name: 'renamed', label: 'New', selectable: true, channels: [2] }],
        });
        expect(plan.updates[0].data.upstream_present).toBe(false);
        expect(plan.creates[0].key).not.toBe('stable-key');
    });
    it('accepts a complete empty snapshot and archives all groups', async () => {
        m.options.mockResolvedValue({ GroupRatio: '{}', UserUsableGroups: '{}' });
        m.channels.mockResolvedValue([]);
        await mirrorChannelGroups();
        expect(m.groups.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ enabled: false, upstream_present: false }) }),
        );
    });
    it('prunes invalid active model mappings atomically without changing prices or customer keys', async () => {
        m.models.findMany.mockResolvedValue([
            { id: 'model', upstream_map: { old: { channel_id: 5, upstream_model: 'gpt-x' } } },
        ]);
        await mirrorChannelGroups();
        expect(m.guard).toHaveBeenCalledOnce();
        expect(m.models.update).toHaveBeenCalledWith({
            where: { id: 'model' },
            data: { upstream_map: {}, enabled: false },
        });
        expect(m.transaction).toHaveBeenCalledWith(expect.any(Function), {
            isolationLevel: 'Serializable',
            timeout: 15000,
        });
        expect(m.groups.update.mock.calls[0][0].data).not.toHaveProperty('key');
        expect(m.groups.update.mock.calls[0][0].data).not.toHaveProperty('is_default');
    });
    it('retains valid model metadata when only another tier disappears', () => {
        const keep = { channel_id: 2, upstream_model: 'gpt-x', custom: true };
        expect(reconcileMirroredMap({ 'stable-key': keep, old: { channel_id: 8 } }, [row()])).toEqual({
            'stable-key': keep,
        });
    });
    it('does not claim success or swallow a publication lock', async () => {
        m.guard.mockRejectedValue(new Error('pricing busy'));
        await expect(mirrorChannelGroups()).rejects.toThrow('pricing busy');
        expect(m.groups.update).not.toHaveBeenCalled();
    });
    it('caches success, suppresses failed retries for 60 seconds, and lets an admin refresh retry', async () => {
        await mirrorChannelGroups();
        // A changed snapshot is read again after acquiring the publication lock.
        expect(m.options).toHaveBeenCalledTimes(2);
        await mirrorChannelGroups();
        expect(m.options).toHaveBeenCalledTimes(2);
        __resetGroupMirrorForTests();
        m.options.mockRejectedValue(new Error('offline'));
        await expect(mirrorChannelGroups()).rejects.toThrow();
        await expect(mirrorChannelGroups()).rejects.toThrow('Group mirror unavailable');
        expect(m.options).toHaveBeenCalledTimes(3);
        await expect(mirrorChannelGroups(true)).rejects.toThrow();
        expect(m.options).toHaveBeenCalledTimes(4);
    });
    it('rechecks managed registrations after waiting for the publication lock', async () => {
        m.options.mockResolvedValue({
            GroupRatio: '{"GPT特惠反代":1,"internal":1}',
            UserUsableGroups: '{"GPT特惠反代":"GPT特惠反代"}',
        });
        m.channels.mockResolvedValue([
            { id: 2, group: 'GPT特惠反代' },
            { id: 99, group: 'internal' },
        ]);
        m.internal.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValue([{ internal_group: 'internal', replica_channel_ids: [99] }]);
        await mirrorChannelGroups();
        expect(m.internal.findMany).toHaveBeenCalledTimes(2);
        expect(m.groups.create).not.toHaveBeenCalled();
        expect(m.groups.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ newapi_channel_ids: [2] }) }),
        );
    });
    it('skips writes for unchanged metadata, including during a price publication', async () => {
        m.groups.findMany.mockResolvedValue([row({ display_name: 'GPT特惠反代', upstream_synced_at: new Date() })]);
        await mirrorChannelGroups();
        expect(m.transaction).not.toHaveBeenCalled();
    });
    it('allows verified shared membership but never guesses a tier from a shared channel alone', () => {
        const topology = new ChannelGroupTopology('platform', [
            row({ upstream_synced_at: new Date() }),
            row({ id: 'g2', key: 'other', newapi_group: 'other', is_default: false, upstream_synced_at: new Date() }),
        ]);
        expect(topology.channelOwner.has(2)).toBe(false);
        expect(topology.validateUpstreamMap({ other: { channel_id: 2, upstream_model: 'gpt-x' } })).toEqual([]);
        expect(topology.validateUpstreamMap({ other: { channel_id: 9, upstream_model: 'gpt-x' } })).toHaveLength(1);
    });
    it('keeps manual-tier overlap and empty-channel guardrails', () => {
        expect(
            () =>
                new ChannelGroupTopology('platform', [
                    row(),
                    row({ key: 'other', newapi_group: 'other', is_default: false }),
                ]),
        ).toThrow('belongs to multiple tiers');
        expect(() => new ChannelGroupTopology('platform', [row({ newapi_channel_ids: [] })])).toThrow(
            'no registered channels',
        );
        expect(
            () =>
                new ChannelGroupTopology('platform', [row({ newapi_channel_ids: [], upstream_synced_at: new Date() })]),
        ).not.toThrow();
    });
});
