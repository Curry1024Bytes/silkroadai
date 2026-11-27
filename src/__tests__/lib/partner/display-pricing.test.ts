import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPriceFindMany = vi.fn();
const mockGroupFindMany = vi.fn();
const mockGetOption = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        partnerGroupPrice: { findMany: (...a: unknown[]) => mockPriceFindMany(...a) },
        channelGroup: { findMany: (...a: unknown[]) => mockGroupFindMany(...a) },
    },
}));
vi.mock('@/lib/newapi/client', () => ({ getOption: (...a: unknown[]) => mockGetOption(...a) }));
vi.mock('@/lib/tenant/resolve', () => ({ resolveTenantByHost: async () => ({ id: 'platform' }) }));

import { loadPartnerPriceDisplay, resolveDisplayTenant } from '@/lib/partner/display-pricing';

const TENANT = '11111111-2222-3333-4444-555555555555';
const PLATFORM = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
    vi.clearAllMocks();
    mockGroupFindMany.mockResolvedValue([
        { key: 'sd-official', newapi_group: 'SD官转' },
        { key: 'sd-cheap', newapi_group: 'SD特惠' },
        { key: 'claude', newapi_group: 'Claude' },
    ]);
    mockGetOption.mockResolvedValue(JSON.stringify({ SD官转: 0.1, SD特惠: 0.08, Claude: 0.12 }));
    mockPriceFindMany.mockResolvedValue([
        { group_key: 'sd-official', retail_ratio: '0.12' },
        { group_key: 'sd-cheap', retail_ratio: null },
    ]);
});

describe('loadPartnerPriceDisplay', () => {
    it('returns null for the platform tenant', async () => {
        expect(await loadPartnerPriceDisplay(PLATFORM)).toBeNull();
        expect(await loadPartnerPriceDisplay(null)).toBeNull();
        expect(mockPriceFindMany).not.toHaveBeenCalled();
    });

    it('scales public prices by retail ÷ public ratio and hides unopened tiers', async () => {
        const display = await loadPartnerPriceDisplay(TENANT);
        expect(display?.scales.get('sd-official')).toBeCloseTo(1.2);
        expect(display?.retail.get('sd-official')).toBe(0.12);
        expect(display?.openTiers).toEqual(new Set(['sd-official']));
        expect(display?.scales.has('sd-cheap')).toBe(false);
        expect(display?.scales.has('claude')).toBe(false);
        // /v1/models 与聊天路由按 new-api 计费分组名查，两份索引必须一致
        expect(display?.scalesByGroup.get('SD官转')).toBeCloseTo(1.2);
        expect(display?.retailByGroup.get('SD官转')).toBe(0.12);
        expect(display?.openGroups).toEqual(new Set(['SD官转']));
    });

    it('excludes tiers whose billing group is missing from new-api GroupRatio', async () => {
        mockGetOption.mockResolvedValue(JSON.stringify({ SD特惠: 0.08 }));
        const display = await loadPartnerPriceDisplay(TENANT);
        expect(display?.openTiers.size).toBe(0);
    });

    it('returns an empty display when the partner has opened nothing', async () => {
        mockPriceFindMany.mockResolvedValue([]);
        const display = await loadPartnerPriceDisplay(TENANT);
        expect(display?.openTiers.size).toBe(0);
        expect(display?.scales.size).toBe(0);
    });
});

describe('resolveDisplayTenant', () => {
    it('prefers the signed-in customer tenant, else resolves the host', async () => {
        expect(await resolveDisplayTenant(TENANT, 'acme.com')).toBe(TENANT);
        expect(await resolveDisplayTenant(null, 'acme.com')).toBe('platform');
    });
});
