import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockListChannels = vi.fn();
const mockGetOption = vi.fn();
const mockListEnabledChannelGroups = vi.fn();
const mockPartnerDisplay = vi.fn();

vi.mock('@/lib/newapi/client', () => ({
    listChannels: (...a: unknown[]) => mockListChannels(...a),
    getOption: (...a: unknown[]) => mockGetOption(...a),
}));
vi.mock('@/lib/channel-group', () => ({
    listEnabledChannelGroups: (...a: unknown[]) => mockListEnabledChannelGroups(...a),
}));
vi.mock('@/lib/partner/display-pricing', () => ({
    loadPartnerPriceDisplay: (...a: unknown[]) => mockPartnerDisplay(...a),
}));

import { _resetModelGroupCacheForTest, getModelGroupMap, resolveModelGroup } from '@/lib/chat/model-groups';

const PARTNER = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
    vi.clearAllMocks();
    _resetModelGroupCacheForTest();
    mockListChannels.mockResolvedValue([
        { status: 1, group: 'SD官转,SD特惠', models: 'model-a,model-b' },
    ]);
    mockGetOption.mockResolvedValue(JSON.stringify({ SD官转: 0.1, SD特惠: 0.08 }));
    mockListEnabledChannelGroups.mockResolvedValue([
        { key: 'sd-official', newapi_group: 'SD官转', is_default: true },
        { key: 'sd-cheap', newapi_group: 'SD特惠', is_default: false },
    ]);
    mockPartnerDisplay.mockResolvedValue(null);
});

describe('chat model group map', () => {
    it('platform customers pick the cheapest priced group', async () => {
        const map = await getModelGroupMap(null);
        const info = map.get('model-a');
        expect(info?.group).toBe('SD特惠');
        expect(info?.ratio).toBe(0.08);
        expect(info?.multiplier).toBeCloseTo(0.8);
    });

    it('partner customers only see groups open to them at the retail ratio', async () => {
        mockPartnerDisplay.mockResolvedValue({
            retailByGroup: new Map([['SD官转', 0.09]]),
            openGroups: new Set(['SD官转']),
        });
        const map = await getModelGroupMap(PARTNER);
        expect(map.get('model-a')).toMatchObject({ group: 'SD官转', ratio: 0.09, multiplier: 1 });
        expect(mockPartnerDisplay).toHaveBeenCalledWith(PARTNER);
    });

    it('partner customers with nothing open get an empty map instead of a platform-price fallback', async () => {
        mockPartnerDisplay.mockResolvedValue({ retailByGroup: new Map(), openGroups: new Set() });
        expect((await getModelGroupMap(PARTNER)).size).toBe(0);
        expect(await resolveModelGroup('model-a', PARTNER)).toBeNull();
    });

    it('platform callers never load partner display data', async () => {
        await getModelGroupMap(null);
        expect(mockPartnerDisplay).toHaveBeenCalledWith(null);
    });
});
