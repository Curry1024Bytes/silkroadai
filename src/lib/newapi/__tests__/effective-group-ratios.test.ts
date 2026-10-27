import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUsableGroups = vi.fn();
vi.mock('../client', () => ({
    getPricingGroupRatiosForCustomer: (...a: unknown[]) => mockGetUsableGroups(...a),
}));
const mockGetGroupRatios = vi.fn();
vi.mock('@/lib/channel-group', () => ({
    getGroupRatios: (...a: unknown[]) => mockGetGroupRatios(...a),
}));

import { _resetEffectiveRatioCache, getEffectiveGroupRatios, ratioScale } from '../effective-group-ratios';

const GLOBAL = { default: 1.3, 'pool-gpt': 0.4, 'pool-claude': 1.6, 'Claude 企业': 1.8 };
const USER = { newapi_user_id: 816, newapi_access_token: 'cust-token' };

beforeEach(() => {
    vi.clearAllMocks();
    _resetEffectiveRatioCache();
    mockGetGroupRatios.mockResolvedValue({ ...GLOBAL });
});

describe('getEffectiveGroupRatios', () => {
    it('anonymous / unprovisioned → global ratios, no special tiers, never calls new-api as a user', async () => {
        for (const u of [null, { newapi_user_id: null, newapi_access_token: null }]) {
            const eff = await getEffectiveGroupRatios(u);
            expect(eff.source).toBe('global');
            expect(eff.ratios).toEqual(GLOBAL);
            expect(eff.special.size).toBe(0);
        }
        expect(mockGetUsableGroups).not.toHaveBeenCalled();
    });

    it('customer with a GroupGroupRatio override → effective ratio differs, tier flagged special, others fall back to global', async () => {
        // /api/pricing 的 group_ratio:服务端已套矩阵(auto 不在其中)
        mockGetUsableGroups.mockResolvedValue({ default: 1.3, 'pool-gpt': 0.25 }); // 专属 0.25(挂牌 0.4)
        const eff = await getEffectiveGroupRatios(USER);
        expect(mockGetUsableGroups).toHaveBeenCalledWith({ accessToken: 'cust-token', userId: 816 });
        expect(eff.source).toBe('customer');
        expect(eff.ratios['pool-gpt']).toBe(0.25);
        expect(eff.ratios['pool-claude']).toBe(1.6); // 客户视角缺的组 → 全局兜底
        expect([...eff.special]).toEqual(['pool-gpt']);
        expect(eff.listRatios['pool-gpt']).toBe(0.4);
        expect(ratioScale(eff, 'pool-gpt')).toBeCloseTo(0.625);
        expect(ratioScale(eff, 'pool-claude')).toBe(1);
        expect(ratioScale(eff, 'nonexistent')).toBe(1);
    });

    it('caches per newapi user for 60s', async () => {
        mockGetUsableGroups.mockResolvedValue({ default: 1.3 });
        await getEffectiveGroupRatios(USER, 1_000_000);
        await getEffectiveGroupRatios(USER, 1_000_000 + 30_000);
        expect(mockGetUsableGroups).toHaveBeenCalledTimes(1);
        await getEffectiveGroupRatios(USER, 1_000_000 + 61_000);
        expect(mockGetUsableGroups).toHaveBeenCalledTimes(2);
        await getEffectiveGroupRatios({ ...USER, newapi_user_id: 817 }, 1_000_000 + 61_000);
        expect(mockGetUsableGroups).toHaveBeenCalledTimes(3);
    });

    it('new-api failure → global ratios (never throws); stale cache preferred when present', async () => {
        mockGetUsableGroups.mockRejectedValueOnce(new Error('503'));
        const eff = await getEffectiveGroupRatios(USER, 0);
        expect(eff.source).toBe('global');
        expect(eff.ratios).toEqual(GLOBAL);

        mockGetUsableGroups.mockResolvedValueOnce({ 'pool-gpt': 0.25 });
        await getEffectiveGroupRatios(USER, 1_000);
        mockGetUsableGroups.mockRejectedValueOnce(new Error('503 again'));
        const stale = await getEffectiveGroupRatios(USER, 1_000 + 120_000);
        expect(stale.source).toBe('customer');
        expect(stale.ratios['pool-gpt']).toBe(0.25);
    });
});
