/**
 * Pure compiler: Portal sale rules -> new-api GroupRatio / GroupGroupRatio.
 *
 * Hit order (spec §6): customer_model > global_model/global_tier > customer_tier
 * > unified sale price. One winning discount per request, multiplied onto the
 * billing group's unified sale ratio; layers never multiply each other.
 *
 * new-api's group factor has no model dimension, so a billing group can only be
 * priced with one ratio. When the served models resolve to different factors the
 * group (or customer) is blocked as unrepresentable until it is split (phase 2).
 *
 * Rules are compiled for a publish window [now, now + lead). A rule counts only
 * when it is in force for the whole window: one ending inside the window is
 * dropped before it ends, and one starting later waits for a later publication.
 * Publishing lag therefore never keeps an expired discount or surcharge alive.
 */
import {
    ceilToScale,
    compare,
    equal,
    isOne,
    multiply,
    parseDecimal,
    toDecimalString,
    toNumber,
    type Rational,
} from './decimal';

export const SALE_RULE_KINDS = ['customer_model', 'global_model', 'global_tier', 'customer_tier'] as const;
export type SaleRuleKind = (typeof SALE_RULE_KINDS)[number];

export const DISCOUNT_MIN = '0.05';
export const DISCOUNT_MAX = '2';
const RATIO_SCALE = 6;

export interface SaleRuleInput {
    id: string;
    kind: SaleRuleKind;
    userId: string | null;
    tierKey: string;
    modelId: string | null;
    discount: string;
    effectiveFrom: Date | null;
    effectiveTo: Date | null;
    enabled: boolean;
}

export interface BillingGroupInput {
    tierKey: string;
    newapiGroup: string;
    /** null = not managed by the compiler. */
    unifiedSaleRatio: string | null;
    /** Model names served by the group's enabled channels (what clients send). */
    servedModels: string[];
}

export interface CatalogModelInput {
    id: string;
    /** tierKey -> model name new-api bills (the client-facing name). */
    upstreamByTier: Record<string, string>;
}

export interface CompileInput {
    rules: SaleRuleInput[];
    groups: BillingGroupInput[];
    catalog: CatalogModelInput[];
    /** Model names with new-api scheduled_discount enabled. */
    scheduledDiscountModels: string[];
    /** newapiGroup -> user ids that currently have a compiler-managed row. */
    managedRowUsers: Record<string, string[]>;
    /** Users still holding unconverted legacy multipliers: never compiled. */
    excludedUserIds: string[];
    now: Date;
    leadMs: number;
}

export type DiagnosticLevel = 'block' | 'warn';

export interface Diagnostic {
    level: DiagnosticLevel;
    code: string;
    message: string;
    newapiGroup?: string;
    tierKey?: string;
    userId?: string;
    ruleIds?: string[];
}

export interface FactorSource {
    factor: string;
    ruleId: string | null;
    kind: SaleRuleKind | null;
}

export interface GroupExplanation {
    tierKey: string;
    unifiedSaleRatio: string;
    source: FactorSource | null;
    targetRatio: number | null;
    blocked: boolean;
}

export interface CustomerExplanation {
    userId: string;
    newapiGroup: string;
    source: FactorSource | null;
    /** null = follows the group ratio (no row). */
    ratio: number | null;
    blocked: boolean;
}

export interface CompileOutput {
    /** Managed, unblocked groups: the compiler owns their GroupRatio entry and customer rows. */
    ownedGroups: string[];
    groupRatios: Record<string, number>;
    /** newapiGroup -> userId -> ratio. Absent user = no row. */
    customerRows: Record<string, Record<string, number>>;
    /** newapiGroup -> users whose existing rows must be left untouched. */
    blockedCustomers: Record<string, string[]>;
    diagnostics: Diagnostic[];
    groups: Record<string, GroupExplanation>;
    customers: CustomerExplanation[];
}

interface Pick {
    value: Rational;
    rule: SaleRuleInput | null;
}

interface CustomerOutcome {
    blocked: boolean;
    pick: Pick | null;
}

interface GroupOutcome {
    blocked: boolean;
    pick: Pick | null;
    customers: Map<string, CustomerOutcome>;
}

interface TierIndex {
    tier: SaleRuleInput | null;
    model: Map<string, SaleRuleInput>;
    customerTier: Map<string, SaleRuleInput>;
    customerModel: Map<string, SaleRuleInput>;
    blocked: boolean;
    blockedUsers: Set<string>;
}

const NEUTRAL: Rational = { n: BigInt(1), d: BigInt(1) };
const MIN = parseDecimal(DISCOUNT_MIN);
const MAX = parseDecimal(DISCOUNT_MAX);

class Diagnostics {
    private readonly items = new Map<string, Diagnostic>();

    add(item: Diagnostic) {
        const key = [
            item.level,
            item.code,
            item.newapiGroup ?? '',
            item.tierKey ?? '',
            item.userId ?? '',
            (item.ruleIds ?? []).join(','),
        ].join('|');
        if (!this.items.has(key)) this.items.set(key, item);
    }

    list(): Diagnostic[] {
        return [...this.items.values()];
    }
}

export function ruleActiveAt(rule: SaleRuleInput, at: Date): boolean {
    if (!rule.enabled) return false;
    if (rule.effectiveFrom && rule.effectiveFrom.getTime() > at.getTime()) return false;
    if (rule.effectiveTo && rule.effectiveTo.getTime() <= at.getTime()) return false;
    return true;
}

/** In force for the whole window [from, until): already started and not ending inside it. */
export function ruleValidThrough(rule: SaleRuleInput, from: Date, until: Date): boolean {
    if (!ruleActiveAt(rule, from)) return false;
    return !rule.effectiveTo || rule.effectiveTo.getTime() > until.getTime();
}

/** Shape problems that make a rule unusable. Also used for save-time validation. */
export function ruleProblems(rule: SaleRuleInput): string[] {
    const problems: string[] = [];
    if (!SALE_RULE_KINDS.includes(rule.kind)) problems.push('未知的规则类型');
    let discount: Rational | null = null;
    try {
        discount = parseDecimal(rule.discount);
    } catch {
        problems.push('折扣不是有效数字');
    }
    if (discount && (compare(discount, MIN) < 0 || compare(discount, MAX) > 0))
        problems.push(`折扣须在 ${DISCOUNT_MIN} 至 ${DISCOUNT_MAX} 之间`);
    const needsModel = rule.kind === 'customer_model' || rule.kind === 'global_model';
    const needsUser = rule.kind === 'customer_model' || rule.kind === 'customer_tier';
    if (needsModel !== !!rule.modelId) problems.push(needsModel ? '缺少模型' : '不应指定模型');
    if (needsUser !== !!rule.userId) problems.push(needsUser ? '缺少客户' : '不应指定客户');
    if (!rule.tierKey.trim()) problems.push('缺少档次');
    if (rule.effectiveFrom && rule.effectiveTo && rule.effectiveTo.getTime() <= rule.effectiveFrom.getTime())
        problems.push('到期时间须晚于生效时间');
    return problems;
}
function emptyIndex(): TierIndex {
    return {
        tier: null,
        model: new Map(),
        customerTier: new Map(),
        customerModel: new Map(),
        blocked: false,
        blockedUsers: new Set(),
    };
}

/** Rules in force per tier for the publish window. Same-layer, same-specificity overlaps block. */
function buildIndex(rules: SaleRuleInput[], from: Date, until: Date, diagnostics: Diagnostics): Map<string, TierIndex> {
    const index = new Map<string, TierIndex>();
    const tierOf = (key: string) => {
        let entry = index.get(key);
        if (!entry) index.set(key, (entry = emptyIndex()));
        return entry;
    };
    for (const rule of rules) {
        if (!rule.enabled) continue;
        const problems = ruleProblems(rule);
        if (problems.length) {
            const entry = tierOf(rule.tierKey);
            if (rule.userId) entry.blockedUsers.add(rule.userId);
            else entry.blocked = true;
            diagnostics.add({
                level: 'block',
                code: 'rule_invalid',
                message: `规则无效：${problems.join('；')}`,
                tierKey: rule.tierKey,
                userId: rule.userId ?? undefined,
                ruleIds: [rule.id],
            });
            continue;
        }
        if (!ruleValidThrough(rule, from, until)) continue;
        const entry = tierOf(rule.tierKey);
        const conflict = (existing: SaleRuleInput | undefined | null) => {
            if (!existing) return false;
            diagnostics.add({
                level: 'block',
                code: 'rule_conflict',
                message: '同一层有两条同样具体的生效规则，请停用其中一条。',
                tierKey: rule.tierKey,
                userId: rule.userId ?? undefined,
                ruleIds: [existing.id, rule.id].sort(),
            });
            return true;
        };
        if (rule.kind === 'global_tier') {
            if (conflict(entry.tier)) entry.blocked = true;
            else entry.tier = rule;
        } else if (rule.kind === 'global_model') {
            if (conflict(entry.model.get(rule.modelId!))) entry.blocked = true;
            else entry.model.set(rule.modelId!, rule);
        } else if (rule.kind === 'customer_tier') {
            if (conflict(entry.customerTier.get(rule.userId!))) entry.blockedUsers.add(rule.userId!);
            else entry.customerTier.set(rule.userId!, rule);
        } else {
            const key = `${rule.userId}:${rule.modelId}`;
            if (conflict(entry.customerModel.get(key))) entry.blockedUsers.add(rule.userId!);
            else entry.customerModel.set(key, rule);
        }
    }
    return index;
}

/** tierKey -> served model name -> catalog model ids billed under that name. */
function tierCatalog(catalog: CatalogModelInput[]): Map<string, Map<string, string[]>> {
    const result = new Map<string, Map<string, string[]>>();
    for (const model of catalog) {
        for (const [tierKey, name] of Object.entries(model.upstreamByTier)) {
            let names = result.get(tierKey);
            if (!names) result.set(tierKey, (names = new Map()));
            const ids = names.get(name) ?? [];
            ids.push(model.id);
            names.set(name, ids);
        }
    }
    return result;
}
function ruleValue(rule: SaleRuleInput): Rational {
    return parseDecimal(rule.discount);
}

/** All picks must agree on the value; otherwise the request cannot be priced with one ratio. */
function uniformPick(picks: Pick[]): Pick | null {
    if (!picks.length) return null;
    const first = picks[0];
    return picks.every((pick) => equal(pick.value, first.value)) ? first : null;
}

/** Global layer for one catalog model id (or a served name with no catalog entry). */
function globalPickFor(index: TierIndex | undefined, catalogId: string | null): Pick | null {
    if (!index) return null;
    const specific = catalogId ? index.model.get(catalogId) : undefined;
    const rule = specific ?? index.tier;
    return rule ? { value: ruleValue(rule), rule } : null;
}

function catalogIdsFor(names: Map<string, string[]> | undefined, name: string | null): Array<string | null> {
    if (name === null) return [null];
    const ids = names?.get(name);
    return ids?.length ? ids : [null];
}

function servedOrTier(servedModels: string[]): Array<string | null> {
    return servedModels.length ? servedModels : [null];
}

/** Group factor: global rule or neutral. null = served names disagree. */
function groupPick(
    index: TierIndex | undefined,
    names: Map<string, string[]> | undefined,
    servedModels: string[],
): { pick: Pick | null; alias: boolean } {
    const perName: Pick[] = [];
    for (const name of servedOrTier(servedModels)) {
        const aliases = catalogIdsFor(names, name).map(
            (catalogId) => globalPickFor(index, catalogId) ?? { value: NEUTRAL, rule: null },
        );
        const pick = uniformPick(aliases);
        if (!pick) return { pick: null, alias: true };
        perName.push(pick);
    }
    return { pick: uniformPick(perName), alias: false };
}

/** Customer factor: customer_model > global > customer_tier > neutral. */
function customerPick(
    index: TierIndex | undefined,
    names: Map<string, string[]> | undefined,
    servedModels: string[],
    userId: string,
): { pick: Pick | null; alias: boolean } {
    const perName: Pick[] = [];
    const tierRule = index?.customerTier.get(userId) ?? null;
    for (const name of servedOrTier(servedModels)) {
        const aliases = catalogIdsFor(names, name).map((catalogId): Pick => {
            const own = catalogId ? index?.customerModel.get(`${userId}:${catalogId}`) : undefined;
            if (own) return { value: ruleValue(own), rule: own };
            const global = globalPickFor(index, catalogId);
            if (global) return global;
            if (tierRule) return { value: ruleValue(tierRule), rule: tierRule };
            return { value: NEUTRAL, rule: null };
        });
        const pick = uniformPick(aliases);
        if (!pick) return { pick: null, alias: true };
        perName.push(pick);
    }
    return { pick: uniformPick(perName), alias: false };
}
interface InstantContext {
    index: Map<string, TierIndex>;
    catalog: Map<string, Map<string, string[]>>;
    scheduled: Set<string>;
    managedRowUsers: Record<string, string[]>;
    excluded: Set<string>;
    diagnostics: Diagnostics;
}

function usersFor(index: TierIndex | undefined, managed: string[]): Set<string> {
    const users = new Set(managed);
    if (!index) return users;
    for (const userId of index.customerTier.keys()) users.add(userId);
    for (const key of index.customerModel.keys()) users.add(key.slice(0, key.indexOf(':')));
    for (const userId of index.blockedUsers) users.add(userId);
    return users;
}

function evaluateGroup(group: BillingGroupInput, ctx: InstantContext): GroupOutcome {
    const outcome: GroupOutcome = { blocked: false, pick: null, customers: new Map() };
    const index = ctx.index.get(group.tierKey);
    const names = ctx.catalog.get(group.tierKey);
    if (index?.blocked) {
        outcome.blocked = true;
        return outcome;
    }
    const where = { newapiGroup: group.newapiGroup, tierKey: group.tierKey };
    const global = groupPick(index, names, group.servedModels);
    if (!global.pick) {
        ctx.diagnostics.add({
            level: 'block',
            code: global.alias ? 'alias_conflict' : 'group_unrepresentable',
            message: global.alias
                ? '多个目录模型按同一模型名计费但折扣不同，请统一或删除其中一条规则。'
                : '该计费分组内各模型的全局折扣不同，无法用一个分组倍率表达，请先拆分计费分组。',
            ...where,
        });
        outcome.blocked = true;
        return outcome;
    }
    const scheduled = group.servedModels.filter((name) => ctx.scheduled.has(name));
    if (scheduled.length && !isOne(global.pick.value)) {
        ctx.diagnostics.add({
            level: 'block',
            code: 'scheduled_discount_conflict',
            message: `模型 ${scheduled.join('、')} 开启了 new-api 限时折扣，会与全局售卖折扣相乘，请先关闭其中之一。`,
            ...where,
            ruleIds: global.pick.rule ? [global.pick.rule.id] : undefined,
        });
        outcome.blocked = true;
        return outcome;
    }
    outcome.pick = global.pick;

    for (const userId of usersFor(index, ctx.managedRowUsers[group.newapiGroup] ?? [])) {
        if (ctx.excluded.has(userId)) {
            ctx.diagnostics.add({
                level: 'warn',
                code: 'legacy_multiplier',
                message: '该客户仍有未转换的旧专属倍率，暂不按售卖规则编译。',
                ...where,
                userId,
            });
            outcome.customers.set(userId, { blocked: true, pick: null });
            continue;
        }
        if (index?.blockedUsers.has(userId)) {
            outcome.customers.set(userId, { blocked: true, pick: null });
            continue;
        }
        const own = customerPick(index, names, group.servedModels, userId);
        if (!own.pick) {
            ctx.diagnostics.add({
                level: 'block',
                code: own.alias ? 'alias_conflict' : 'customer_unrepresentable',
                message: own.alias
                    ? '多个目录模型按同一模型名计费但该客户折扣不同。'
                    : '该客户在此计费分组内各模型的折扣不同，无法用一个专属倍率表达，请先拆分计费分组。',
                ...where,
                userId,
            });
            outcome.customers.set(userId, { blocked: true, pick: null });
            continue;
        }
        if (scheduled.length && !isOne(own.pick.value)) {
            ctx.diagnostics.add({
                level: 'block',
                code: 'scheduled_discount_conflict',
                message: `模型 ${scheduled.join('、')} 开启了 new-api 限时折扣，会与客户折扣相乘，请先关闭其中之一。`,
                ...where,
                userId,
                ruleIds: own.pick.rule ? [own.pick.rule.id] : undefined,
            });
            outcome.customers.set(userId, { blocked: true, pick: null });
            continue;
        }
        outcome.customers.set(userId, { blocked: false, pick: own.pick });
    }
    return outcome;
}
function scaledRatio(unified: Rational, factor: Rational): Rational {
    return isOne(factor) ? unified : ceilToScale(multiply(unified, factor), RATIO_SCALE);
}

function source(pick: Pick | null): FactorSource | null {
    if (!pick) return null;
    return { factor: toDecimalString(pick.value), ruleId: pick.rule?.id ?? null, kind: pick.rule?.kind ?? null };
}

function servedNamesByTier(groups: BillingGroupInput[]): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const group of groups) {
        const names = result.get(group.tierKey) ?? new Set<string>();
        for (const name of group.servedModels) names.add(name);
        result.set(group.tierKey, names);
    }
    return result;
}

export function compileSaleRules(input: CompileInput): CompileOutput {
    const diagnostics = new Diagnostics();
    const catalog = tierCatalog(input.catalog);
    const excluded = new Set(input.excludedUserIds);
    const scheduled = new Set(input.scheduledDiscountModels);
    const until = new Date(input.now.getTime() + Math.max(0, input.leadMs));
    const ctx: InstantContext = {
        index: buildIndex(input.rules, input.now, until, diagnostics),
        catalog,
        scheduled,
        managedRowUsers: input.managedRowUsers,
        excluded,
        diagnostics,
    };
    const output: CompileOutput = {
        ownedGroups: [],
        groupRatios: {},
        customerRows: {},
        blockedCustomers: {},
        diagnostics: [],
        groups: {},
        customers: [],
    };

    const managedTiers = new Set<string>();
    for (const group of input.groups) {
        if (group.unifiedSaleRatio === null) continue;
        managedTiers.add(group.tierKey);
        const unified = parseDecimal(group.unifiedSaleRatio);
        const outcome = evaluateGroup(group, ctx);
        const explanation: GroupExplanation = {
            tierKey: group.tierKey,
            unifiedSaleRatio: toDecimalString(unified),
            source: source(outcome.pick),
            targetRatio: null,
            blocked: outcome.blocked,
        };
        output.groups[group.newapiGroup] = explanation;
        if (outcome.blocked || !outcome.pick) continue;

        const groupTarget = scaledRatio(unified, outcome.pick.value);
        explanation.targetRatio = toNumber(groupTarget);
        output.ownedGroups.push(group.newapiGroup);
        output.groupRatios[group.newapiGroup] = toNumber(groupTarget);

        const rows: Record<string, number> = {};
        const blockedUsers: string[] = [];
        for (const userId of [...outcome.customers.keys()].sort()) {
            const customer = outcome.customers.get(userId)!;
            let ratio: number | null = null;
            if (customer.blocked) blockedUsers.push(userId);
            else {
                const target = scaledRatio(unified, (customer.pick ?? outcome.pick).value);
                if (!equal(target, groupTarget)) {
                    ratio = toNumber(target);
                    rows[userId] = ratio;
                }
            }
            output.customers.push({
                userId,
                newapiGroup: group.newapiGroup,
                source: source(customer.pick),
                ratio,
                blocked: customer.blocked,
            });
        }
        output.customerRows[group.newapiGroup] = rows;
        output.blockedCustomers[group.newapiGroup] = blockedUsers;
    }

    const served = servedNamesByTier(input.groups);
    for (const rule of input.rules) {
        if (!rule.enabled) continue;
        if (!managedTiers.has(rule.tierKey)) {
            diagnostics.add({
                level: 'warn',
                code: 'tier_unmanaged',
                message: '该档次的计费分组尚未纳管，规则不会生效。',
                tierKey: rule.tierKey,
                ruleIds: [rule.id],
            });
            continue;
        }
        if (!rule.modelId) continue;
        const tierNames = catalog.get(rule.tierKey);
        const servedNames = served.get(rule.tierKey) ?? new Set<string>();
        const billed = [...(tierNames?.entries() ?? [])].some(
            ([name, ids]) => ids.includes(rule.modelId!) && servedNames.has(name),
        );
        if (!billed)
            diagnostics.add({
                level: 'warn',
                code: 'model_not_served',
                message: '该模型不在此档次的计费分组服务范围内，规则不会生效。',
                tierKey: rule.tierKey,
                ruleIds: [rule.id],
            });
    }

    output.diagnostics = diagnostics.list();
    return output;
}
