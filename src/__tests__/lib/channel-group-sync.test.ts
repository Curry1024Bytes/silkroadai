/**
 * channel-group sync — new-api `UserUsableGroups` 为唯一事实源:
 *   - 按 newapi_group 匹配更新 display_name / 复活 enabled(key 不动)
 *   - new-api 新增组 → 自动建行(slug key + 末尾 tier_level)
 *   - new-api 删掉组 → enabled=false 软下架
 *   - option 缺失 / JSON 坏 / 空字典 / getOption 抛 → 跳过,不写 DB、不抛
 *   - 60s 节流:窗口内第二次调用不再打 new-api
 *   - listEnabledChannelGroups:平台 tenant 触发同步,外部 tenant 不触发
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetOption = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    getOption: (...a: unknown[]) => mockGetOption(...a),
}));

const mockFindMany = vi.fn();
const mockUpdate = vi.fn();
const mockCreate = vi.fn();
const mockTransaction = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        channelGroup: {
            findMany: (...a: unknown[]) => mockFindMany(...a),
            update: (...a: unknown[]) => mockUpdate(...a),
            create: (...a: unknown[]) => mockCreate(...a),
        },
        $transaction: (...a: unknown[]) => mockTransaction(...a),
    },
}));

import {
    __resetChannelGroupSyncForTests,
    __resetGroupRatioCacheForTests,
    DefaultChannelGroupConfigurationError,
    getDefaultChannelGroup,
    getGroupRatios,
    listEnabledChannelGroups,
    syncChannelGroupsFromNewApi,
} from '@/lib/channel-group';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

function row(partial: Record<string, unknown>) {
    return {
        id: 'id-x',
        tenant_id: PLATFORM_TENANT_ID,
        key: 'pool',
        display_name: '默认(号池为主)',
        description: null,
        newapi_group: 'default',
        tier_level: 0,
        enabled: true,
        is_default: false,
        newapi_channel_ids: [],
        ...partial,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    __resetChannelGroupSyncForTests();
    mockFindMany.mockResolvedValue([]);
    mockTransaction.mockResolvedValue([]);
});

describe('syncChannelGroupsFromNewApi', () => {
    it('updates display_name and re-enables an existing row matched by newapi_group, keeping its key', async () => {
        mockFindMany.mockResolvedValue([
            row({ id: 'id-1', key: 'pool', newapi_group: 'default', display_name: '旧名', enabled: false }),
        ]);
        mockGetOption.mockResolvedValue(JSON.stringify({ default: '默认分组' }));

        await syncChannelGroupsFromNewApi();

        expect(mockUpdate).toHaveBeenCalledWith({
            where: { id: 'id-1' },
            data: { display_name: '默认分组', enabled: true },
        });
        expect(mockCreate).not.toHaveBeenCalled();
        expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it('creates rows for groups new-api has that portal lacks (slug key, appended tier_level)', async () => {
        mockFindMany.mockResolvedValue([
            row({ id: 'id-1', key: 'pool', newapi_group: 'default', display_name: '默认分组', tier_level: 3 }),
        ]);
        mockGetOption.mockResolvedValue(JSON.stringify({ default: '默认分组', 'ccmax 蒸馏': 'Claude官方稳定' }));

        await syncChannelGroupsFromNewApi();

        expect(mockUpdate).not.toHaveBeenCalled();
        expect(mockCreate).toHaveBeenCalledWith({
            data: {
                tenant_id: PLATFORM_TENANT_ID,
                key: 'ccmax-蒸馏',
                display_name: 'Claude官方稳定',
                newapi_group: 'ccmax 蒸馏',
                tier_level: 4,
                enabled: true,
                is_default: false,
            },
        });
    });

    it('suffixes the slug key when it collides with an existing portal key', async () => {
        mockFindMany.mockResolvedValue([
            row({ id: 'id-1', key: 'official', newapi_group: 'ccmax 蒸馏', display_name: '官方稳定', tier_level: 0 }),
            row({
                id: 'id-2',
                key: 'newgrp',
                newapi_group: 'legacy',
                display_name: '旧组',
                tier_level: 1,
                enabled: false,
            }),
        ]);
        mockGetOption.mockResolvedValue(JSON.stringify({ 'ccmax 蒸馏': '官方稳定', NewGrp: '新组' }));

        await syncChannelGroupsFromNewApi();

        expect(mockCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({ key: 'newgrp-2', newapi_group: 'NewGrp', display_name: '新组' }),
        });
    });

    it('disables enabled rows whose newapi_group vanished from UserUsableGroups', async () => {
        mockFindMany.mockResolvedValue([
            row({ id: 'id-1', key: 'pool', newapi_group: 'default', display_name: '默认分组' }),
            row({ id: 'id-2', key: 'gone', newapi_group: 'gone-group', display_name: '要下架', enabled: true }),
            row({ id: 'id-3', key: 'gone2', newapi_group: 'gone-too', display_name: '早下架', enabled: false }),
        ]);
        mockGetOption.mockResolvedValue(JSON.stringify({ default: '默认分组' }));

        await syncChannelGroupsFromNewApi();

        expect(mockUpdate).toHaveBeenCalledTimes(1);
        expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'id-2' }, data: { enabled: false } });
    });

    it('"@"-prefixed display name = hidden group: disables matching rows and never creates one', async () => {
        mockFindMany.mockResolvedValue([
            row({ id: 'id-1', key: 'pool', newapi_group: 'default', display_name: '默认分组' }),
            row({ id: 'id-2', key: 'image2', newapi_group: 'image2', display_name: 'GPT 生图', enabled: true }),
        ]);
        mockGetOption.mockResolvedValue(
            JSON.stringify({ default: '默认分组', image2: '@GPT 生图', 'internal-new': '@内部新组' }),
        );

        await syncChannelGroupsFromNewApi();

        expect(mockUpdate).toHaveBeenCalledTimes(1);
        expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'id-2' }, data: { enabled: false } });
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('multiple portal rows sharing one newapi_group keep their distinct display names (only enabled is managed)', async () => {
        mockFindMany.mockResolvedValue([
            row({ id: 'id-1', key: 'pool', newapi_group: 'default', display_name: '默认（号池为主）' }),
            row({ id: 'id-2', key: 'geminit3', newapi_group: 'default', display_name: 'geminit3', enabled: false }),
        ]);
        mockGetOption.mockResolvedValue(JSON.stringify({ default: '默认分组' }));

        await syncChannelGroupsFromNewApi();

        // 别名行只被复活,谁都不被改名成「默认分组」。
        expect(mockUpdate).toHaveBeenCalledTimes(1);
        expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'id-2' }, data: { enabled: true } });
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('is a no-op when everything already matches', async () => {
        mockFindMany.mockResolvedValue([row({ id: 'id-1', display_name: '默认分组' })]);
        mockGetOption.mockResolvedValue(JSON.stringify({ default: '默认分组' }));

        await syncChannelGroupsFromNewApi();

        expect(mockUpdate).not.toHaveBeenCalled();
        expect(mockCreate).not.toHaveBeenCalled();
        expect(mockTransaction).not.toHaveBeenCalled();
    });

    it.each([
        ['option missing', null],
        ['malformed JSON', '{oops'],
        ['non-object JSON', '["default"]'],
        ['empty dict (suspected operator mistake)', '{}'],
    ])('skips without touching the DB when UserUsableGroups is %s', async (_label, value) => {
        mockGetOption.mockResolvedValue(value);

        await syncChannelGroupsFromNewApi();

        expect(mockFindMany).not.toHaveBeenCalled();
        expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('swallows getOption failures (new-api down) instead of throwing', async () => {
        mockGetOption.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(syncChannelGroupsFromNewApi()).resolves.toBeUndefined();
        expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('throttles: a second call inside the 60s window does not hit new-api again', async () => {
        mockGetOption.mockResolvedValue(JSON.stringify({ default: '默认分组' }));

        await syncChannelGroupsFromNewApi();
        await syncChannelGroupsFromNewApi();

        expect(mockGetOption).toHaveBeenCalledTimes(1);
    });

    it('throttles failed attempts too (no hammering while new-api is down)', async () => {
        mockGetOption.mockRejectedValue(new Error('ECONNREFUSED'));

        await syncChannelGroupsFromNewApi();
        await syncChannelGroupsFromNewApi();

        expect(mockGetOption).toHaveBeenCalledTimes(1);
    });
});

describe('listEnabledChannelGroups sync trigger', () => {
    it('platform tenant (null) runs the sync before reading', async () => {
        mockGetOption.mockResolvedValue(JSON.stringify({ default: '默认分组' }));

        await listEnabledChannelGroups(null);

        expect(mockGetOption).toHaveBeenCalledTimes(1);
        expect(mockFindMany).toHaveBeenLastCalledWith({
            where: { tenant_id: PLATFORM_TENANT_ID, enabled: true },
            orderBy: { tier_level: 'asc' },
        });
    });

    it('non-platform tenant does not trigger the sync', async () => {
        await listEnabledChannelGroups('11111111-2222-3333-4444-555555555555');

        expect(mockGetOption).not.toHaveBeenCalled();
        expect(mockFindMany).toHaveBeenCalledWith({
            where: { tenant_id: '11111111-2222-3333-4444-555555555555', enabled: true },
            orderBy: { tier_level: 'asc' },
        });
    });
});

describe('getDefaultChannelGroup', () => {
    const tenantId = '11111111-2222-3333-4444-555555555555';

    it('returns the sole enabled is_default group', async () => {
        const defaultGroup = row({ tenant_id: tenantId, key: 'sale', newapi_group: 'GPT-特惠反代', is_default: true });
        mockFindMany.mockResolvedValue([defaultGroup, row({ tenant_id: tenantId, key: 'pro', is_default: false })]);

        await expect(getDefaultChannelGroup(tenantId)).resolves.toEqual(defaultGroup);
    });

    it('rejects when no enabled default group exists', async () => {
        mockFindMany.mockResolvedValue([row({ tenant_id: tenantId, key: 'sale', is_default: false })]);

        await expect(getDefaultChannelGroup(tenantId)).rejects.toBeInstanceOf(DefaultChannelGroupConfigurationError);
    });

    it('rejects ambiguous duplicate defaults', async () => {
        mockFindMany.mockResolvedValue([
            row({ tenant_id: tenantId, key: 'sale', is_default: true }),
            row({ tenant_id: tenantId, key: 'pro', is_default: true }),
        ]);

        await expect(getDefaultChannelGroup(tenantId)).rejects.toThrow('found 2');
    });
});

describe('getGroupRatios(GroupRatio 倍率同步,/keys 档次下拉「Nx 倍率」徽章数据源)', () => {
    beforeEach(() => {
        __resetGroupRatioCacheForTests();
    });

    it('解析 GroupRatio option 为 组名→倍率 字典(非数值条目丢弃)', async () => {
        mockGetOption.mockResolvedValue(JSON.stringify({ 'cc-kiro': 0.4, default: 1.3, bad: 'x' }));
        const ratios = await getGroupRatios();
        expect(ratios).toEqual({ 'cc-kiro': 0.4, default: 1.3 });
        expect(mockGetOption).toHaveBeenCalledWith('GroupRatio');
    });

    it('60s 内二次调用不再打 new-api(节流缓存)', async () => {
        mockGetOption.mockResolvedValue(JSON.stringify({ default: 1.3 }));
        await getGroupRatios();
        await getGroupRatios();
        expect(mockGetOption).toHaveBeenCalledTimes(1);
    });

    it('缓存过期后 getOption 抛错 → 返上次好值(stale),不抛出', async () => {
        vi.useFakeTimers();
        try {
            mockGetOption.mockResolvedValueOnce(JSON.stringify({ default: 1.3 }));
            await getGroupRatios();
            vi.advanceTimersByTime(61_000); // 过节流窗口
            mockGetOption.mockRejectedValueOnce(new Error('new-api down'));
            expect(await getGroupRatios()).toEqual({ default: 1.3 });
            expect(mockGetOption).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('option 缺失 / JSON 坏 → 空表 + 不抛,且同样压节流', async () => {
        mockGetOption.mockResolvedValue(null);
        expect(await getGroupRatios()).toEqual({});
        mockGetOption.mockResolvedValue('not-json');
        expect(await getGroupRatios()).toEqual({}); // 节流窗口内,不重打
        expect(mockGetOption).toHaveBeenCalledTimes(1);
    });
});
