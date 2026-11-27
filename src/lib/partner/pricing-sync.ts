import 'server-only';

import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { getSaleRuleOptions, putOption } from '@/lib/newapi/client';
import {
    assertOptionSyncWritable,
    putJsonOptionWithReadback,
    withOptionSyncLock,
} from '@/lib/newapi/user-tier-multiplier';
import {
    GROUP_GROUP_RATIO_KEYS,
    GROUP_RATIO_KEYS,
    SPECIAL_USABLE_KEY,
    USABLE_GROUPS_KEY,
    mirrorRowPresent,
    parseNestedRatioMap,
    parseRatioMap,
    parseSpecialUsable,
    parseUsableGroups,
    sameRatioMaps,
    type NestedRatioMap,
    type RatioMap,
} from '@/lib/pricing-rules/options';
import { PartnerPricingError } from '@/lib/partner/errors';
import { partnerUserGroup } from '@/lib/partner/group';

/**
 * 代理定价写 new-api 的唯一入口。每个代理只占两个配置项里的 partner-X 一行，其余行原样保留：
 *  - GroupGroupRatio[partner-X] = { 计费分组: 零售率 }，只含已开放（有零售率）的分组
 *  - group_ratio_setting.group_special_usable_group[partner-X] = { "-:分组": "" }，其余可用分组全部隐藏
 *
 * 顺序：持定价锁 → 读 Portal 与 new-api 现值 → 调用方校验并给出改动后的行 → 写 new-api 并回读
 * → Portal 落库。落库失败时把 new-api 恢复成写之前的原值。
 */

export interface PartnerPriceRow {
    group_key: string;
    wholesale_ratio: number;
    retail_ratio: number | null;
}

type SpecialUsable = Record<string, Record<string, string>>;

export interface PartnerOptionsPlan {
    ratios: NestedRatioMap;
    special: SpecialUsable;
}

export interface PartnerPricingContext {
    /** 该代理现在的全部价格行。 */
    current: PartnerPriceRow[];
    /** 平台启用中的档次：key → new-api 计费分组。 */
    billingGroups: Map<string, string>;
    /** new-api 现行 GroupRatio，用于校验计费分组存在。 */
    groupRatio: RatioMap;
}

export interface PartnerPricingChange<T> {
    /** 改动后的全部价格行，用来算 new-api 的目标值。 */
    next: PartnerPriceRow[];
    /** Portal 落库，只在 new-api 回读通过后执行。 */
    persist: () => Promise<T>;
}

/** 已开放给代理客户的计费分组 → 零售率。只算有零售率、且平台档次仍启用的分组。 */
export function openRetailRatios(rows: PartnerPriceRow[], billingGroups: Map<string, string>): RatioMap {
    const result: RatioMap = {};
    for (const row of rows) {
        if (row.retail_ratio == null) continue;
        const group = billingGroups.get(row.group_key);
        if (group) result[group] = row.retail_ratio;
    }
    return result;
}

/** 只重写 userGroup 这一行。retail 为空时删掉零售率行，所有可用分组都隐藏。 */
export function planPartnerOptions(args: {
    userGroup: string;
    retail: RatioMap;
    ratios: NestedRatioMap;
    usableGroups: Record<string, string>;
    special: SpecialUsable;
}): PartnerOptionsPlan {
    const ratios = cloneNested(args.ratios);
    if (Object.keys(args.retail).length) ratios[args.userGroup] = { ...args.retail };
    else delete ratios[args.userGroup];

    const special = cloneNested(args.special);
    const hidden = Object.fromEntries(
        Object.keys(args.usableGroups)
            .filter((group) => !Object.hasOwn(args.retail, group))
            .sort()
            .map((group) => [`-:${group}`, '']),
    );
    if (Object.keys(hidden).length) special[args.userGroup] = hidden;
    else delete special[args.userGroup];
    return { ratios, special };
}

function cloneNested<V>(value: Record<string, Record<string, V>>): Record<string, Record<string, V>> {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, { ...inner }]));
}

interface LiveOptions {
    groupRatio: RatioMap;
    ratios: NestedRatioMap;
    /** dotted 镜像行存在时，写零售率必须两份同写。 */
    mirrored: boolean;
    usableGroups: Record<string, string>;
    special: SpecialUsable;
    /** 写之前的原文，用于恢复。 */
    raw: Record<string, string>;
}

function optionText(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
}

async function readLiveOptions(): Promise<LiveOptions> {
    const options = await getSaleRuleOptions();
    const [classic, dotted] = GROUP_GROUP_RATIO_KEYS;
    const ratios = parseNestedRatioMap(options[classic], classic);
    const mirrored = mirrorRowPresent(options, dotted);
    if (mirrored && !sameRatioMaps(parseNestedRatioMap(options[dotted], dotted), ratios)) {
        throw new PartnerPricingError(
            `new-api 的 ${dotted} 与 ${classic} 内容不同，60 秒内存同步后哪份生效不确定。请先在 new-api 让两份一致再保存。`,
            409,
        );
    }
    return {
        groupRatio: parseRatioMap(options[GROUP_RATIO_KEYS[0]], GROUP_RATIO_KEYS[0]),
        ratios,
        mirrored,
        usableGroups: parseUsableGroups(options[USABLE_GROUPS_KEY]),
        special: parseSpecialUsable(options[SPECIAL_USABLE_KEY]),
        raw: {
            [classic]: optionText(options[classic]) ?? '{}',
            [dotted]: optionText(options[dotted]) ?? '{}',
            [SPECIAL_USABLE_KEY]: optionText(options[SPECIAL_USABLE_KEY]) ?? '{}',
        },
    };
}

/** partner-X 不能和真实的计费分组、可用分组重名，否则代理客户会被当成该分组计费。 */
function assertSafePartnerGroup(userGroup: string, live: LiveOptions): void {
    if (Object.hasOwn(live.groupRatio, userGroup) || Object.hasOwn(live.usableGroups, userGroup)) {
        throw new PartnerPricingError(
            `代理分组 ${userGroup} 已出现在 new-api 的分组倍率或可用分组中，请先在 new-api 删除它。`,
            409,
        );
    }
}

interface PlannedWrite {
    key: string;
    value: string;
    matches: (raw: unknown) => boolean;
}

function plannedWrites(live: LiveOptions, plan: PartnerOptionsPlan): PlannedWrite[] {
    const writes: PlannedWrite[] = [];
    const [classic, dotted] = GROUP_GROUP_RATIO_KEYS;
    if (!sameRatioMaps(live.ratios, plan.ratios)) {
        const value = JSON.stringify(plan.ratios);
        writes.push({ key: classic, value, matches: (raw) => sameParsed(() => parseNestedRatioMap(raw, classic), plan.ratios) });
        if (live.mirrored)
            writes.push({ key: dotted, value, matches: (raw) => sameParsed(() => parseNestedRatioMap(raw, dotted), plan.ratios) });
    }
    if (!sameRatioMaps(live.special, plan.special)) {
        writes.push({
            key: SPECIAL_USABLE_KEY,
            value: JSON.stringify(plan.special),
            matches: (raw) => sameParsed(() => parseSpecialUsable(raw), plan.special),
        });
    }
    return writes;
}

function sameParsed(parse: () => unknown, expected: unknown): boolean {
    try {
        return sameRatioMaps(parse(), expected);
    } catch {
        return false;
    }
}

/** 恢复已尝试写过的配置项（失败的写也可能已提交，所以一并恢复）。 */
async function restoreOptions(live: LiveOptions, keys: string[], operation: string): Promise<void> {
    for (const key of [...keys].reverse()) {
        try {
            await assertOptionSyncWritable();
            await putOption(key, live.raw[key], 30_000);
        } catch (err) {
            console.error('[partner-pricing] CRITICAL 恢复 new-api 配置失败，需人工核对', {
                operation,
                option: key,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

/** 写 new-api 并回读。返回恢复函数；任何一步失败都会先恢复再抛错。 */
async function writePartnerOptions(
    live: LiveOptions,
    plan: PartnerOptionsPlan,
    operation: string,
): Promise<() => Promise<void>> {
    const writes = plannedWrites(live, plan);
    const attempted: string[] = [];
    const restore = () => restoreOptions(live, attempted, operation);
    if (!writes.length) return restore;
    try {
        for (const write of writes) {
            // 先记下再发请求：超时的写可能已经在 new-api 生效。
            attempted.push(write.key);
            await putJsonOptionWithReadback({
                key: write.key,
                value: write.value,
                operation: `${operation}:${write.key}`,
                matches: write.matches,
            });
        }
        const after = await getSaleRuleOptions();
        if (writes.some((write) => !write.matches(after[write.key]))) {
            throw new PartnerPricingError('new-api 未按预期保存代理价格，已恢复原值，请核对后重试。', 502);
        }
    } catch (err) {
        await restore();
        throw err;
    }
    return restore;
}

async function loadPartnerRows(tenantId: string): Promise<PartnerPriceRow[]> {
    const rows = await prisma.partnerGroupPrice.findMany({
        where: { tenant_id: tenantId },
        orderBy: { group_key: 'asc' },
        select: { group_key: true, wholesale_ratio: true, retail_ratio: true },
    });
    return rows.map((row) => ({
        group_key: row.group_key,
        wholesale_ratio: Number(row.wholesale_ratio),
        retail_ratio: row.retail_ratio == null ? null : Number(row.retail_ratio),
    }));
}

/** 平台启用中的档次 key → new-api 计费分组。代理只能被开放平台的档次。 */
export async function loadPlatformBillingGroups(): Promise<Map<string, string>> {
    const groups = await prisma.channelGroup.findMany({
        where: { tenant_id: PLATFORM_TENANT_ID, enabled: true },
        select: { key: true, newapi_group: true },
    });
    return new Map(groups.map((group) => [group.key, group.newapi_group]));
}

function planFor(tenantId: string, rows: PartnerPriceRow[], billingGroups: Map<string, string>, live: LiveOptions) {
    return planPartnerOptions({
        userGroup: partnerUserGroup(tenantId),
        retail: openRetailRatios(rows, billingGroups),
        ratios: live.ratios,
        usableGroups: live.usableGroups,
        special: live.special,
    });
}

/**
 * 修改一个代理的价格。change 在定价锁内执行：拿到现有行，校验后返回改动后的全部行和落库步骤。
 * new-api 只在目标值和现值不同时才写；落库失败时恢复 new-api。
 */
export async function changePartnerPricing<T>(args: {
    tenantId: string;
    operation: string;
    change: (context: PartnerPricingContext) => Promise<PartnerPricingChange<T>>;
}): Promise<T> {
    return withOptionSyncLock(async () => {
        const [current, billingGroups, live] = await Promise.all([
            loadPartnerRows(args.tenantId),
            loadPlatformBillingGroups(),
            readLiveOptions(),
        ]);
        assertSafePartnerGroup(partnerUserGroup(args.tenantId), live);
        const { next, persist } = await args.change({ current, billingGroups, groupRatio: live.groupRatio });
        const restore = await writePartnerOptions(live, planFor(args.tenantId, next, billingGroups, live), args.operation);
        try {
            return await persist();
        } catch (err) {
            await restore();
            if (err instanceof PartnerPricingError) throw err;
            console.error('[partner-pricing] Portal 落库失败，已尝试恢复 new-api', {
                operation: args.operation,
                tenantId: args.tenantId,
                error: err instanceof Error ? err.message : String(err),
            });
            throw new PartnerPricingError('Portal 保存失败，已尝试把 new-api 恢复成原值，请核对后重试。', 502);
        }
    });
}

/** 按 Portal 现有价格重写该代理在 new-api 的两行配置。 */
export function resyncPartnerPricing(tenantId: string): Promise<void> {
    return changePartnerPricing({
        tenantId,
        operation: 'partner-resync',
        change: async ({ current }) => ({ next: current, persist: async () => undefined }),
    });
}

const PARTNER_GROUP_PATTERN = /^partner-([0-9a-f]{32})$/;

function tenantIdFromPartnerGroup(group: string): string | null {
    const hex = PARTNER_GROUP_PATTERN.exec(group)?.[1];
    if (!hex) return null;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 平台新增可用分组后，代理客户会看到它。先不持锁比对，只有不一致的代理才持锁重写。
 * 返回重写过的代理租户；单个代理失败只记日志，不影响其他代理。
 */
export async function reconcilePartnerPricing(): Promise<string[]> {
    const live = await readLiveOptions();
    const fromOptions = [...Object.keys(live.ratios), ...Object.keys(live.special)]
        .map(tenantIdFromPartnerGroup)
        .filter((id): id is string => id !== null);
    const priced = await prisma.partnerGroupPrice.findMany({ distinct: ['tenant_id'], select: { tenant_id: true } });
    const candidates = [...new Set([...priced.map((row) => row.tenant_id), ...fromOptions])];
    if (!candidates.length) return [];
    const tenants = await prisma.tenant.findMany({
        where: { id: { in: candidates.filter((id) => id !== PLATFORM_TENANT_ID) } },
        select: { id: true },
    });
    const billingGroups = await loadPlatformBillingGroups();
    const rewritten: string[] = [];
    for (const { id } of tenants) {
        const userGroup = partnerUserGroup(id);
        const plan = planFor(id, await loadPartnerRows(id), billingGroups, live);
        const inSync =
            sameRatioMaps(plan.ratios[userGroup] ?? null, live.ratios[userGroup] ?? null) &&
            sameRatioMaps(plan.special[userGroup] ?? null, live.special[userGroup] ?? null);
        if (inSync) continue;
        try {
            await resyncPartnerPricing(id);
            rewritten.push(id);
        } catch (err) {
            console.error('[partner-pricing] 代理配置对账失败', {
                tenantId: id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return rewritten;
}

/** 该代理已开放（有零售率）的 new-api 计费分组。 */
export async function openPartnerGroups(tenantId: string): Promise<Set<string>> {
    const [rows, billingGroups] = await Promise.all([loadPartnerRows(tenantId), loadPlatformBillingGroups()]);
    return new Set(Object.keys(openRetailRatios(rows, billingGroups)));
}
