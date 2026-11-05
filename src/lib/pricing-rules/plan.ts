/**
 * Pure planning for the sale-rule publisher: which pairs it owns, what the
 * final ratios are, the order of remote writes and the Portal mirror rows.
 */
import { createHash } from 'node:crypto';
import { compileSaleRules, type CompileOutput, type Diagnostic } from './compile';
import { costFloor } from './cost-floor';
import {
    internalGroupFor,
    mergeGroupRatio,
    parseLiveSaleOptions,
    sameRatioMaps,
    type LiveSaleOptions,
    type NestedRatioMap,
    type RatioChange,
    type RatioMap,
} from './options';
import {
    buildCompileInput,
    presentable,
    servedModelsByGroup,
    tenantOf,
    upstreamByTier,
    type PortalState,
} from './state';

const FLOOR_EPSILON = 1e-9;

export type PublishTrigger = 'manual' | 'scheduler' | 'rule_save' | 'tier_save' | 'adopt';

export interface PublishActor {
    userId: string | null;
    email: string | null;
    viaBreakGlass: boolean;
    /** Audit level: super, secondary or break_glass. */
    level: 'super' | 'secondary' | 'break_glass';
    ip: string | null;
    userAgent: string | null;
    path: string;
}

export interface UserMove {
    userId: string;
    newapiUserId: number;
    from: string;
    to: string;
    direction: 'in' | 'out';
}

export interface BelowCost {
    newapiGroup: string;
    userId: string | null;
    model: string;
    ratio: number;
    floor: number;
}

export type OptionFamily = 'group_group_ratio' | 'group_ratio';

export type WriteStep =
    | { kind: 'option'; family: OptionFamily; value: RatioMap | NestedRatioMap; label: string }
    | { kind: 'move'; move: UserMove };

export type MirrorOp =
    | {
          kind: 'upsert';
          userId: string;
          tierKey: string;
          newapiGroup: string;
          internalGroup: string;
          originalGroup: string;
          ratio: number;
      }
    | { kind: 'disable'; userId: string; tierKey: string };

export interface SaleRulePlan {
    now: Date;
    compile: CompileOutput;
    /** newapiGroup -> users whose rows the publisher rewrites. */
    owned: Record<string, string[]>;
    liveGroupRatio: RatioMap;
    nextGroupRatio: RatioMap;
    liveRows: NestedRatioMap;
    nextRows: NestedRatioMap;
    changes: RatioChange[];
    moves: UserMove[];
    /** Users skipped by remote checks; their existing rows stay as they are. */
    held: string[];
    belowCost: BelowCost[];
    diagnostics: Diagnostic[];
    steps: WriteStep[];
    mirror: MirrorOp[];
    /** Remote checks ran (customer groups, keys, per-user overrides). Only resolved plans may be applied. */
    resolved: boolean;
    blocked: boolean;
    hash: string;
}
export function ownedPairs(output: CompileOutput, groups: Set<string>, held: Set<string>): Record<string, string[]> {
    const owned: Record<string, string[]> = {};
    for (const group of output.ownedGroups) if (groups.has(group)) owned[group] = [];
    for (const customer of output.customers)
        if (!customer.blocked && !held.has(customer.userId) && owned[customer.newapiGroup])
            owned[customer.newapiGroup].push(customer.userId);
    return owned;
}

export function planHash(args: {
    owned: Record<string, string[]>;
    liveGroupRatio: RatioMap;
    nextGroupRatio: RatioMap;
    liveRows: NestedRatioMap;
    nextRows: NestedRatioMap;
    moves: UserMove[];
    held: string[];
    blocked: boolean;
}): string {
    const groups = Object.keys(args.owned).sort();
    const pairs = (rows: NestedRatioMap) =>
        groups.map((group) => [
            group,
            [...args.owned[group]].sort().map((userId) => [userId, rows[internalGroupFor(userId)]?.[group] ?? null]),
        ]);
    const canonical = {
        groups: groups.map((group) => [group, args.liveGroupRatio[group] ?? null, args.nextGroupRatio[group] ?? null]),
        live: pairs(args.liveRows),
        next: pairs(args.nextRows),
        moves: [...args.moves]
            .sort((left, right) => left.userId.localeCompare(right.userId))
            .map((move) => [move.userId, move.from, move.to]),
        held: [...args.held].sort(),
        blocked: args.blocked,
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
/** Final ratios (group and customer rows) priced below a model's recorded purchasing cost. */
export function belowCostItems(args: {
    state: PortalState;
    owned: Record<string, string[]>;
    nextGroupRatio: RatioMap;
    nextRows: NestedRatioMap;
    served: Record<string, string[]>;
    options: Record<string, unknown>;
}): BelowCost[] {
    const items: BelowCost[] = [];
    const costs = new Map(args.state.costRules.map((rule) => [`${rule.model_id}|${rule.tier}`, rule.config]));
    const catalog = args.state.catalog.map((model) => ({ model, names: upstreamByTier(model.upstream_map) }));
    for (const meta of args.state.groups) {
        const users = args.owned[meta.newapi_group];
        if (!users) continue;
        const ratios: Array<{ userId: string | null; ratio: number | undefined }> = [
            { userId: null, ratio: args.nextGroupRatio[meta.newapi_group] },
            ...users.map((userId) => ({ userId, ratio: args.nextRows[internalGroupFor(userId)]?.[meta.newapi_group] })),
        ];
        const served = new Set(args.served[meta.newapi_group] ?? []);
        for (const { model, names } of catalog) {
            if (tenantOf(model.tenant_id) !== tenantOf(meta.tenant_id)) continue;
            const name = names[meta.tier_key];
            if (!name || !served.has(name)) continue;
            const config = costs.get(`${model.id}|${meta.tier_key}`);
            if (config === undefined) continue;
            const { floor } = costFloor(config, name, args.options);
            if (floor === null) continue;
            for (const { userId, ratio } of ratios)
                if (ratio !== undefined && ratio + FLOOR_EPSILON < floor)
                    items.push({ newapiGroup: meta.newapi_group, userId, model: name, ratio, floor });
        }
    }
    return items;
}
/** Portal mirror rows (user_tier_multipliers, managed_by_rules) that differ from the planned rows. */
export function mirrorOps(
    state: PortalState,
    owned: Record<string, string[]>,
    nextRows: NestedRatioMap,
    originals: Record<string, string>,
): MirrorOp[] {
    const tierOf = new Map(state.groups.map((group) => [group.newapi_group, group.tier_key]));
    const ops: MirrorOp[] = [];
    for (const [group, users] of Object.entries(owned)) {
        const tierKey = tierOf.get(group);
        if (!tierKey) continue;
        for (const userId of users) {
            const ratio = nextRows[internalGroupFor(userId)]?.[group];
            const row = state.multipliers.find((item) => item.user_id === userId && item.tier_key === tierKey);
            if (ratio === undefined) {
                if (row?.enabled && row.managed_by_rules) ops.push({ kind: 'disable', userId, tierKey });
                continue;
            }
            const internalGroup = internalGroupFor(userId);
            const originalGroup = originals[userId] ?? row?.original_newapi_user_group ?? '';
            const current =
                !!row?.enabled &&
                row.managed_by_rules &&
                row.newapi_billing_group === group &&
                row.newapi_user_group === internalGroup &&
                row.original_newapi_user_group === originalGroup &&
                Number(row.multiplier) === ratio;
            if (!current)
                ops.push({ kind: 'upsert', userId, tierKey, newapiGroup: group, internalGroup, originalGroup, ratio });
        }
    }
    return ops;
}
/**
 * Ordered remote writes. Each customer's price changes at most once:
 * 1. GroupGroupRatio staged: new rows land, rows being removed stay while the
 *    group ratio still has its old value (they still match the old price).
 * 2. Users move into their internal group (their rows are already in place).
 * 3. GroupRatio.
 * 4. Users move back out (no rows left for them).
 * 5. GroupGroupRatio final: drop the rows kept in step 1.
 */
export function writeSteps(args: {
    liveGroupRatio: RatioMap;
    nextGroupRatio: RatioMap;
    liveRows: NestedRatioMap;
    nextRows: NestedRatioMap;
    owned: Record<string, string[]>;
    moves: UserMove[];
}): WriteStep[] {
    const ratioChanged = !sameRatioMaps(args.liveGroupRatio, args.nextGroupRatio);
    const staged: NestedRatioMap = Object.fromEntries(
        Object.entries(args.nextRows).map(([group, inner]) => [group, { ...inner }]),
    );
    if (ratioChanged)
        for (const [group, users] of Object.entries(args.owned))
            for (const userId of users) {
                const internal = internalGroupFor(userId);
                const kept = args.liveRows[internal]?.[group];
                if (kept !== undefined && staged[internal]?.[group] === undefined)
                    (staged[internal] ??= {})[group] = kept;
            }
    const steps: WriteStep[] = [];
    if (!sameRatioMaps(staged, args.liveRows))
        steps.push({ kind: 'option', family: 'group_group_ratio', value: staged, label: 'stage_rows' });
    for (const move of args.moves) if (move.direction === 'in') steps.push({ kind: 'move', move });
    if (ratioChanged)
        steps.push({ kind: 'option', family: 'group_ratio', value: args.nextGroupRatio, label: 'group_ratio' });
    for (const move of args.moves) if (move.direction === 'out') steps.push({ kind: 'move', move });
    if (!sameRatioMaps(args.nextRows, staged))
        steps.push({ kind: 'option', family: 'group_group_ratio', value: args.nextRows, label: 'final_rows' });
    return steps;
}

export type ResolveMode = 'never' | 'auto' | 'always';

export interface PlanInputs {
    state: PortalState;
    options: Record<string, unknown>;
    channels: Array<Record<string, unknown>>;
}

export interface Draft {
    compile: CompileOutput;
    live: LiveSaleOptions;
    served: Record<string, string[]>;
    groups: Set<string>;
    nextGroupRatio: RatioMap;
    diagnostics: Diagnostic[];
    blocked: boolean;
}

export function draftPlan(inputs: PlanInputs, now: Date): Draft {
    const live = parseLiveSaleOptions(inputs.options);
    const served = servedModelsByGroup(inputs.channels);
    const compile = presentable(compileSaleRules(buildCompileInput(inputs.state, live, served, now)));
    const diagnostics: Diagnostic[] = [...compile.diagnostics];
    let blocked = false;
    for (const item of live.diagnostics) {
        if (item.code !== 'dual_key_diverged') diagnostics.push(item);
        else {
            blocked = true;
            diagnostics.push({
                ...item,
                level: 'block',
                message: `${item.message}请先在 new-api 让两份一致，再发布。`,
            });
        }
    }
    const groups = new Set<string>();
    const targets: Record<string, number> = {};
    for (const group of compile.ownedGroups) {
        if (Object.hasOwn(live.groupRatio, group)) {
            groups.add(group);
            targets[group] = compile.groupRatios[group];
        } else
            diagnostics.push({
                level: 'block',
                code: 'group_missing',
                message: 'new-api 的分组倍率中没有该计费分组，不会自动创建。',
                newapiGroup: group,
            });
    }
    return {
        compile,
        live,
        served,
        groups,
        nextGroupRatio: mergeGroupRatio(live.groupRatio, targets),
        diagnostics,
        blocked,
    };
}
