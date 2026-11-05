/**
 * Portal-side inputs of the sale-rule compiler: billing groups, rules, catalog,
 * cost rules and the user_tier_multipliers mirror. Pure apart from loading.
 */
import type { Prisma } from '@prisma/client';
import type { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import type { CompileInput, CompileOutput, SaleRuleKind } from './compile';
import { liveInternalUsers, type LiveSaleOptions } from './options';

/** Publish window: a rule ending within this long is dropped now (spec §6, §11.2 c6). */
export const SALE_RULE_LEAD_MS = 2 * 60_000;

export type Db = Prisma.TransactionClient | typeof prisma;

export interface PortalState {
    groups: Array<{
        tenant_id: string | null;
        tier_key: string;
        newapi_group: string;
        unified_sale_ratio: Prisma.Decimal | null;
    }>;
    rules: Array<{
        id: string;
        tenant_id: string | null;
        kind: string;
        user_id: string | null;
        tier_key: string;
        model_id: string | null;
        discount: Prisma.Decimal;
        effective_from: Date | null;
        effective_to: Date | null;
        enabled: boolean;
    }>;
    catalog: Array<{ id: string; tenant_id: string | null; upstream_map: Prisma.JsonValue }>;
    costRules: Array<{ model_id: string; tier: string; config: Prisma.JsonValue }>;
    multipliers: Array<{
        id: string;
        user_id: string;
        tier_key: string;
        newapi_billing_group: string;
        newapi_user_group: string;
        original_newapi_user_group: string;
        multiplier: Prisma.Decimal;
        enabled: boolean;
        managed_by_rules: boolean;
        updated_at: Date;
    }>;
}

export async function loadPortalState(db: Db): Promise<PortalState> {
    const [groups, rules, catalog, costRules, multipliers] = await Promise.all([
        db.pricingBillingGroup.findMany({
            select: { tenant_id: true, tier_key: true, newapi_group: true, unified_sale_ratio: true },
        }),
        db.pricingSaleRule.findMany({
            where: { enabled: true },
            select: {
                id: true,
                tenant_id: true,
                kind: true,
                user_id: true,
                tier_key: true,
                model_id: true,
                discount: true,
                effective_from: true,
                effective_to: true,
                enabled: true,
            },
        }),
        db.catalogModel.findMany({
            where: { enabled: true },
            select: { id: true, tenant_id: true, upstream_map: true },
        }),
        db.pricingCostRule.findMany({ select: { model_id: true, tier: true, config: true } }),
        db.userTierMultiplier.findMany({
            select: {
                id: true,
                user_id: true,
                tier_key: true,
                newapi_billing_group: true,
                newapi_user_group: true,
                original_newapi_user_group: true,
                multiplier: true,
                enabled: true,
                managed_by_rules: true,
                updated_at: true,
            },
        }),
    ]);
    return { groups, rules, catalog, costRules, multipliers };
}
export const tenantOf = (tenantId: string | null) => tenantId ?? PLATFORM_TENANT_ID;
const scoped = (tenantId: string | null, tierKey: string) => `${tenantOf(tenantId)}|${tierKey}`;
const unscope = (key: string | undefined) => (key && key.includes('|') ? key.slice(key.indexOf('|') + 1) : key);

function splitList(value: unknown): string[] {
    return typeof value === 'string'
        ? [
              ...new Set(
                  value
                      .split(',')
                      .map((item) => item.trim())
                      .filter(Boolean),
              ),
          ]
        : [];
}

/**
 * Model names each new-api group can route, from every channel listing the
 * group. Disabled channels are included: new-api may re-enable them, and a
 * discount must never silently spread to a model that comes back.
 */
export function servedModelsByGroup(channels: Array<Record<string, unknown>>): Record<string, string[]> {
    const result: Record<string, Set<string>> = {};
    for (const channel of channels) {
        const models = splitList(channel.models);
        for (const group of splitList(channel.group)) {
            const names = (result[group] ??= new Set());
            for (const model of models) names.add(model);
        }
    }
    return Object.fromEntries(Object.entries(result).map(([group, names]) => [group, [...names].sort()]));
}

function decimalText(value: Prisma.Decimal): string {
    return value.toFixed();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Client-facing model name per (unscoped) tier key, from catalog upstream_map. */
export function upstreamByTier(map: Prisma.JsonValue): Record<string, string> {
    const result: Record<string, string> = {};
    if (!isRecord(map)) return result;
    for (const [tier, entry] of Object.entries(map)) {
        const name = isRecord(entry) ? entry.upstream_model : undefined;
        if (typeof name === 'string' && name.trim()) result[tier] = name;
    }
    return result;
}

export function buildCompileInput(
    state: PortalState,
    live: LiveSaleOptions,
    served: Record<string, string[]>,
    now: Date,
): CompileInput {
    const managedGroups = state.groups.filter((group) => group.unified_sale_ratio !== null);
    const managed = new Set(managedGroups.map((group) => group.newapi_group));
    const managedTiers = new Set(managedGroups.map((group) => group.tier_key));
    const liveUsers = liveInternalUsers(live.groupGroupRatio, [...managed]);
    const managedRowUsers: Record<string, string[]> = {};
    for (const group of managed) {
        const users = new Set(liveUsers[group] ?? []);
        for (const row of state.multipliers)
            if (row.enabled && row.managed_by_rules && row.newapi_billing_group === group) users.add(row.user_id);
        managedRowUsers[group] = [...users].sort();
    }
    // A hand-made multiplier on a managed group (or on a managed tier whose
    // group drifted) is never rewritten until it is converted.
    const excludedUserIds = [
        ...new Set(
            state.multipliers
                .filter(
                    (row) =>
                        row.enabled &&
                        !row.managed_by_rules &&
                        (managed.has(row.newapi_billing_group) || managedTiers.has(row.tier_key)),
                )
                .map((row) => row.user_id),
        ),
    ].sort();
    return {
        rules: state.rules.map((rule) => ({
            id: rule.id,
            kind: rule.kind as SaleRuleKind,
            userId: rule.user_id,
            tierKey: scoped(rule.tenant_id, rule.tier_key),
            modelId: rule.model_id,
            discount: decimalText(rule.discount),
            effectiveFrom: rule.effective_from,
            effectiveTo: rule.effective_to,
            enabled: rule.enabled,
        })),
        groups: state.groups.map((group) => ({
            tierKey: scoped(group.tenant_id, group.tier_key),
            newapiGroup: group.newapi_group,
            unifiedSaleRatio: group.unified_sale_ratio === null ? null : decimalText(group.unified_sale_ratio),
            servedModels: served[group.newapi_group] ?? [],
        })),
        catalog: state.catalog.map((model) => ({
            id: model.id,
            upstreamByTier: Object.fromEntries(
                Object.entries(upstreamByTier(model.upstream_map)).map(([tier, name]) => [
                    scoped(model.tenant_id, tier),
                    name,
                ]),
            ),
        })),
        scheduledDiscountModels: live.scheduledModels,
        managedRowUsers,
        excludedUserIds,
        now,
        leadMs: SALE_RULE_LEAD_MS,
    };
}

export function presentable(output: CompileOutput): CompileOutput {
    return {
        ...output,
        diagnostics: output.diagnostics.map((item) => ({ ...item, tierKey: unscope(item.tierKey) })),
        groups: Object.fromEntries(
            Object.entries(output.groups).map(([group, explanation]) => [
                group,
                { ...explanation, tierKey: unscope(explanation.tierKey) ?? explanation.tierKey },
            ]),
        ),
    };
}
