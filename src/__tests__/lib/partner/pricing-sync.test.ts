import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPriceFindMany = vi.fn();
const mockGroupFindMany = vi.fn();
const mockGetSaleRuleOptions = vi.fn();
const mockPutOption = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        partnerGroupPrice: { findMany: (...a: unknown[]) => mockPriceFindMany(...a) },
        channelGroup: { findMany: (...a: unknown[]) => mockGroupFindMany(...a) },
        tenant: { findMany: vi.fn() },
    },
}));
vi.mock('@/lib/newapi/client', () => ({
    getSaleRuleOptions: (...a: unknown[]) => mockGetSaleRuleOptions(...a),
    putOption: (...a: unknown[]) => mockPutOption(...a),
    NewApiError: class NewApiError extends Error {},
}));
vi.mock('@/lib/newapi/user-tier-multiplier', () => ({
    UserTierMultiplierError: class UserTierMultiplierError extends Error {},
    withOptionSyncLock: (work: () => Promise<unknown>) => work(),
    assertOptionSyncWritable: async () => undefined,
    putJsonOptionWithReadback: (args: { key: string; value: string }) => mockPutOption(args.key, args.value, 30_000),
}));

import { changePartnerPricing, openRetailRatios, planPartnerOptions } from '@/lib/partner/pricing-sync';

const TENANT = '11111111-2222-3333-4444-555555555555';
const GROUP = 'partner-11111111222233334444555555555555';
const SPECIAL = 'group_ratio_setting.group_special_usable_group';
const MIRROR = 'group_ratio_setting.group_group_ratio';

let live: Record<string, string>;

beforeEach(() => {
    vi.clearAllMocks();
    live = {
        GroupRatio: JSON.stringify({ SD官转: 0.1, SD特惠: 0.08, Claude: 0.12 }),
        GroupGroupRatio: JSON.stringify({ vip: { Claude: 0.9 }, 'portal-user-abc': { SD官转: 0.095 } }),
        UserUsableGroups: JSON.stringify({ SD官转: 'SD 官转', SD特惠: 'SD 特惠', Claude: 'Claude' }),
        [SPECIAL]: JSON.stringify({ vip: { '+:Claude': '' } }),
    };
    mockGetSaleRuleOptions.mockImplementation(async () => ({ ...live }));
    mockPutOption.mockImplementation(async (key: string, value: string) => {
        live[key] = value;
    });
    mockPriceFindMany.mockResolvedValue([
        { group_key: 'sd-official', wholesale_ratio: 0.07, retail_ratio: 0.09 },
        { group_key: 'sd-cheap', wholesale_ratio: 0.06, retail_ratio: null },
    ]);
    mockGroupFindMany.mockResolvedValue([
        { key: 'sd-official', newapi_group: 'SD官转' },
        { key: 'sd-cheap', newapi_group: 'SD特惠' },
        { key: 'claude', newapi_group: 'Claude' },
    ]);
});

function unchanged() {
    return changePartnerPricing({
        tenantId: TENANT,
        operation: 'test',
        change: async ({ current }) => ({ next: current, persist: async () => 'ok' }),
    });
}

describe('planPartnerOptions', () => {
    it('rewrites only the partner row and hides every usable group that is not open', () => {
        const plan = planPartnerOptions({
            userGroup: GROUP,
            retail: { SD官转: 0.09 },
            ratios: { vip: { Claude: 0.9 }, [GROUP]: { SD特惠: 0.05 } },
            usableGroups: { SD官转: '', SD特惠: '', Claude: '' },
            special: { vip: { '+:Claude': '' } },
        });
        expect(plan.ratios).toEqual({ vip: { Claude: 0.9 }, [GROUP]: { SD官转: 0.09 } });
        expect(plan.special).toEqual({ vip: { '+:Claude': '' }, [GROUP]: { '-:Claude': '', '-:SD特惠': '' } });
    });

    it('drops the retail row and hides all groups when nothing is open', () => {
        const plan = planPartnerOptions({
            userGroup: GROUP,
            retail: {},
            ratios: { [GROUP]: { SD官转: 0.09 } },
            usableGroups: { SD官转: '', Claude: '' },
            special: {},
        });
        expect(plan.ratios).toEqual({});
        expect(plan.special).toEqual({ [GROUP]: { '-:Claude': '', '-:SD官转': '' } });
    });

    it('opens only priced rows whose platform tier is still enabled', () => {
        const billing = new Map([['sd-official', 'SD官转']]);
        expect(
            openRetailRatios(
                [
                    { group_key: 'sd-official', wholesale_ratio: 0.07, retail_ratio: 0.09 },
                    { group_key: 'sd-cheap', wholesale_ratio: 0.06, retail_ratio: null },
                    { group_key: 'retired', wholesale_ratio: 0.06, retail_ratio: 0.08 },
                ],
                billing,
            ),
        ).toEqual({ SD官转: 0.09 });
    });
});

describe('changePartnerPricing', () => {
    it('writes new-api before persisting Portal state and keeps other rows intact', async () => {
        const order: string[] = [];
        mockPutOption.mockImplementation(async (key: string, value: string) => {
            order.push(`put:${key}`);
            live[key] = value;
        });
        const result = await changePartnerPricing({
            tenantId: TENANT,
            operation: 'test',
            change: async ({ current }) => ({
                next: current.map((row) => (row.group_key === 'sd-cheap' ? { ...row, retail_ratio: 0.07 } : row)),
                persist: async () => {
                    order.push('persist');
                    return 'saved';
                },
            }),
        });
        expect(result).toBe('saved');
        expect(order).toEqual(['put:GroupGroupRatio', `put:${SPECIAL}`, 'persist']);
        expect(JSON.parse(live.GroupGroupRatio)).toEqual({
            vip: { Claude: 0.9 },
            'portal-user-abc': { SD官转: 0.095 },
            [GROUP]: { SD官转: 0.09, SD特惠: 0.07 },
        });
        expect(JSON.parse(live[SPECIAL])).toEqual({ vip: { '+:Claude': '' }, [GROUP]: { '-:Claude': '' } });
    });

    it('restores the original new-api values when the Portal write fails', async () => {
        const before = { ...live };
        await expect(
            changePartnerPricing({
                tenantId: TENANT,
                operation: 'test',
                change: async ({ current }) => ({
                    next: current,
                    persist: async () => {
                        throw new Error('db down');
                    },
                }),
            }),
        ).rejects.toMatchObject({ status: 502 });
        expect(live.GroupGroupRatio).toBe(before.GroupGroupRatio);
        expect(live[SPECIAL]).toBe(before[SPECIAL]);
    });

    it('restores and fails when the final readback does not match', async () => {
        const before = { ...live };
        // new-api 吞掉了可用分组的写入
        mockPutOption.mockImplementation(async (key: string, value: string) => {
            if (key !== SPECIAL) live[key] = value;
        });
        const persist = vi.fn();
        await expect(
            changePartnerPricing({
                tenantId: TENANT,
                operation: 'test',
                change: async ({ current }) => ({ next: current, persist }),
            }),
        ).rejects.toMatchObject({ status: 502 });
        expect(persist).not.toHaveBeenCalled();
        expect(live.GroupGroupRatio).toBe(before.GroupGroupRatio);
    });

    it('skips new-api writes when the partner rows already match', async () => {
        await unchanged();
        mockPutOption.mockClear();
        await expect(unchanged()).resolves.toBe('ok');
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('writes both copies when the dotted GroupGroupRatio row exists', async () => {
        live[MIRROR] = live.GroupGroupRatio;
        await unchanged();
        expect(mockPutOption).toHaveBeenCalledWith(MIRROR, expect.any(String), 30_000);
        expect(JSON.parse(live[MIRROR])).toEqual(JSON.parse(live.GroupGroupRatio));
    });

    it('refuses before any write when the dotted copy diverged', async () => {
        live[MIRROR] = JSON.stringify({ other: { Claude: 1 } });
        await expect(unchanged()).rejects.toMatchObject({ status: 409 });
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('refuses when the partner group collides with a real billing group', async () => {
        live.GroupRatio = JSON.stringify({ SD官转: 0.1, [GROUP]: 1 });
        await expect(unchanged()).rejects.toMatchObject({ status: 409 });
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('does not write or persist when the change is rejected', async () => {
        const persist = vi.fn();
        await expect(
            changePartnerPricing({
                tenantId: TENANT,
                operation: 'test',
                change: async () => {
                    throw Object.assign(new Error('rejected'), { status: 400 });
                },
            }),
        ).rejects.toThrow('rejected');
        expect(persist).not.toHaveBeenCalled();
        expect(mockPutOption).not.toHaveBeenCalled();
    });
});
