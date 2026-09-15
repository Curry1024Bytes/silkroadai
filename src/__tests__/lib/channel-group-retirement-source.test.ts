import { beforeEach, describe, expect, it, vi } from 'vitest';

const channels = vi.fn();
const options = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    listChannelsForCatalogSync: (...args: unknown[]) => channels(...args),
    getCatalogSyncOptions: (...args: unknown[]) => options(...args),
}));
import { readChannelGroupRetirementSource } from '@/lib/admin/channel-group-retirement-source';

beforeEach(() => {
    vi.clearAllMocks();
    channels.mockResolvedValue([]);
    options.mockResolvedValue({ UserUsableGroups: '{}', GroupRatio: '{}' });
});

describe('group retirement upstream evidence', () => {
    it('accepts explicitly empty dictionaries and a complete empty channel list', async () => {
        const result = await readChannelGroupRetirementSource('old');
        expect(result.upstream.status).toBe('missing');
        expect(channels).toHaveBeenCalledExactlyOnceWith();
        expect(options).toHaveBeenCalledExactlyOnceWith();
    });

    it.each([
        { UserUsableGroups: '{"old":"Old"}', GroupRatio: '{}' },
        { UserUsableGroups: '{"old":"@hidden"}', GroupRatio: '{}' },
        { UserUsableGroups: {}, GroupRatio: { old: 0 } },
    ])('recognizes membership in either dictionary, including hidden labels and zero ratios', async (maps) => {
        options.mockResolvedValue(maps);
        expect((await readChannelGroupRetirementSource('old')).upstream.status).toBe('present');
    });

    it('uses complete channel membership, including disabled channels beyond the first 100', async () => {
        channels.mockResolvedValue(
            Array.from({ length: 101 }, (_, i) => ({
                id: i + 1,
                group: i === 100 ? 'other, old ' : 'other',
                status: 2,
                key: 'UPSTREAM-SECRET',
            })),
        );
        const result = await readChannelGroupRetirementSource('old');
        expect(result.upstream.status).toBe('present');
        expect(result.evidence.channels).toHaveLength(101);
        expect(JSON.stringify(result)).not.toContain('UPSTREAM-SECRET');
        expect(result.evidence.channels?.[0]).not.toHaveProperty('status');
    });

    it.each([
        { UserUsableGroups: null, GroupRatio: '{}' },
        { GroupRatio: '{}' },
        { UserUsableGroups: '[]', GroupRatio: '{}' },
        { UserUsableGroups: 'broken-json', GroupRatio: '{}' },
        { UserUsableGroups: '{}', GroupRatio: null },
        { UserUsableGroups: '{}', GroupRatio: '{"other":-1}' },
        { UserUsableGroups: '{"other":5}', GroupRatio: '{}' },
    ])('does not infer deletion from absent or malformed dictionaries', async (maps) => {
        options.mockResolvedValue(maps);
        expect((await readChannelGroupRetirementSource('old')).upstream.status).toBe('unknown');
    });

    it.each(['channels', 'options', 'both'])(
        'handles a %s failure without leaking details or claiming deletion',
        async (which) => {
            if (which !== 'options') channels.mockRejectedValue(new Error('SECRET-CHANNEL-ERROR'));
            if (which !== 'channels') options.mockRejectedValue(new Error('SECRET-OPTION-ERROR'));
            const result = await readChannelGroupRetirementSource('old');
            expect(result.upstream.status).toBe('unknown');
            expect(JSON.stringify(result)).not.toContain('SECRET');
        },
    );

    it('keeps confirmed presence even if another source is unavailable', async () => {
        channels.mockRejectedValue(new Error('offline'));
        options.mockResolvedValue({ UserUsableGroups: { old: '@hidden' }, GroupRatio: null });
        expect((await readChannelGroupRetirementSource('old')).upstream.status).toBe('present');
    });

    it.each([
        { rows: [{ id: 1 }] },
        { rows: [{ id: 1, group: null }] },
        {
            rows: [
                { id: 1, group: 'x' },
                { id: 1, group: 'y' },
            ],
        },
        { rows: null },
    ])('treats incomplete or repeated channel metadata as unknown', async ({ rows }) => {
        channels.mockResolvedValue(rows);
        expect((await readChannelGroupRetirementSource('old')).upstream.status).toBe('unknown');
    });
});
