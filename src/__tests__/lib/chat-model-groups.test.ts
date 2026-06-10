/**
 * Chat UI — model→routing-group resolver tests.
 *
 * The resolver joins enabled channels + GroupRatio to pick each model's
 * cheapest serving group (mirrors new-api auto-routing), exposes a price
 * multiplier for the picker badge, ignores disabled channels, falls back to
 * `default` for unknown models, never throws, and caches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockListChannels = vi.fn();
const mockGetOption = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    listChannels: () => mockListChannels(),
    getOption: (k: string) => mockGetOption(k),
}));

import {
    resolveModelGroup,
    getModelGroupMap,
    _resetModelGroupCacheForTest,
    DEFAULT_GROUP,
} from '@/lib/chat/model-groups';

const GROUP_RATIO = JSON.stringify({ default: 1, official: 2.4615, 'official-gpt': 7.2913 });

beforeEach(() => {
    vi.clearAllMocks();
    _resetModelGroupCacheForTest();
    mockGetOption.mockResolvedValue(GROUP_RATIO);
});
afterEach(() => vi.restoreAllMocks());

describe('resolveModelGroup', () => {
    it('routes an official-only model via official; a both-groups model via the cheapest (default)', async () => {
        mockListChannels.mockResolvedValue([
            { id: 1, status: 1, group: 'default', models: 'gpt-5.4,claude-opus-4-8' },
            { id: 18, status: 1, group: 'official', models: 'claude-opus-4-8,claude-fable-5' },
        ]);
        expect(await resolveModelGroup('claude-fable-5')).toBe('official'); // official-exclusive
        expect(await resolveModelGroup('claude-opus-4-8')).toBe('default'); // both → cheapest wins
        expect(await resolveModelGroup('gpt-5.4')).toBe('default');
    });

    it('falls back to the default group for unknown / unmapped models', async () => {
        mockListChannels.mockResolvedValue([{ id: 1, status: 1, group: 'default', models: 'gpt-5.4' }]);
        expect(await resolveModelGroup('does-not-exist')).toBe('default');
    });

    it('ignores disabled channels (status !== 1)', async () => {
        mockListChannels.mockResolvedValue([{ id: 18, status: 0, group: 'official', models: 'claude-fable-5' }]);
        // fable-5 lives only in a DISABLED official channel → unmapped → default
        expect(await resolveModelGroup('claude-fable-5')).toBe(DEFAULT_GROUP);
    });

    it('never throws — listChannels failure resolves to default', async () => {
        mockListChannels.mockRejectedValue(new Error('new-api down'));
        expect(await resolveModelGroup('claude-fable-5')).toBe('default');
    });

    it('caches the map — a second resolve does not re-fetch channels', async () => {
        mockListChannels.mockResolvedValue([{ id: 18, status: 1, group: 'official', models: 'claude-fable-5' }]);
        await resolveModelGroup('claude-fable-5');
        await resolveModelGroup('claude-fable-5');
        expect(mockListChannels).toHaveBeenCalledTimes(1);
    });
});

describe('getModelGroupMap — price multiplier', () => {
    it('reports each model multiplier relative to the default group', async () => {
        mockListChannels.mockResolvedValue([
            { id: 1, status: 1, group: 'default', models: 'gpt-5.4' },
            { id: 18, status: 1, group: 'official', models: 'claude-fable-5' },
            { id: 19, status: 1, group: 'official-gpt', models: 'gpt-pro' },
        ]);
        const map = await getModelGroupMap();
        expect(map.get('gpt-5.4')?.multiplier).toBe(1);
        expect(map.get('claude-fable-5')?.group).toBe('official');
        expect(map.get('claude-fable-5')?.multiplier).toBeCloseTo(2.4615, 3);
        expect(map.get('gpt-pro')?.multiplier).toBeCloseTo(7.2913, 3);
    });
});
