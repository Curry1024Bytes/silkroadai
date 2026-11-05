import { describe, expect, it } from 'vitest';
import {
    internalGroupFor,
    liveInternalUsers,
    mergeGroupGroupRatio,
    moveInProblems,
    moveOutProblems,
    parseLiveSaleOptions,
    parseTokenGroups,
    ratioChanges,
    scheduledDiscountModels,
    userIdFromInternalGroup,
    type LiveSaleOptions,
    type NestedRatioMap,
} from '@/lib/pricing-rules/options';

const USER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const INTERNAL = internalGroupFor(USER);

function live(overrides: Partial<LiveSaleOptions> = {}): LiveSaleOptions {
    return {
        groupRatio: { default: 1, 'pool-gpt': 1.2 },
        groupGroupRatio: {},
        usableGroups: { default: '默认', 'pool-gpt': 'GPT' },
        specialUsable: {},
        scheduledModels: [],
        diagnostics: [],
        ...overrides,
    };
}

describe('pricing-rules options', () => {
    it('round-trips internal group names', () => {
        expect(INTERNAL).toBe('portal-user-0f8fad5bd9cb469fa16570867728950e');
        expect(userIdFromInternalGroup(INTERNAL)).toBe(USER);
        expect(userIdFromInternalGroup('vip')).toBeNull();
        expect(userIdFromInternalGroup('portal-user-xyz')).toBeNull();
    });

    it('parses options strictly and ignores the compiled-in dotted defaults', () => {
        const parsed = parseLiveSaleOptions({
            GroupRatio: '{"default":1,"pool-gpt":1.2}',
            'group_ratio_setting.group_ratio': '{"default":1,"svip":1,"vip":1}',
            GroupGroupRatio: '{}',
            'group_ratio_setting.group_group_ratio': '{"vip":{"edit_this":0.9}}',
            UserUsableGroups: '{"default":"默认"}',
        });
        expect(parsed.groupRatio).toEqual({ default: 1, 'pool-gpt': 1.2 });
        expect(parsed.diagnostics).toEqual([]);
        expect(() => parseLiveSaleOptions({ GroupRatio: '{bad', UserUsableGroups: '{}' })).toThrow('拒绝覆盖');
        expect(() => parseLiveSaleOptions({ GroupRatio: '{"a":-1}', UserUsableGroups: '{}' })).toThrow();
    });

    it('reports a real dual-key divergence', () => {
        const parsed = parseLiveSaleOptions({
            GroupRatio: '{"default":1,"pool-gpt":1.2}',
            'group_ratio_setting.group_ratio': '{"default":1}',
            UserUsableGroups: '{}',
        });
        expect(parsed.diagnostics.map((d) => d.code)).toEqual(['dual_key_diverged']);
    });

    it('treats any scheduled discount entry not explicitly disabled as active', () => {
        expect(
            scheduledDiscountModels('{"gpt-a":{"enabled":true},"gpt-b":{"enabled":false},"gpt-c":{"discount":0.5}}'),
        ).toEqual(['gpt-a', 'gpt-c']);
        expect(() => scheduledDiscountModels('[1]')).toThrow();
    });

    it('rewrites only owned pairs and keeps native rows', () => {
        const liveRows: NestedRatioMap = { vip: { 'pool-gpt': 0.9 }, [INTERNAL]: { 'pool-gpt': 1, other: 0.5 } };
        const next = mergeGroupGroupRatio(liveRows, { 'pool-gpt': [USER] }, { 'pool-gpt': {} });
        expect(next).toEqual({ vip: { 'pool-gpt': 0.9 }, [INTERNAL]: { other: 0.5 } });
        const set = mergeGroupGroupRatio({}, { 'pool-gpt': [USER] }, { 'pool-gpt': { [USER]: 0.96 } });
        expect(set).toEqual({ [INTERNAL]: { 'pool-gpt': 0.96 } });
        expect(liveInternalUsers(liveRows, ['pool-gpt', 'missing'])).toEqual({ 'pool-gpt': [USER], missing: [] });
    });

    it('refuses moves that would break keys or drop native rules', () => {
        expect(
            moveInProblems({ live: live(), fromGroup: 'default', internalGroup: INTERNAL, keyGroups: [['pool-gpt']] }),
        ).toEqual([]);
        const restricted = live({ usableGroups: { default: '默认' } });
        expect(
            moveInProblems({
                live: restricted,
                fromGroup: 'pool-gpt',
                internalGroup: INTERNAL,
                keyGroups: [['pool-gpt']],
            }),
        ).toEqual(['移动后客户 Key 的分组 pool-gpt 不再可用']);
        const native = live({ groupGroupRatio: { default: { 'pool-gpt': 0.9, gone: 0.5 } } });
        expect(moveInProblems({ live: native, fromGroup: 'default', internalGroup: INTERNAL, keyGroups: [] })).toEqual([
            '原分组 default 在 pool-gpt 上有原生专属倍率，移动后会失效',
        ]);
        const reserved = live({ usableGroups: { [INTERNAL]: 'x' } });
        expect(
            moveInProblems({ live: reserved, fromGroup: 'default', internalGroup: INTERNAL, keyGroups: [] }),
        ).toHaveLength(1);
    });

    it('refuses to move a customer whose keys follow the user group', () => {
        expect(
            moveInProblems({ live: live(), fromGroup: 'default', internalGroup: INTERNAL, keyGroups: [[], ['auto']] }),
        ).toEqual(['客户有 2 个 Key 未固定分组（空或 auto），移动后会跟着用户分组走']);
        expect(parseTokenGroups(' pool-gpt ,, default,pool-gpt')).toEqual(['pool-gpt', 'default']);
        expect(parseTokenGroups(undefined)).toEqual([]);
    });

    it('checks key groups before returning a customer to its original group', () => {
        const restricted = live({ usableGroups: { 'pool-gpt': 'x' } });
        expect(
            moveOutProblems({
                live: restricted,
                internalGroup: INTERNAL,
                toGroup: 'default',
                keyGroups: [['pool-gpt']],
            }),
        ).toEqual([]);
        expect(
            moveOutProblems({
                live: live({ usableGroups: {}, specialUsable: {} }),
                internalGroup: INTERNAL,
                toGroup: 'default',
                keyGroups: [[INTERNAL]],
            }),
        ).toEqual([`回到原分组后客户 Key 的分组 ${INTERNAL} 不再可用`]);
        expect(moveOutProblems({ live: live(), internalGroup: INTERNAL, toGroup: '', keyGroups: [] })).toEqual([
            '原分组未知',
        ]);
    });

    it('lists effective price changes and flags increases', () => {
        const changes = ratioChanges({
            liveGroupRatio: { 'pool-gpt': 1.2 },
            nextGroupRatio: { 'pool-gpt': 1.08 },
            liveRows: { [INTERNAL]: { 'pool-gpt': 0.96 } },
            nextRows: {},
            owned: { 'pool-gpt': [USER] },
        });
        expect(changes).toEqual([
            { newapiGroup: 'pool-gpt', userId: null, before: 1.2, after: 1.08, increase: false },
            { newapiGroup: 'pool-gpt', userId: USER, before: 0.96, after: 1.08, increase: true },
        ]);
    });
});
