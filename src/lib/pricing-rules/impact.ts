/**
 * What a proposed rule change does to effective prices (spec §6): price
 * increases need confirmation, new below-cost prices need a reason, and new
 * block diagnostics refuse the save. Current and proposed rules are compiled at
 * the same instants (now and every future rule boundary), so a future
 * expiry is shown when it is saved, not when it fires.
 */
import { createHash } from 'node:crypto';
import 'server-only';
import type { Diagnostic } from './compile';
import { internalGroupFor } from './options';
import type { PlanInputs, SaleRulePlan } from './plan';
import { evaluateSaleRulePlan } from './publish';
import type { Db, PortalState } from './state';

const MAX_INSTANTS = 40;

export interface PriceChange {
    at: string | null;
    newapiGroup: string;
    userId: string | null;
    before: number | null;
    after: number | null;
    increase: boolean;
}

export interface CostIssue {
    at: string | null;
    newapiGroup: string;
    userId: string | null;
    model: string;
    ratio: number;
    floor: number;
}

export interface SaleRuleImpact {
    changes: PriceChange[];
    increases: PriceChange[];
    belowCost: CostIssue[];
    blocks: Diagnostic[];
    warnings: Diagnostic[];
    /** Users the proposed plan holds back after remote checks (only for a save that names a customer). */
    holds: Diagnostic[];
    hash: string;
}

/** Now plus every future start or end in either rule set. */
export function impactInstants(now: Date, states: PortalState[]): Array<{ at: Date; boundary: boolean }> {
    const boundaries = new Set<number>();
    for (const state of states)
        for (const rule of state.rules)
            for (const edge of [rule.effective_from, rule.effective_to])
                if (edge && edge.getTime() > now.getTime()) boundaries.add(edge.getTime());
    return [
        { at: now, boundary: false },
        ...[...boundaries]
            .sort((left, right) => left - right)
            .slice(0, MAX_INSTANTS)
            .map((time) => ({ at: new Date(time), boundary: true })),
    ];
}

function effective(plan: SaleRulePlan, group: string, userId: string | null): number | null {
    const groupRatio = plan.nextGroupRatio[group] ?? null;
    if (userId === null) return groupRatio;
    return plan.nextRows[internalGroupFor(userId)]?.[group] ?? groupRatio;
}

function subjects(plans: SaleRulePlan[]): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    const add = (group: string, userId: string) => {
        const users = result.get(group) ?? new Set<string>();
        result.set(group, users.add(userId));
    };
    for (const plan of plans) {
        for (const [group, users] of Object.entries(plan.owned)) {
            if (!result.has(group)) result.set(group, new Set());
            for (const userId of users) add(group, userId);
        }
        for (const customer of plan.compile.customers) add(customer.newapiGroup, customer.userId);
    }
    return result;
}
const blockKey = (item: Diagnostic) =>
    [item.code, item.newapiGroup ?? '', item.userId ?? '', item.tierKey ?? '', (item.ruleIds ?? []).join(',')].join(
        '|',
    );

export function impactHash(impact: Omit<SaleRuleImpact, 'hash'>): string {
    const canonical = {
        changes: impact.changes.map((item) => [item.at, item.newapiGroup, item.userId, item.before, item.after]),
        belowCost: impact.belowCost.map((item) => [item.at, item.newapiGroup, item.userId, item.model, item.ratio]),
        blocks: impact.blocks.map(blockKey),
        holds: impact.holds.map(blockKey),
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Compile the current and proposed Portal state at the same instants, without
 * remote customer checks. `at` is null for "now" and an ISO time for a future
 * rule boundary.
 */
export async function compareSaleRules(
    db: Db,
    inputs: PlanInputs,
    proposed: PortalState,
    now: Date,
): Promise<SaleRuleImpact> {
    const changes: PriceChange[] = [];
    const belowCost: CostIssue[] = [];
    const blocks: Diagnostic[] = [];
    const warnings = new Map<string, Diagnostic>();
    for (const { at, boundary } of impactInstants(now, [inputs.state, proposed])) {
        const label = boundary ? at.toISOString() : null;
        const current = await evaluateSaleRulePlan(db, inputs, at, 'never');
        const next = await evaluateSaleRulePlan(db, { ...inputs, state: proposed }, at, 'never');
        for (const [group, users] of subjects([current, next]))
            for (const userId of [null, ...[...users].sort()]) {
                const before = effective(current, group, userId);
                const after = effective(next, group, userId);
                if (before !== after)
                    changes.push({
                        at: label,
                        newapiGroup: group,
                        userId,
                        before,
                        after,
                        increase: (after ?? 0) > (before ?? 0),
                    });
            }
        const known = new Set(
            current.belowCost.map((item) => `${item.newapiGroup}|${item.userId}|${item.model}|${item.ratio}`),
        );
        for (const item of next.belowCost)
            if (!known.has(`${item.newapiGroup}|${item.userId}|${item.model}|${item.ratio}`))
                belowCost.push({ at: label, ...item });
        const existing = new Set(current.diagnostics.filter((item) => item.level === 'block').map(blockKey));
        for (const item of next.diagnostics)
            if (item.level === 'block' && !existing.has(blockKey(item))) blocks.push(item);
            else if (item.level === 'warn' && !boundary) warnings.set(`${item.code}|${blockKey(item)}`, item);
    }
    const unique = [...new Map(blocks.map((item) => [blockKey(item), item])).values()];
    const impact = {
        changes,
        increases: changes.filter((item) => item.increase),
        belowCost,
        blocks: unique,
        warnings: [...warnings.values()],
        holds: [],
    };
    return { ...impact, hash: impactHash(impact) };
}

/** Remote checks for the one customer a save names; a held customer cannot be given a new rule. */
export async function customerHolds(
    db: Db,
    inputs: PlanInputs,
    proposed: PortalState,
    now: Date,
    userId: string,
): Promise<Diagnostic[]> {
    const plan = await evaluateSaleRulePlan(db, { ...inputs, state: proposed }, now, 'always');
    if (!plan.held.includes(userId)) return [];
    const compiled = new Set(plan.compile.diagnostics.map(blockKey));
    return plan.diagnostics.filter(
        (item) => item.level === 'block' && item.userId === userId && !compiled.has(blockKey(item)),
    );
}

export function withHolds(impact: SaleRuleImpact, holds: Diagnostic[]): SaleRuleImpact {
    const next = { ...impact, holds };
    return { ...next, hash: impactHash(next) };
}
