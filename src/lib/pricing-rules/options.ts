/**
 * Pure helpers for the sale-rule publisher: parse new-api options, merge only
 * the entries the compiler owns, and decide whether moving a customer into its
 * internal group is safe.
 *
 * GroupRatio / group_ratio_setting.group_ratio (and the GroupGroupRatio pair)
 * share one in-memory map in new-api. new-api replays every option row every
 * 60s in database order, so two rows with different content flip the live map.
 * The publisher therefore always writes both keys with the same full value.
 */
import type { Diagnostic } from './compile';

export const GROUP_RATIO_KEYS = ['GroupRatio', 'group_ratio_setting.group_ratio'] as const;
export const GROUP_GROUP_RATIO_KEYS = ['GroupGroupRatio', 'group_ratio_setting.group_group_ratio'] as const;
export const USABLE_GROUPS_KEY = 'UserUsableGroups';
export const SPECIAL_USABLE_KEY = 'group_ratio_setting.group_special_usable_group';
export const SCHEDULED_DISCOUNT_KEY = 'billing_setting.scheduled_discount';

/** new-api's compiled-in defaults, reported while no database row exists. */
const DEFAULT_DOTTED: Record<string, string> = {
    'group_ratio_setting.group_ratio': '{"default":1,"svip":1,"vip":1}',
    'group_ratio_setting.group_group_ratio': '{"vip":{"edit_this":0.9}}',
};

export type RatioMap = Record<string, number>;
export type NestedRatioMap = Record<string, Record<string, number>>;

export interface LiveSaleOptions {
    groupRatio: RatioMap;
    groupGroupRatio: NestedRatioMap;
    usableGroups: Record<string, string>;
    specialUsable: Record<string, Record<string, string>>;
    scheduledModels: string[];
    diagnostics: Diagnostic[];
}

export class SaleOptionsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SaleOptionsError';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decode(raw: unknown, key: string): unknown {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'string') return raw;
    if (!raw.trim()) return {};
    try {
        return JSON.parse(raw);
    } catch {
        throw new SaleOptionsError(`new-api 的 ${key} 不是有效 JSON，拒绝覆盖。`);
    }
}

function ratio(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function parseRatioMap(raw: unknown, key: string): RatioMap {
    const decoded = decode(raw, key);
    if (!isRecord(decoded) || Object.entries(decoded).some(([name, value]) => !name.trim() || !ratio(value)))
        throw new SaleOptionsError(`new-api 的 ${key} 格式无效，拒绝覆盖。`);
    return { ...(decoded as RatioMap) };
}

export function parseNestedRatioMap(raw: unknown, key: string): NestedRatioMap {
    const decoded = decode(raw, key);
    if (!isRecord(decoded)) throw new SaleOptionsError(`new-api 的 ${key} 格式无效，拒绝覆盖。`);
    const result: NestedRatioMap = {};
    for (const [userGroup, inner] of Object.entries(decoded)) {
        if (!userGroup.trim() || !isRecord(inner)) throw new SaleOptionsError(`new-api 的 ${key} 格式无效，拒绝覆盖。`);
        const rows: Record<string, number> = {};
        for (const [group, value] of Object.entries(inner)) {
            if (!group.trim() || !ratio(value)) throw new SaleOptionsError(`new-api 的 ${key} 格式无效，拒绝覆盖。`);
            rows[group] = value;
        }
        result[userGroup] = rows;
    }
    return result;
}

function parseStringMap(raw: unknown, key: string): Record<string, string> {
    const decoded = decode(raw, key);
    if (!isRecord(decoded) || Object.values(decoded).some((value) => typeof value !== 'string'))
        throw new SaleOptionsError(`new-api 的 ${key} 格式无效。`);
    return decoded as Record<string, string>;
}

function parseSpecialUsable(raw: unknown): Record<string, Record<string, string>> {
    const decoded = decode(raw, SPECIAL_USABLE_KEY);
    if (!isRecord(decoded)) throw new SaleOptionsError(`new-api 的 ${SPECIAL_USABLE_KEY} 格式无效。`);
    return Object.fromEntries(
        Object.entries(decoded).map(([group, inner]) => [group, parseStringMap(inner, SPECIAL_USABLE_KEY)]),
    );
}

/** Model names whose scheduled discount is not explicitly disabled. Fails closed on a bad document. */
export function scheduledDiscountModels(raw: unknown): string[] {
    const decoded = decode(raw, SCHEDULED_DISCOUNT_KEY);
    if (!isRecord(decoded)) throw new SaleOptionsError(`new-api 的 ${SCHEDULED_DISCOUNT_KEY} 格式无效。`);
    return Object.entries(decoded)
        .filter(([name, entry]) => name.trim() && !(isRecord(entry) && entry.enabled === false))
        .map(([name]) => name)
        .sort();
}

function same(left: unknown, right: unknown): boolean {
    return JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right));
}

function sortKeys(value: unknown): unknown {
    if (!isRecord(value)) return value;
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, sortKeys(value[key])]),
    );
}

function mirrorDiagnostic(options: Record<string, unknown>, classicValue: unknown, dottedKey: string): Diagnostic[] {
    const raw = options[dottedKey];
    if (raw === undefined || raw === null) return [];
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (DEFAULT_DOTTED[dottedKey] && same(decode(text, dottedKey), decode(DEFAULT_DOTTED[dottedKey], dottedKey)))
        return [];
    if (same(decode(text, dottedKey), classicValue)) return [];
    return [
        {
            level: 'warn',
            code: 'dual_key_diverged',
            message: `new-api 的 ${dottedKey} 与经典键内容不同，60 秒内存同步后哪份生效不确定。`,
        },
    ];
}

/**
 * True when new-api probably holds a database row for this dotted copy: the
 * value is present and differs from the compiled-in default it reports while no
 * row exists. Writing a row that does not exist would create a second copy that
 * a later classic-only edit could diverge from.
 */
export function mirrorRowPresent(options: Record<string, unknown>, dottedKey: string): boolean {
    const raw = options[dottedKey];
    if (raw === undefined || raw === null) return false;
    const fallback = DEFAULT_DOTTED[dottedKey];
    if (!fallback) return true;
    try {
        return !same(decode(raw, dottedKey), decode(fallback, dottedKey));
    } catch {
        return true;
    }
}

export function sameRatioMaps(left: unknown, right: unknown): boolean {
    return same(left, right);
}

export function parseLiveSaleOptions(options: Record<string, unknown>): LiveSaleOptions {
    const groupRatio = parseRatioMap(options[GROUP_RATIO_KEYS[0]], GROUP_RATIO_KEYS[0]);
    const groupGroupRatio = parseNestedRatioMap(options[GROUP_GROUP_RATIO_KEYS[0]], GROUP_GROUP_RATIO_KEYS[0]);
    return {
        groupRatio,
        groupGroupRatio,
        usableGroups: parseStringMap(options[USABLE_GROUPS_KEY], USABLE_GROUPS_KEY),
        specialUsable: parseSpecialUsable(options[SPECIAL_USABLE_KEY]),
        scheduledModels: scheduledDiscountModels(options[SCHEDULED_DISCOUNT_KEY]),
        diagnostics: [
            ...mirrorDiagnostic(options, groupRatio, GROUP_RATIO_KEYS[1]),
            ...mirrorDiagnostic(options, groupGroupRatio, GROUP_GROUP_RATIO_KEYS[1]),
        ],
    };
}
export const INTERNAL_GROUP_PREFIX = 'portal-user-';
const INTERNAL_PREFIX = INTERNAL_GROUP_PREFIX;

/** Must stay identical to user-tier-multiplier.ts internalNewApiUserGroup. */
export function internalGroupFor(userId: string): string {
    return `${INTERNAL_PREFIX}${userId.replaceAll('-', '')}`;
}

/** Reverse of internalGroupFor; null for any group Portal did not create. */
export function userIdFromInternalGroup(group: string): string | null {
    if (!group.startsWith(INTERNAL_PREFIX)) return null;
    const hex = group.slice(INTERNAL_PREFIX.length);
    if (!/^[0-9a-f]{32}$/.test(hex)) return null;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Live users with an internal-group row in each billing group (orphans included). */
export function liveInternalUsers(live: NestedRatioMap, groups: string[]): Record<string, string[]> {
    const result: Record<string, string[]> = Object.fromEntries(groups.map((group) => [group, []]));
    for (const [userGroup, rows] of Object.entries(live)) {
        const userId = userIdFromInternalGroup(userGroup);
        if (!userId) continue;
        for (const group of groups) if (Object.hasOwn(rows, group)) result[group].push(userId);
    }
    return result;
}

export function mergeGroupRatio(live: RatioMap, targets: Record<string, number>): RatioMap {
    return { ...live, ...targets };
}

/**
 * Rewrite only owned (internal group, billing group) pairs: set the target row
 * or delete it. Native user groups and non-owned pairs are copied unchanged.
 */
export function mergeGroupGroupRatio(
    live: NestedRatioMap,
    owned: Record<string, string[]>,
    rows: Record<string, Record<string, number>>,
): NestedRatioMap {
    const next: NestedRatioMap = Object.fromEntries(
        Object.entries(live).map(([group, inner]) => [group, { ...inner }]),
    );
    for (const [group, userIds] of Object.entries(owned)) {
        for (const userId of userIds) {
            const internal = internalGroupFor(userId);
            const value = rows[group]?.[userId];
            if (value === undefined) {
                if (next[internal]) delete next[internal][group];
            } else (next[internal] ??= {})[group] = value;
            if (next[internal] && !Object.keys(next[internal]).length) delete next[internal];
        }
    }
    return next;
}

/** Same algorithm as new-api service.GetUserUsableGroups. */
export function usableGroupsFor(live: LiveSaleOptions, userGroup: string): Set<string> {
    const groups = new Map(Object.entries(live.usableGroups));
    for (const [entry, description] of Object.entries(live.specialUsable[userGroup] ?? {})) {
        if (entry.startsWith('-:')) groups.delete(entry.slice(2));
        else if (entry.startsWith('+:')) groups.set(entry.slice(2), description);
        else groups.set(entry, description);
    }
    if (userGroup && !groups.has(userGroup)) groups.set(userGroup, '用户分组');
    return new Set(groups.keys());
}

/** Same parsing as new-api model.ParseTokenGroups: trimmed, de-duplicated, empty items dropped. */
export function parseTokenGroups(value: unknown): string[] {
    if (typeof value !== 'string') return [];
    return [
        ...new Set(
            value
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean),
        ),
    ];
}

/**
 * Keys without a fixed group (empty, or `auto`) resolve their group from the
 * user's own group at request time, so moving the user changes where they route.
 */
export function followsUserGroup(groups: string[]): boolean {
    return groups.length === 0 || groups.includes('auto');
}

/** Key groups usable as `fromGroup` that stop being usable as `toGroup`. */
export function lostKeyGroups(
    live: LiveSaleOptions,
    fromGroup: string,
    toGroup: string,
    keyGroups: string[],
): string[] {
    const before = usableGroupsFor(live, fromGroup);
    const after = usableGroupsFor(live, toGroup);
    return [...new Set(keyGroups)].filter((group) => group !== 'auto' && before.has(group) && !after.has(group));
}

/** Reasons a customer cannot leave `fromGroup` for its internal group; empty = safe. */
export function moveInProblems(args: {
    live: LiveSaleOptions;
    fromGroup: string;
    internalGroup: string;
    keyGroups: string[][];
}): string[] {
    const { live, fromGroup, internalGroup } = args;
    const problems: string[] = [];
    if (Object.hasOwn(live.usableGroups, internalGroup) || Object.hasOwn(live.groupRatio, internalGroup))
        problems.push(`内部分组 ${internalGroup} 已出现在可用分组或分组倍率中`);
    const native = Object.keys(live.groupGroupRatio[fromGroup] ?? {}).filter((group) =>
        Object.hasOwn(live.groupRatio, group),
    );
    if (native.length) problems.push(`原分组 ${fromGroup} 在 ${native.join('、')} 上有原生专属倍率，移动后会失效`);
    if (Object.keys(live.specialUsable[fromGroup] ?? {}).length)
        problems.push(`原分组 ${fromGroup} 设有特殊可用分组，移动后会失效`);
    const unpinned = args.keyGroups.filter(followsUserGroup).length;
    if (unpinned) problems.push(`客户有 ${unpinned} 个 Key 未固定分组（空或 auto），移动后会跟着用户分组走`);
    const lost = lostKeyGroups(live, fromGroup, internalGroup, args.keyGroups.flat());
    if (lost.length) problems.push(`移动后客户 Key 的分组 ${lost.join('、')} 不再可用`);
    return problems;
}

/** Reasons a customer cannot return from its internal group to `toGroup`; empty = safe. */
export function moveOutProblems(args: {
    live: LiveSaleOptions;
    internalGroup: string;
    toGroup: string;
    keyGroups: string[][];
}): string[] {
    const problems: string[] = [];
    if (!args.toGroup.trim()) problems.push('原分组未知');
    const lost = lostKeyGroups(args.live, args.internalGroup, args.toGroup, args.keyGroups.flat());
    if (lost.length) problems.push(`回到原分组后客户 Key 的分组 ${lost.join('、')} 不再可用`);
    return problems;
}

export interface RatioChange {
    newapiGroup: string;
    userId: string | null;
    before: number | null;
    after: number | null;
    increase: boolean;
}

/** Effective-price changes for the preview. A customer without a row pays the group ratio. */
export function ratioChanges(args: {
    liveGroupRatio: RatioMap;
    nextGroupRatio: RatioMap;
    liveRows: NestedRatioMap;
    nextRows: NestedRatioMap;
    owned: Record<string, string[]>;
}): RatioChange[] {
    const changes: RatioChange[] = [];
    for (const [group, userIds] of Object.entries(args.owned)) {
        const before = args.liveGroupRatio[group] ?? null;
        const after = args.nextGroupRatio[group] ?? null;
        if (before !== after)
            changes.push({ newapiGroup: group, userId: null, before, after, increase: (after ?? 0) > (before ?? 0) });
        for (const userId of userIds) {
            const internal = internalGroupFor(userId);
            const rowBefore = args.liveRows[internal]?.[group] ?? before;
            const rowAfter = args.nextRows[internal]?.[group] ?? after;
            if (rowBefore !== rowAfter)
                changes.push({
                    newapiGroup: group,
                    userId,
                    before: rowBefore,
                    after: rowAfter,
                    increase: (rowAfter ?? 0) > (rowBefore ?? 0),
                });
        }
    }
    return changes;
}
