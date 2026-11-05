/**
 * Read models for the admin UI: the pricing page's sale-rule board and the
 * customer page's discount panel. Compile-only (no remote customer checks);
 * the explicit "check" actions run the full remote preview.
 */
import 'server-only';
import { prisma } from '@/lib/db';
import type { AdminPrincipal } from '@/lib/admin/auth';
import { PLATFORM_TENANT_ID, tenantScope } from '@/lib/admin/tenant-scope';
import { getUser } from '@/lib/newapi/client';
import { saleRuleSchedulerEnabled } from '@/lib/scheduler/sale-rules';
import type { Diagnostic, FactorSource } from './compile';
import { SaleRulePublishError } from './errors';
import type { SaleRuleImpact } from './impact';
import type { Conversion } from './service';
import { internalGroupFor, type RatioChange } from './options';
import type { SaleRulePlan, UserMove } from './plan';
import { evaluateSaleRulePlan, listSaleRulePublications, loadPlanInputs, previewSaleRules } from './publish';
import { tenantOf, upstreamByTier } from './state';

type WithEmail<T> = T & { customer_email: string | null };

export interface BoardRule {
    id: string;
    kind: string;
    tier_key: string;
    user_id: string | null;
    customer_email: string | null;
    model_id: string | null;
    model_name: string | null;
    discount: string;
    effective_from: string | null;
    effective_to: string | null;
    enabled: boolean;
    note: string | null;
    below_cost_ack_reason: string | null;
    updated_at: string;
    state: 'active' | 'scheduled' | 'expired' | 'disabled';
}

export interface BoardModel {
    id: string;
    slug: string;
    display_name: string;
    tiers: string[];
}

export interface PresentedPlan {
    hash: string;
    resolved: boolean;
    blocked: boolean;
    has_increases: boolean;
    changes: Array<WithEmail<RatioChange>>;
    moves: Array<WithEmail<UserMove>>;
    held: Array<{ user_id: string; customer_email: string | null }>;
    diagnostics: Array<WithEmail<Diagnostic>>;
    steps: string[];
}

export interface PresentedImpact extends Omit<
    SaleRuleImpact,
    'changes' | 'increases' | 'blocks' | 'holds' | 'warnings'
> {
    changes: Array<WithEmail<SaleRuleImpact['changes'][number]>>;
    increases: Array<WithEmail<SaleRuleImpact['increases'][number]>>;
    blocks: Array<WithEmail<Diagnostic>>;
    holds: Array<WithEmail<Diagnostic>>;
    warnings: Array<WithEmail<Diagnostic>>;
}

async function emailsFor(ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
    const unique = [...new Set([...ids].filter((id): id is string => !!id))];
    if (!unique.length) return new Map();
    const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, email: true } });
    return new Map(users.map((user) => [user.id, user.email]));
}

function email<T extends { userId?: string | null }>(emails: Map<string, string>, item: T): WithEmail<T> {
    return { ...item, customer_email: item.userId ? (emails.get(item.userId) ?? null) : null };
}

function ruleState(rule: { enabled: boolean; effective_from: Date | null; effective_to: Date | null }, now: Date) {
    if (!rule.enabled) return 'disabled' as const;
    if (rule.effective_to && rule.effective_to.getTime() <= now.getTime()) return 'expired' as const;
    if (rule.effective_from && rule.effective_from.getTime() > now.getTime()) return 'scheduled' as const;
    return 'active' as const;
}
export async function presentPlan(plan: SaleRulePlan): Promise<PresentedPlan> {
    const emails = await emailsFor([
        ...plan.changes.map((item) => item.userId),
        ...plan.moves.map((item) => item.userId),
        ...plan.held,
        ...plan.diagnostics.map((item) => item.userId),
    ]);
    return {
        hash: plan.hash,
        resolved: plan.resolved,
        blocked: plan.blocked,
        has_increases: plan.changes.some((change) => change.increase),
        changes: plan.changes.map((item) => email(emails, item)),
        moves: plan.moves.map((item) => email(emails, item)),
        held: plan.held.map((userId) => ({ user_id: userId, customer_email: emails.get(userId) ?? null })),
        diagnostics: plan.diagnostics.map((item) => email(emails, item)),
        steps: plan.steps.map((step) =>
            step.kind === 'move' ? `move_${step.move.direction}:${step.move.newapiUserId}` : step.label,
        ),
    };
}

export async function presentImpact(impact: SaleRuleImpact): Promise<PresentedImpact> {
    const emails = await emailsFor([
        ...impact.changes.map((item) => item.userId),
        ...impact.blocks.map((item) => item.userId),
        ...impact.holds.map((item) => item.userId),
        ...impact.warnings.map((item) => item.userId),
    ]);
    return {
        ...impact,
        changes: impact.changes.map((item) => email(emails, item)),
        increases: impact.increases.map((item) => email(emails, item)),
        blocks: impact.blocks.map((item) => email(emails, item)),
        holds: impact.holds.map((item) => email(emails, item)),
        warnings: impact.warnings.map((item) => email(emails, item)),
    };
}

async function loadRules(where: { tenant_id: string } | { tenant_id: string; user_id: string }, now: Date) {
    const rules = await prisma.pricingSaleRule.findMany({
        where,
        orderBy: [{ tier_key: 'asc' }, { kind: 'asc' }, { created_at: 'asc' }],
    });
    const [emails, models] = await Promise.all([
        emailsFor(rules.map((rule) => rule.user_id)),
        prisma.catalogModel.findMany({
            where: { id: { in: rules.flatMap((rule) => (rule.model_id ? [rule.model_id] : [])) } },
            select: { id: true, display_name: true },
        }),
    ]);
    const names = new Map(models.map((model) => [model.id, model.display_name]));
    return rules.map((rule): BoardRule => ({
        id: rule.id,
        kind: rule.kind,
        tier_key: rule.tier_key,
        user_id: rule.user_id,
        customer_email: rule.user_id ? (emails.get(rule.user_id) ?? null) : null,
        model_id: rule.model_id,
        model_name: rule.model_id ? (names.get(rule.model_id) ?? null) : null,
        discount: rule.discount.toFixed(),
        effective_from: rule.effective_from?.toISOString() ?? null,
        effective_to: rule.effective_to?.toISOString() ?? null,
        enabled: rule.enabled,
        note: rule.note,
        below_cost_ack_reason: rule.below_cost_ack_reason,
        updated_at: rule.updated_at.toISOString(),
        state: ruleState(rule, now),
    }));
}

async function loadModels(tenantId: string): Promise<BoardModel[]> {
    const models = await prisma.catalogModel.findMany({
        where: {
            enabled: true,
            OR: [{ tenant_id: tenantId }, ...(tenantId === PLATFORM_TENANT_ID ? [{ tenant_id: null }] : [])],
        },
        orderBy: [{ sort_order: 'asc' }, { slug: 'asc' }],
        select: { id: true, slug: true, display_name: true, upstream_map: true },
    });
    return models.map((model) => ({
        id: model.id,
        slug: model.slug,
        display_name: model.display_name,
        tiers: Object.keys(upstreamByTier(model.upstream_map)),
    }));
}
export interface BoardTier {
    key: string;
    display_name: string;
    enabled: boolean;
    newapi_group: string;
    live_ratio: number | null;
    managed: boolean;
    unified_sale_ratio: string | null;
    target_ratio: number | null;
    source: FactorSource | null;
    blocked: boolean;
    shared_with: string[];
    legacy_multipliers: number;
}

export interface BoardPublication {
    id: string;
    trigger: string;
    actor_email: string | null;
    status: string;
    created_at: string;
    moves: number;
    error: string | null;
    before: unknown;
    after: unknown;
}

export interface SaleRuleBoard {
    scheduler_enabled: boolean;
    tiers: BoardTier[];
    rules: BoardRule[];
    models: BoardModel[];
    plan: PresentedPlan;
    publications: BoardPublication[];
    /** Customer emails for user ids in publication snapshots. */
    emails: Record<string, string>;
}

function snapshotUsers(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    return Object.values(value as Record<string, unknown>).flatMap((group) => {
        const customers = group && typeof group === 'object' ? (group as { customers?: unknown }).customers : null;
        return customers && typeof customers === 'object' ? Object.keys(customers) : [];
    });
}

/** Superadmin pricing page: billing groups, rules, compile-only plan and recent publications. */
export async function loadSaleRuleBoard(admin: AdminPrincipal): Promise<SaleRuleBoard> {
    const tenantId = tenantOf(admin.tenant_id);
    const now = new Date();
    const inputs = await loadPlanInputs(prisma);
    const plan = await evaluateSaleRulePlan(prisma, inputs, now, 'never');
    const [tiers, allTiers, rules, models, publications] = await Promise.all([
        prisma.channelGroup.findMany({
            where: { tenant_id: tenantId },
            orderBy: [{ tier_level: 'asc' }, { key: 'asc' }],
            select: { key: true, display_name: true, enabled: true, newapi_group: true },
        }),
        prisma.channelGroup.findMany({ select: { tenant_id: true, key: true, newapi_group: true } }),
        loadRules({ tenant_id: tenantId }, now),
        loadModels(tenantId),
        listSaleRulePublications(20),
    ]);
    const groups = new Map(inputs.state.groups.map((group) => [group.newapi_group, group]));
    const historyEmails = await emailsFor(
        publications.flatMap((row) => [...snapshotUsers(row.before), ...snapshotUsers(row.after)]),
    );
    return {
        scheduler_enabled: saleRuleSchedulerEnabled(),
        tiers: tiers.map((tier) => {
            const group = groups.get(tier.newapi_group);
            const explanation = plan.compile.groups[tier.newapi_group];
            const managed = !!group && group.unified_sale_ratio !== null;
            return {
                ...tier,
                live_ratio: plan.liveGroupRatio[tier.newapi_group] ?? null,
                managed,
                unified_sale_ratio: managed ? group!.unified_sale_ratio!.toFixed() : null,
                target_ratio: explanation?.targetRatio ?? null,
                source: explanation?.source ?? null,
                blocked: explanation?.blocked ?? false,
                shared_with: allTiers
                    .filter(
                        (other) =>
                            other.newapi_group === tier.newapi_group &&
                            !(tenantOf(other.tenant_id) === tenantId && other.key === tier.key),
                    )
                    .map((other) => other.key),
                legacy_multipliers: inputs.state.multipliers.filter(
                    (row) => row.enabled && !row.managed_by_rules && row.newapi_billing_group === tier.newapi_group,
                ).length,
            };
        }),
        rules,
        models,
        plan: await presentPlan(plan),
        publications: publications.map((row) => ({
            id: row.id,
            trigger: row.trigger,
            actor_email: row.actor_email,
            status: row.status,
            created_at: row.created_at.toISOString(),
            moves: Array.isArray(row.moves) ? row.moves.length : 0,
            error: row.error,
            before: row.before,
            after: row.after,
        })),
        emails: Object.fromEntries(historyEmails),
    };
}
export interface CustomerTier {
    key: string;
    display_name: string;
    newapi_group: string;
    managed: boolean;
    unified_sale_ratio: string | null;
    group_ratio: number | null;
    /** What new-api charges this customer now, from its live user group. */
    effective_ratio: number | null;
    /** What the next publication would charge (compile-only). */
    compiled_ratio: number | null;
    source: FactorSource | null;
    legacy_multiplier: number | null;
}

export interface CustomerSaleRules {
    customer: { id: string; email: string; newapi_group: string | null };
    scheduler_enabled: boolean;
    tiers: CustomerTier[];
    rules: BoardRule[];
    models: BoardModel[];
    diagnostics: Diagnostic[];
}

async function scopedCustomer(admin: AdminPrincipal, customerId: string) {
    const customer = await prisma.user.findFirst({
        where: { id: customerId, ...tenantScope(admin) },
        select: { id: true, email: true, tenant_id: true, newapi_user_id: true },
    });
    if (!customer) throw new SaleRulePublishError('sale_rules_customer_missing', '客户不存在。', 404);
    return customer;
}

/** Customer page: managed tiers, this customer's rules and what each tier charges it. */
export async function loadCustomerSaleRules(admin: AdminPrincipal, customerId: string): Promise<CustomerSaleRules> {
    const customer = await scopedCustomer(admin, customerId);
    const tenantId = tenantOf(customer.tenant_id);
    const now = new Date();
    const inputs = await loadPlanInputs(prisma);
    const plan = await evaluateSaleRulePlan(prisma, inputs, now, 'never');
    const liveGroup =
        customer.newapi_user_id === null
            ? null
            : await getUser(customer.newapi_user_id).then(
                  (user) => user.group,
                  () => null,
              );
    const [tiers, rules, models] = await Promise.all([
        prisma.channelGroup.findMany({
            where: { tenant_id: tenantId, enabled: true },
            orderBy: [{ tier_level: 'asc' }, { key: 'asc' }],
            select: { key: true, display_name: true, newapi_group: true },
        }),
        loadRules({ tenant_id: tenantId, user_id: customer.id }, now),
        loadModels(tenantId),
    ]);
    const groups = new Map(inputs.state.groups.map((group) => [group.newapi_group, group]));
    const internal = internalGroupFor(customer.id);
    return {
        customer: { id: customer.id, email: customer.email, newapi_group: liveGroup },
        scheduler_enabled: saleRuleSchedulerEnabled(),
        tiers: tiers.map((tier) => {
            const group = groups.get(tier.newapi_group);
            const managed = !!group && group.unified_sale_ratio !== null;
            const groupRatio = plan.liveGroupRatio[tier.newapi_group] ?? null;
            const row = liveGroup ? plan.liveRows[liveGroup]?.[tier.newapi_group] : undefined;
            const compiled = plan.compile.customers.find(
                (item) => item.userId === customer.id && item.newapiGroup === tier.newapi_group,
            );
            const legacy = inputs.state.multipliers.find(
                (item) =>
                    item.user_id === customer.id &&
                    item.enabled &&
                    !item.managed_by_rules &&
                    item.tier_key === tier.key,
            );
            return {
                ...tier,
                managed,
                unified_sale_ratio: managed ? group!.unified_sale_ratio!.toFixed() : null,
                group_ratio: groupRatio,
                effective_ratio: liveGroup === null ? null : (row ?? groupRatio),
                compiled_ratio:
                    plan.nextRows[internal]?.[tier.newapi_group] ?? plan.nextGroupRatio[tier.newapi_group] ?? null,
                source: compiled?.source ?? plan.compile.groups[tier.newapi_group]?.source ?? null,
                legacy_multiplier: legacy ? Number(legacy.multiplier) : null,
            };
        }),
        rules,
        models,
        diagnostics: plan.diagnostics.filter((item) => item.userId === customer.id),
    };
}

/** Full remote checks, reported for one customer only. */
export async function checkCustomerSaleRules(admin: AdminPrincipal, customerId: string) {
    const customer = await scopedCustomer(admin, customerId);
    const plan = await previewSaleRules();
    return {
        held: plan.held.includes(customer.id),
        diagnostics: plan.diagnostics.filter((item) => item.userId === customer.id),
        changes: plan.changes.filter((item) => item.userId === customer.id),
        moves: plan.moves.filter((item) => item.userId === customer.id),
    };
}

/** Adopt preview: name the customers whose hand-made multipliers convert or stay. */
export async function presentConversion(conversion: Conversion) {
    const emails = await emailsFor([
        ...conversion.converted.map((item) => item.userId),
        ...conversion.kept.map((item) => item.userId),
    ]);
    return {
        converted: conversion.converted.map((item) => ({ ...item, customer_email: emails.get(item.userId) ?? null })),
        kept: conversion.kept.map((item) => ({ ...item, customer_email: emails.get(item.userId) ?? null })),
    };
}
