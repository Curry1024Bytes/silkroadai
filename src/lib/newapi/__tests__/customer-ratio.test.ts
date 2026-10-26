import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetOption = vi.fn();
const mockPutOption = vi.fn();
const mockGetUser = vi.fn();
const mockUpdateUser = vi.fn();
const mockPricingRatios = vi.fn();
const mockListTokens = vi.fn();
const mockUpdateToken = vi.fn();
vi.mock('../client', () => ({
    getOption: (...a: unknown[]) => mockGetOption(...a),
    putOption: (...a: unknown[]) => mockPutOption(...a),
    getUser: (...a: unknown[]) => mockGetUser(...a),
    updateUser: (...a: unknown[]) => mockUpdateUser(...a),
    getPricingGroupRatiosForCustomer: (...a: unknown[]) => mockPricingRatios(...a),
    listTokensForCustomer: (...a: unknown[]) => mockListTokens(...a),
    updateTokenForCustomer: (...a: unknown[]) => mockUpdateToken(...a),
}));
const mockGetGroupRatios = vi.fn();
vi.mock('@/lib/channel-group', () => ({ getGroupRatios: (...a: unknown[]) => mockGetGroupRatios(...a) }));
const mockInvalidate = vi.fn();
vi.mock('../effective-group-ratios', () => ({
    invalidateEffectiveRatioCache: (...a: unknown[]) => mockInvalidate(...a),
}));

const mockUserFindUnique = vi.fn();
const mockUserFindMany = vi.fn();
const mockGroupFindMany = vi.fn();
const tx = {
    customerRatioOverride: { deleteMany: vi.fn(), createMany: vi.fn() },
    user: { update: vi.fn() },
    analyticsEvent: { create: vi.fn() },
};
vi.mock('@/lib/db', () => ({
    prisma: {
        user: {
            findUnique: (...a: unknown[]) => mockUserFindUnique(...a),
            findMany: (...a: unknown[]) => mockUserFindMany(...a),
        },
        channelGroup: { findMany: (...a: unknown[]) => mockGroupFindMany(...a) },
        $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
}));

import { getCustomerRatioState, setCustomerRatios, vipGroupName, MATRIX_KEYS } from '../customer-ratio';

const GLOBAL = { default: 1.3, 'oai image 2': 1.8, 'OAI image 大客户专属': 1.8, 'pool-gpt': 0.4 };
const PORTAL_USER = {
    id: 'u-1',
    newapi_user_id: 1907,
    newapi_username: 'c-db420d6d',
    newapi_access_token: 'nap_pat',
    newapi_user_group: null,
    ratio_overrides: [] as Array<{ newapi_group: string; ratio: unknown; note: string | null; updated_at: Date }>,
};
const LIVE_USER = {
    id: 1907,
    username: 'c-db420d6d',
    display_name: 'c-db420d6d',
    remark: 'VIP 客户',
    group: 'default',
};

beforeEach(() => {
    vi.clearAllMocks();
    mockGetGroupRatios.mockResolvedValue({ ...GLOBAL });
    mockGroupFindMany.mockResolvedValue([
        { newapi_group: 'oai image 2', display_name: 'oai image 2' },
        { newapi_group: 'OAI image 大客户专属', display_name: 'OAI image 大客户专属' },
    ]);
    mockUserFindUnique.mockResolvedValue({ ...PORTAL_USER });
    mockGetUser.mockResolvedValue({ ...LIVE_USER });
    mockGetOption.mockResolvedValue(JSON.stringify({ vip: { 'oai image 2': 1.7 } }));
    mockPutOption.mockResolvedValue(undefined);
    mockUpdateUser.mockResolvedValue(undefined);
    mockListTokens.mockResolvedValue({ items: [], total: 0 });
    mockUpdateToken.mockResolvedValue(undefined);
    tx.customerRatioOverride.deleteMany.mockResolvedValue({});
    tx.customerRatioOverride.createMany.mockResolvedValue({});
    tx.user.update.mockResolvedValue({});
    tx.analyticsEvent.create.mockResolvedValue({});
});

describe('vipGroupName', () => {
    it('is one-to-one per customer and fits varchar(64)', () => {
        expect(vipGroupName('c-db420d6d')).toBe('vip-c-db420d6d');
        expect(vipGroupName('x'.repeat(80)).length).toBe(64);
    });
});

describe('setCustomerRatios', () => {
    it('writes BOTH matrix keys with the same JSON, moves the user to vip-<username> keeping display_name/remark, records rows, verifies', async () => {
        mockPricingRatios.mockResolvedValue({ 'oai image 2': 1.7, 'OAI image 大客户专属': 1.7, default: 1.3 });
        const r = await setCustomerRatios(
            'u-1',
            [
                { newapi_group: 'oai image 2', ratio: 1.7, note: ' 协议价 ' },
                { newapi_group: 'OAI image 大客户专属', ratio: 1.7 },
            ],
            'admin-1',
        );
        expect(r.userGroup).toBe('vip-c-db420d6d');
        expect(r.previousGroup).toBe('default');
        expect(r.verifiedOk).toBe(true);
        // 两键同写同值;其它用户分组(样例 vip)原样保留
        expect(mockPutOption).toHaveBeenCalledTimes(2);
        const keys = mockPutOption.mock.calls.map((c) => c[0]);
        expect(keys).toEqual([...MATRIX_KEYS]);
        const written = JSON.parse(mockPutOption.mock.calls[0][1] as string);
        expect(written).toEqual({
            vip: { 'oai image 2': 1.7 },
            'vip-c-db420d6d': { 'oai image 2': 1.7, 'OAI image 大客户专属': 1.7 },
        });
        expect(mockPutOption.mock.calls[1][1]).toBe(mockPutOption.mock.calls[0][1]);
        // 用户分组:只改 group,带原 display_name / remark,不带 quota
        expect(mockUpdateUser).toHaveBeenCalledWith({
            id: 1907,
            username: 'c-db420d6d',
            display_name: 'c-db420d6d',
            group: 'vip-c-db420d6d',
            remark: 'VIP 客户',
        });
        expect(JSON.stringify(mockUpdateUser.mock.calls[0][0])).not.toContain('quota');
        // 留痕
        expect(tx.customerRatioOverride.deleteMany).toHaveBeenCalledWith({ where: { user_id: 'u-1' } });
        const rows = (tx.customerRatioOverride.createMany.mock.calls[0][0] as { data: Array<Record<string, unknown>> })
            .data;
        expect(rows.map((x) => [x.newapi_group, String(x.ratio), x.note, x.updated_by])).toEqual([
            ['oai image 2', '1.7', '协议价', 'admin-1'],
            ['OAI image 大客户专属', '1.7', null, 'admin-1'],
        ]);
        expect(tx.user.update).toHaveBeenCalledWith({
            where: { id: 'u-1' },
            data: { newapi_user_group: 'vip-c-db420d6d' },
        });
        expect(mockInvalidate).toHaveBeenCalledWith(1907);
        expect(mockPricingRatios).toHaveBeenCalledWith({ accessToken: 'nap_pat', userId: 1907 });
    });

    it('clearing (empty list) moves the user back to default, deletes the vip-<username> matrix row, keeps other rows', async () => {
        mockGetUser.mockResolvedValue({ ...LIVE_USER, group: 'vip-c-db420d6d' });
        mockGetOption.mockResolvedValue(JSON.stringify({ vip: { x: 1 }, 'vip-c-db420d6d': { 'oai image 2': 1.7 } }));
        mockPricingRatios.mockResolvedValue({ ...GLOBAL });
        const r = await setCustomerRatios('u-1', [], 'admin-1');
        expect(r.userGroup).toBe('default');
        expect(JSON.parse(mockPutOption.mock.calls[0][1] as string)).toEqual({ vip: { x: 1 } });
        expect(mockUpdateUser).toHaveBeenCalledWith(expect.objectContaining({ group: 'default' }));
        expect(tx.customerRatioOverride.createMany).not.toHaveBeenCalled();
        expect(r.verifiedOk).toBe(true);
    });

    it('no user PUT when the group is already right', async () => {
        mockGetUser.mockResolvedValue({ ...LIVE_USER, group: 'vip-c-db420d6d' });
        mockPricingRatios.mockResolvedValue({ 'oai image 2': 1.5 });
        await setCustomerRatios('u-1', [{ newapi_group: 'oai image 2', ratio: 1.5 }], null);
        expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    it('rejects unknown groups / bad ratios / duplicates before touching new-api', async () => {
        await expect(setCustomerRatios('u-1', [{ newapi_group: 'nope', ratio: 1 }], null)).rejects.toMatchObject({
            code: 'unknown_group',
        });
        await expect(setCustomerRatios('u-1', [{ newapi_group: 'oai image 2', ratio: 0 }], null)).rejects.toMatchObject(
            { code: 'invalid_ratio' },
        );
        await expect(
            setCustomerRatios(
                'u-1',
                [
                    { newapi_group: 'oai image 2', ratio: 1 },
                    { newapi_group: 'oai image 2', ratio: 2 },
                ],
                null,
            ),
        ).rejects.toMatchObject({ code: 'unknown_group' });
        expect(mockPutOption).not.toHaveBeenCalled();
        expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    it('verifiedOk=false when the read-back disagrees; verification failure is non-fatal', async () => {
        mockPricingRatios.mockResolvedValue({ 'oai image 2': 1.8 });
        const r = await setCustomerRatios('u-1', [{ newapi_group: 'oai image 2', ratio: 1.7 }], null);
        expect(r.verifiedOk).toBe(false);
        mockPricingRatios.mockRejectedValue(new Error('503'));
        const r2 = await setCustomerRatios('u-1', [{ newapi_group: 'oai image 2', ratio: 1.7 }], null);
        expect(r2.verifiedOk).toBeNull();
    });
});

describe('getCustomerRatioState', () => {
    it('reports drift when matrix / live group disagree with portal rows', async () => {
        mockUserFindUnique.mockResolvedValue({
            ...PORTAL_USER,
            newapi_user_group: 'vip-c-db420d6d',
            ratio_overrides: [{ newapi_group: 'oai image 2', ratio: 1.7, note: null, updated_at: new Date() }],
        });
        mockGetUser.mockResolvedValue({ ...LIVE_USER, group: 'vip' }); // operator 手工设的样例分组
        mockGetOption.mockResolvedValue(JSON.stringify({ vip: { 'oai image 2': 1.7, 'OAI image 大客户专属': 1.7 } }));
        const st = await getCustomerRatioState('u-1');
        expect(st.liveGroup).toBe('vip');
        expect(st.drift).toBe(true);
        expect(st.driftDetail.join('\n')).toContain('期望 "vip-c-db420d6d"');
        expect(st.driftDetail.join('\n')).toContain('矩阵多出 OAI image 大客户专属');
        expect(st.availableGroups.map((g) => g.newapi_group)).toEqual(['oai image 2', 'OAI image 大客户专属']);
        expect(st.availableGroups[0].listRatio).toBe(1.8);
    });

    it('no rows + default group → no drift', async () => {
        const st = await getCustomerRatioState('u-1');
        expect(st.drift).toBe(false);
        expect(st.overrides).toEqual([]);
    });
});

describe('setCustomerRatios — 规则 4:进专属分组前钉住分组为空的 key(2026-10-26)', () => {
    const OVERRIDE = [{ newapi_group: 'oai image 2', ratio: 1.7 }];
    const tok = (id: number, group: string) => ({ id, name: `t${id}`, group });

    it('pins group-less keys to the previous (routable) group BEFORE moving the user group; explicit / auto untouched', async () => {
        mockPricingRatios.mockResolvedValue({ 'oai image 2': 1.7 });
        mockListTokens.mockResolvedValue({
            items: [tok(1, ''), tok(2, 'oai image 2'), tok(3, 'auto'), tok(4, '')],
            total: 4,
        });
        const order: string[] = [];
        mockUpdateToken.mockImplementation(async () => {
            order.push('token');
        });
        mockUpdateUser.mockImplementation(async () => {
            order.push('user');
        });
        const r = await setCustomerRatios('u-1', OVERRIDE, 'admin-1');
        expect(r.tokensPinned).toBe(2);
        expect(mockListTokens).toHaveBeenCalledWith({ accessToken: 'nap_pat', userId: 1907 }, 1, 100);
        expect(mockUpdateToken.mock.calls.map((c) => [c[1], c[2]])).toEqual([
            [1, { group: 'default' }],
            [4, { group: 'default' }],
        ]);
        expect(order).toEqual(['token', 'token', 'user']);
        const props = (tx.analyticsEvent.create.mock.calls[0][0] as { data: { properties: Record<string, unknown> } })
            .data.properties;
        expect(props.tokens_pinned).toBe(2);
    });

    it('a customer already parked in the sample `vip` group (no channels) gets group-less keys pinned to default, not vip', async () => {
        mockGetUser.mockResolvedValue({ ...LIVE_USER, group: 'vip' });
        mockPricingRatios.mockResolvedValue({ 'oai image 2': 1.7 });
        mockListTokens.mockResolvedValue({ items: [tok(9, '')], total: 1 });
        const r = await setCustomerRatios('u-1', OVERRIDE, 'admin-1');
        expect(r.previousGroup).toBe('vip');
        expect(mockUpdateToken).toHaveBeenCalledWith({ accessToken: 'nap_pat', userId: 1907 }, 9, { group: 'default' });
    });

    it('walks every page of the token list', async () => {
        mockPricingRatios.mockResolvedValue({ 'oai image 2': 1.7 });
        const page1 = Array.from({ length: 100 }, (_, i) => tok(i + 1, 'default'));
        mockListTokens
            .mockResolvedValueOnce({ items: page1, total: 101 })
            .mockResolvedValueOnce({ items: [tok(101, '')], total: 101 });
        const r = await setCustomerRatios('u-1', OVERRIDE, 'admin-1');
        expect(mockListTokens).toHaveBeenCalledTimes(2);
        expect(mockListTokens.mock.calls[1][1]).toBe(2);
        expect(r.tokensPinned).toBe(1);
    });

    it('a pin failure aborts the save before any matrix / user-group write (token_pin_failed)', async () => {
        mockListTokens.mockResolvedValue({ items: [tok(1, '')], total: 1 });
        mockUpdateToken.mockRejectedValue(new Error('new-api 500'));
        await expect(setCustomerRatios('u-1', OVERRIDE, 'admin-1')).rejects.toMatchObject({
            code: 'token_pin_failed',
        });
        expect(mockPutOption).not.toHaveBeenCalled();
        expect(mockUpdateUser).not.toHaveBeenCalled();
        expect(tx.customerRatioOverride.deleteMany).not.toHaveBeenCalled();
    });

    it('refuses to move a customer without an access token (cannot inspect their keys)', async () => {
        mockUserFindUnique.mockResolvedValue({ ...PORTAL_USER, newapi_access_token: null });
        await expect(setCustomerRatios('u-1', OVERRIDE, 'admin-1')).rejects.toMatchObject({
            code: 'token_pin_failed',
        });
        expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    it('clearing overrides (back to default) never touches keys', async () => {
        mockGetUser.mockResolvedValue({ ...LIVE_USER, group: 'vip-c-db420d6d' });
        mockGetOption.mockResolvedValue(JSON.stringify({ 'vip-c-db420d6d': { 'oai image 2': 1.7 } }));
        mockPricingRatios.mockResolvedValue({ ...GLOBAL });
        const r = await setCustomerRatios('u-1', [], 'admin-1');
        expect(r.userGroup).toBe('default');
        expect(r.tokensPinned).toBe(0);
        expect(mockListTokens).not.toHaveBeenCalled();
        expect(mockUpdateToken).not.toHaveBeenCalled();
    });
});
