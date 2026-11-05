/**
 * Admin operations on sale rules: save a rule, adopt a billing group, change a
 * group's unified sale ratio. Each runs as preview (dry run, no lock) or apply
 * (inside the pricing coordination lock, with the preview's impact hash), then
 * publishes. Spec 2026-11-05 §6: increases need confirmation, below-cost prices
 * need a reason, and a change that adds a block is refused.
 */
import 'server-only';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { AdminPrincipal } from '@/lib/admin/auth';
import { assertPricingCatalogWritable, PricingPublishError } from '@/lib/admin/pricing-publish-lock';
import { roleAtLeast } from '@/lib/admin/roles';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { saleRuleSchedulerEnabled } from '@/lib/scheduler/sale-rules';
import { DISCOUNT_MAX, DISCOUNT_MIN, ruleProblems, SALE_RULE_KINDS, type SaleRuleKind } from './compile';
import { ceilToScale, compare, divide, equal, floorToScale, multiply, parseDecimal, toDecimalString } from './decimal';
import { SaleRulePublishError } from './errors';
import { compareSaleRules, customerHolds, withHolds, type SaleRuleImpact } from './impact';
import { parseLiveSaleOptions, SaleOptionsError } from './options';
import type { PublishActor, PublishTrigger } from './plan';
import { loadPlanInputs, publishSaleRules } from './publish';
import { tenantOf, upstreamByTier, type Db, type PortalState } from './state';

const DECIMAL_TEXT = /^\d{1,4}(\.\d{1,10})?$/;
const TX_OPTIONS = { timeout: 120_000, maxWait: 5_000 };

export const saleRuleDraftSchema = z
    .object({
        kind: z.enum(SALE_RULE_KINDS),
        tier_key: z.string().trim().min(1).max(100),
        user_id: z.string().uuid().nullable(),
        model_id: z.string().uuid().nullable(),
        discount: z.string().trim().regex(DECIMAL_TEXT, '折扣须是普通小数，例如 0.8。'),
        effective_from: z.string().datetime({ offset: true }).nullable(),
        effective_to: z.string().datetime({ offset: true }).nullable(),
        enabled: z.boolean(),
        note: z.string().trim().max(500).nullable(),
    })
    .strict();
export type SaleRuleDraft = z.infer<typeof saleRuleDraftSchema>;

export const saleRuleChangeSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('create'), draft: saleRuleDraftSchema }).strict(),
    z
        .object({
            op: z.literal('update'),
            id: z.string().uuid(),
            expected_updated_at: z.string().datetime({ offset: true }),
            draft: saleRuleDraftSchema,
        })
        .strict(),
    z
        .object({
            op: z.literal('delete'),
            id: z.string().uuid(),
            expected_updated_at: z.string().datetime({ offset: true }),
        })
        .strict(),
]);
export type SaleRuleChange = z.infer<typeof saleRuleChangeSchema>;

export const confirmationSchema = z
    .object({
        dry_run: z.boolean().default(false),
        impact_hash: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
        confirm_increases: z.boolean().default(false),
        below_cost_reason: z.string().trim().min(1).max(500).optional(),
    })
    .strict();
export type Confirmation = z.infer<typeof confirmationSchema>;
export interface SaleRuleContext {
    admin: AdminPrincipal;
    ip: string | null;
    userAgent: string | null;
    path: string;
}

export interface PublishFollowUp {
    outcome: 'applied' | 'noop' | 'deferred';
    publicationId: string | null;
    message: string | null;
}

export interface SaveResult {
    applied: boolean;
    impact: SaleRuleImpact;
    ruleId?: string;
    publish: PublishFollowUp | null;
}

const GLOBAL_KINDS = new Set<SaleRuleKind>(['global_model', 'global_tier']);

function auditLevel(admin: AdminPrincipal): PublishActor['level'] {
    if (admin.viaBreakGlass) return 'break_glass';
    return admin.role === 'superadmin' ? 'super' : 'secondary';
}

function actorOf(context: SaleRuleContext): PublishActor {
    return {
        userId: context.admin.user?.id ?? null,
        email: context.admin.user?.email ?? null,
        viaBreakGlass: context.admin.viaBreakGlass,
        level: auditLevel(context.admin),
        ip: context.ip,
        userAgent: context.userAgent,
        path: context.path,
    };
}

function forbidden(message: string): never {
    throw new SaleRulePublishError('sale_rules_forbidden', message, 403);
}

/** Global rules move every customer's price: superadmin only. Customer rules: admin within the tenant. */
function assertCanEdit(admin: AdminPrincipal, kind: SaleRuleKind, tenantId: string | null) {
    if (GLOBAL_KINDS.has(kind)) {
        if (admin.role !== 'superadmin') forbidden('全局售卖规则只能由超级管理员修改。');
        return;
    }
    if (!roleAtLeast(admin.role, 'admin')) forbidden('需要管理员权限。');
    if (admin.role !== 'superadmin' && tenantOf(tenantId) !== tenantOf(admin.tenant_id))
        forbidden('无权修改其他主体的规则。');
}

function assertSuperadmin(admin: AdminPrincipal) {
    if (admin.role !== 'superadmin') forbidden('计费分组纳管和统一售卖价只能由超级管理员修改。');
}

/** Preview runs without the lock and writes nothing; apply holds the pricing coordination lock throughout. */
async function staged<T>(dryRun: boolean, work: (db: Db) => Promise<T>): Promise<T> {
    if (dryRun) return work(prisma);
    return prisma.$transaction(async (tx) => {
        await assertPricingCatalogWritable(tx);
        return work(tx);
    }, TX_OPTIONS);
}

/** Apply only what the operator previewed and confirmed. */
function assertConfirmed(impact: SaleRuleImpact, confirmation: Confirmation) {
    if (impact.holds.length)
        throw new SaleRulePublishError(
            'sale_rules_customer_held',
            `该客户当前无法使用专属价格：${impact.holds[0].message}`,
        );
    if (impact.blocks.length)
        throw new SaleRulePublishError(
            'sale_rules_change_blocked',
            `该修改会造成无法发布的问题：${impact.blocks[0].message}`,
        );
    if (!confirmation.impact_hash || confirmation.impact_hash !== impact.hash)
        throw new SaleRulePublishError('sale_rules_stale', '影响范围已变化或尚未预览，请重新预览后确认。');
    if (impact.increases.length && !confirmation.confirm_increases)
        throw new SaleRulePublishError(
            'sale_rules_increase_unconfirmed',
            '该修改会让部分客户涨价，请确认涨价后再保存。',
        );
    if (impact.belowCost.length && !confirmation.below_cost_reason)
        throw new SaleRulePublishError('sale_rules_below_cost_unconfirmed', '售价会低于采购成本，请填写原因后再保存。');
}
/** Placeholder id for a rule that does not exist yet; stable so preview and apply hash alike. */
const DRAFT_RULE_ID = '00000000-0000-4000-8000-000000000000';

function invalid(message: string): never {
    throw new SaleRulePublishError('sale_rules_invalid', message, 400);
}

const toDate = (value: string | null) => (value ? new Date(value) : null);

/** The tenant a draft belongs to: its customer's for customer rules, the admin's otherwise. */
async function draftTenant(db: Db, admin: AdminPrincipal, draft: SaleRuleDraft): Promise<string> {
    if (!draft.user_id) return tenantOf(admin.tenant_id);
    const customer = await db.user.findFirst({
        where: { id: draft.user_id, ...tenantScope(admin) },
        select: { tenant_id: true, newapi_user_id: true },
    });
    if (!customer) throw new SaleRulePublishError('sale_rules_customer_missing', '客户不存在。', 404);
    if (customer.newapi_user_id === null) invalid('该客户尚未开通 new-api 账号。');
    return tenantOf(customer.tenant_id);
}

function ruleRow(id: string, tenantId: string, draft: SaleRuleDraft): PortalState['rules'][number] {
    return {
        id,
        tenant_id: tenantId,
        kind: draft.kind,
        user_id: draft.user_id,
        tier_key: draft.tier_key,
        model_id: draft.model_id,
        discount: new Prisma.Decimal(draft.discount),
        effective_from: toDate(draft.effective_from),
        effective_to: toDate(draft.effective_to),
        enabled: draft.enabled,
    };
}

function withRule(state: PortalState, id: string, row: PortalState['rules'][number] | null): PortalState {
    const rules = state.rules.filter((rule) => rule.id !== id);
    return { ...state, rules: row?.enabled ? [...rules, row] : rules };
}

/** Shape, target and timing checks for a draft against the loaded Portal state. */
function validateDraft(state: PortalState, tenantId: string, draft: SaleRuleDraft, now: Date) {
    const problems = ruleProblems({
        id: DRAFT_RULE_ID,
        kind: draft.kind,
        userId: draft.user_id,
        tierKey: draft.tier_key,
        modelId: draft.model_id,
        discount: draft.discount,
        effectiveFrom: toDate(draft.effective_from),
        effectiveTo: toDate(draft.effective_to),
        enabled: draft.enabled,
    });
    if (problems.length) invalid(problems.join('；'));
    const group = state.groups.find(
        (item) => tenantOf(item.tenant_id) === tenantId && item.tier_key === draft.tier_key,
    );
    if (!group || group.unified_sale_ratio === null) invalid('该档次的计费分组尚未纳管，请先在定价页纳管。');
    if (draft.model_id) {
        const model = state.catalog.find((item) => item.id === draft.model_id && tenantOf(item.tenant_id) === tenantId);
        if (!model || !upstreamByTier(model.upstream_map)[draft.tier_key]) invalid('该模型不在此档次的模型目录中。');
    }
    if (
        draft.user_id &&
        state.multipliers.some(
            (row) =>
                row.user_id === draft.user_id &&
                row.enabled &&
                !row.managed_by_rules &&
                (row.tier_key === draft.tier_key || row.newapi_billing_group === group.newapi_group),
        )
    )
        invalid('该客户在此档次仍有旧专属倍率，请先在纳管时转换或停用它。');
    if (draft.enabled && draft.effective_to && new Date(draft.effective_to).getTime() <= now.getTime())
        invalid('到期时间已过，请调整或停用该规则。');
    if ((draft.effective_from || draft.effective_to) && !saleRuleSchedulerEnabled())
        invalid('售卖规则调度未启用，不能保存有生效或到期时间的规则。');
}
type ExistingRule = Prisma.PricingSaleRuleGetPayload<object>;

function plainRule(rule: ExistingRule) {
    return {
        ...rule,
        discount: rule.discount.toFixed(),
        effective_from: rule.effective_from?.toISOString() ?? null,
        effective_to: rule.effective_to?.toISOString() ?? null,
    };
}

async function loadExisting(db: Db, context: SaleRuleContext, change: SaleRuleChange, customerScope?: string) {
    if (change.op === 'create') return null;
    const existing = await db.pricingSaleRule.findUnique({ where: { id: change.id } });
    if (!existing) throw new SaleRulePublishError('sale_rules_missing', '规则不存在。', 404);
    if (existing.updated_at.toISOString() !== new Date(change.expected_updated_at).toISOString())
        throw new SaleRulePublishError('sale_rules_stale', '规则已被其他人修改，请刷新后重试。');
    if (customerScope && existing.user_id !== customerScope) forbidden('该规则不属于此客户。');
    assertCanEdit(context.admin, existing.kind as SaleRuleKind, existing.tenant_id);
    return existing;
}

/**
 * Create, update or delete one rule. `customerScope` (customer page) limits the
 * change to that customer's own rules.
 */
export async function saveSaleRule(
    context: SaleRuleContext,
    change: SaleRuleChange,
    confirmation: Confirmation,
    customerScope?: string,
): Promise<SaveResult> {
    const draft = change.op === 'delete' ? null : change.draft;
    if (customerScope && draft && (draft.user_id !== customerScope || GLOBAL_KINDS.has(draft.kind)))
        forbidden('客户页只能修改该客户自己的规则。');
    const result: { applied: boolean; impact: SaleRuleImpact; ruleId?: string } = await staged(
        confirmation.dry_run,
        async (db) => {
            const now = new Date();
            const existing = await loadExisting(db, context, change, customerScope);
            const inputs = await loadPlanInputs(db);
            const tenantId = draft ? await draftTenant(db, context.admin, draft) : null;
            if (draft && tenantId) {
                assertCanEdit(context.admin, draft.kind, tenantId);
                validateDraft(inputs.state, tenantId, draft, now);
            }
            const id = existing?.id ?? DRAFT_RULE_ID;
            const proposed = withRule(inputs.state, id, draft && tenantId ? ruleRow(id, tenantId, draft) : null);
            let impact = await compareSaleRules(db, inputs, proposed, now);
            if (draft?.user_id && draft.enabled)
                impact = withHolds(impact, await customerHolds(db, inputs, proposed, now, draft.user_id));
            if (confirmation.dry_run) return { applied: false, impact };
            assertConfirmed(impact, confirmation);
            const ruleId = await persistRule(db, context, change, existing, tenantId, impact, confirmation);
            await audit(db, context, `pricing_sale_rule_${change.op}`, ruleId, {
                before: existing ? plainRule(existing) : null,
                after: draft,
                impact: impactSummary(impact),
                below_cost_reason: confirmation.below_cost_reason ?? null,
            });
            return { applied: true, impact, ruleId };
        },
    );
    return { ...result, publish: result.applied ? await publishAfter(context, 'rule_save') : null };
}
async function persistRule(
    db: Db,
    context: SaleRuleContext,
    change: SaleRuleChange,
    existing: ExistingRule | null,
    tenantId: string | null,
    impact: SaleRuleImpact,
    confirmation: Confirmation,
): Promise<string> {
    if (change.op === 'delete') {
        await db.pricingSaleRule.delete({ where: { id: existing!.id } });
        return existing!.id;
    }
    const actorId = context.admin.user?.id ?? null;
    const { draft } = change;
    const data = {
        tenant_id: tenantId,
        kind: draft.kind,
        user_id: draft.user_id,
        tier_key: draft.tier_key,
        model_id: draft.model_id,
        discount: new Prisma.Decimal(draft.discount),
        effective_from: toDate(draft.effective_from),
        effective_to: toDate(draft.effective_to),
        enabled: draft.enabled,
        note: draft.note,
        below_cost_ack_reason: impact.belowCost.length
            ? (confirmation.below_cost_reason ?? null)
            : (existing?.below_cost_ack_reason ?? null),
        updated_by: actorId,
    };
    if (change.op === 'create') {
        const created = await db.pricingSaleRule.create({
            data: { ...data, created_by: actorId },
            select: { id: true },
        });
        return created.id;
    }
    await db.pricingSaleRule.update({ where: { id: existing!.id }, data });
    return existing!.id;
}

function impactSummary(impact: SaleRuleImpact) {
    return {
        hash: impact.hash,
        changes: impact.changes.length,
        increases: impact.increases.length,
        below_cost: impact.belowCost.length,
    };
}

async function audit(db: Db, context: SaleRuleContext, action: string, target: string, params: unknown) {
    const json = JSON.stringify(params);
    await db.adminAuditLog.create({
        data: {
            admin_user_id: context.admin.user?.id ?? null,
            admin_email: context.admin.user?.email ?? null,
            level: auditLevel(context.admin),
            action,
            method: 'POST',
            path: context.path,
            target: target.slice(0, 200),
            params: json.length > 8_000 ? `${json.slice(0, 8_000)}…` : json,
            client_ip: context.ip,
            user_agent: context.userAgent?.slice(0, 500) ?? null,
        },
    });
}

/** Publish right after a save. A failed publication never undoes the save. */
async function publishAfter(context: SaleRuleContext, trigger: PublishTrigger): Promise<PublishFollowUp> {
    const retry = saleRuleSchedulerEnabled() ? '调度器会自动重试。' : '请在定价页手动发布。';
    try {
        const result = await publishSaleRules({ trigger, actor: actorOf(context) });
        if (result.plan.blocked)
            return {
                outcome: 'deferred',
                publicationId: null,
                message: '已保存，但存在阻断问题，未发布。请先处理定价页列出的问题。',
            };
        return { outcome: result.outcome, publicationId: result.publicationId, message: null };
    } catch (error) {
        const reason = error instanceof SaleRulePublishError ? error.message.replace(/[。.]$/, '') : '发布失败';
        if (!(error instanceof SaleRulePublishError))
            console.warn('[sale-rules] publication after save failed', { trigger });
        return { outcome: 'deferred', publicationId: null, message: `已保存，但发布未完成：${reason}。${retry}` };
    }
}
export const adoptSchema = z.object({ tier_key: z.string().trim().min(1).max(100) }).strict();

export interface Conversion {
    converted: Array<{ rowId: string; userId: string; discount: string; ratio: number }>;
    kept: Array<{ userId: string; ratio: number; reason: string }>;
}

/**
 * Hand-made multipliers on the group become customer_tier rules only when the
 * compiled ratio reproduces today's price exactly. Every other one stays
 * hand-made and is listed for the operator; nothing is clamped.
 */
export function convertLegacy(
    state: PortalState,
    tierKey: string,
    group: string,
    unified: string,
    liveRows: Record<string, Record<string, number>>,
): Conversion {
    const result: Conversion = { converted: [], kept: [] };
    const base = parseDecimal(unified);
    const rows = state.multipliers
        .filter(
            (row) =>
                row.enabled &&
                !row.managed_by_rules &&
                (row.tier_key === tierKey || row.newapi_billing_group === group),
        )
        .sort((left, right) => left.user_id.localeCompare(right.user_id));
    for (const row of rows) {
        const ratio = Number(row.multiplier);
        const keep = (reason: string) => result.kept.push({ userId: row.user_id, ratio, reason });
        if (row.tier_key !== tierKey || row.newapi_billing_group !== group) {
            keep('旧专属倍率的档次与计费分组不一致');
            continue;
        }
        if (liveRows[row.newapi_user_group]?.[group] !== ratio) {
            keep('旧专属倍率与 new-api 当前值不一致');
            continue;
        }
        const legacy = parseDecimal(row.multiplier.toFixed());
        const discount = floorToScale(divide(legacy, base), 10);
        const rebuilt = equal(discount, parseDecimal('1')) ? base : ceilToScale(multiply(base, discount), 6);
        if (compare(discount, parseDecimal(DISCOUNT_MIN)) < 0 || compare(discount, parseDecimal(DISCOUNT_MAX)) > 0) {
            keep(`换算折扣 ${toDecimalString(discount)} 超出 ${DISCOUNT_MIN} 至 ${DISCOUNT_MAX}`);
            continue;
        }
        if (!equal(rebuilt, legacy)) {
            keep('换算后无法精确还原原价');
            continue;
        }
        result.converted.push({ rowId: row.id, userId: row.user_id, discount: toDecimalString(discount), ratio });
    }
    return result;
}

const adoptRuleId = (userId: string) => `adopt:${userId}`;

function adoptedState(
    state: PortalState,
    tier: { tenant_id: string | null; key: string; newapi_group: string },
    unified: Prisma.Decimal,
    conversion: Conversion,
): PortalState {
    const converted = new Set(conversion.converted.map((item) => item.rowId));
    return {
        ...state,
        groups: [
            ...state.groups.filter((group) => group.newapi_group !== tier.newapi_group),
            {
                tenant_id: tier.tenant_id,
                tier_key: tier.key,
                newapi_group: tier.newapi_group,
                unified_sale_ratio: unified,
            },
        ],
        rules: [
            ...state.rules,
            ...conversion.converted.map((item) => ({
                id: adoptRuleId(item.userId),
                tenant_id: tier.tenant_id,
                kind: 'customer_tier',
                user_id: item.userId,
                tier_key: tier.key,
                model_id: null,
                discount: new Prisma.Decimal(item.discount),
                effective_from: null,
                effective_to: null,
                enabled: true,
            })),
        ],
        multipliers: state.multipliers.map((row) => (converted.has(row.id) ? { ...row, managed_by_rules: true } : row)),
    };
}
export interface AdoptResult {
    applied: boolean;
    impact: SaleRuleImpact;
    conversion: Conversion;
    unifiedSaleRatio: string;
    publish: PublishFollowUp | null;
}

/** Put a tier's billing group under the compiler, starting from today's live group ratio. */
export async function adoptBillingGroup(
    context: SaleRuleContext,
    input: z.infer<typeof adoptSchema>,
    confirmation: Confirmation,
): Promise<AdoptResult> {
    assertSuperadmin(context.admin);
    const tenantId = tenantOf(context.admin.tenant_id);
    const result: Omit<AdoptResult, 'publish'> = await staged(confirmation.dry_run, async (db) => {
        const now = new Date();
        const tier = await db.channelGroup.findFirst({
            where: { tenant_id: tenantId, key: input.tier_key },
            select: { tenant_id: true, key: true, newapi_group: true, enabled: true },
        });
        if (!tier || !tier.enabled) invalid('档次不存在或已停用。');
        const shared = await db.channelGroup.count({
            where: { newapi_group: tier.newapi_group, NOT: { tenant_id: tier.tenant_id, key: tier.key } },
        });
        if (shared) invalid('该计费分组还被其他档次使用，纳管会让规则扩散到那些档次，请先拆分。');
        const inputs = await loadPlanInputs(db);
        if (inputs.state.groups.some((group) => group.newapi_group === tier.newapi_group && group.unified_sale_ratio))
            invalid('该计费分组已纳管。');
        const live = parseLiveSaleOptions(inputs.options);
        if (live.diagnostics.some((item) => item.code === 'dual_key_diverged'))
            invalid('new-api 分组倍率的两份配置不一致，请先在 new-api 让两份一致。');
        const ratio = live.groupRatio[tier.newapi_group];
        if (ratio === undefined || ratio <= 0) invalid('new-api 分组倍率中没有该计费分组。');
        const unified = new Prisma.Decimal(ratio).toDecimalPlaces(12);
        const conversion = convertLegacy(
            inputs.state,
            tier.key,
            tier.newapi_group,
            unified.toFixed(),
            live.groupGroupRatio,
        );
        const proposed = adoptedState(inputs.state, { ...tier, tenant_id: tenantId }, unified, conversion);
        const impact = await compareSaleRules(db, inputs, proposed, now);
        const preview = { impact, conversion, unifiedSaleRatio: unified.toFixed() };
        if (confirmation.dry_run) return { applied: false, ...preview };
        assertConfirmed(impact, confirmation);
        const actorId = context.admin.user?.id ?? null;
        await db.pricingBillingGroup.upsert({
            where: { newapi_group: tier.newapi_group },
            create: {
                tenant_id: tenantId,
                tier_key: tier.key,
                newapi_group: tier.newapi_group,
                unified_sale_ratio: unified,
                managed_at: now,
                managed_by: actorId,
            },
            update: {
                tenant_id: tenantId,
                tier_key: tier.key,
                unified_sale_ratio: unified,
                managed_at: now,
                managed_by: actorId,
            },
        });
        for (const item of conversion.converted) {
            await db.pricingSaleRule.create({
                data: {
                    tenant_id: tenantId,
                    kind: 'customer_tier',
                    user_id: item.userId,
                    tier_key: tier.key,
                    discount: new Prisma.Decimal(item.discount),
                    enabled: true,
                    note: `纳管时由旧专属倍率 ${item.ratio} 换算`,
                    created_by: actorId,
                    updated_by: actorId,
                },
            });
            await db.userTierMultiplier.update({ where: { id: item.rowId }, data: { managed_by_rules: true } });
        }
        await audit(db, context, 'pricing_billing_group_adopt', tier.key, {
            newapi_group: tier.newapi_group,
            unified_sale_ratio: unified.toFixed(),
            converted: conversion.converted.length,
            kept: conversion.kept,
            impact: impactSummary(impact),
        });
        return { applied: true, ...preview };
    });
    return { ...result, publish: result.applied ? await publishAfter(context, 'adopt') : null };
}
export const unifiedRatioSchema = z
    .object({
        tier_key: z.string().trim().min(1).max(100),
        unified_sale_ratio: z.string().trim().regex(DECIMAL_TEXT, '统一售卖倍率须是普通小数。'),
    })
    .strict();

/**
 * Change a managed group's unified sale price. Every discount multiplies it, so
 * discounted customers move in proportion; the preview lists them (spec §6).
 */
export async function saveUnifiedSaleRatio(
    context: SaleRuleContext,
    input: z.infer<typeof unifiedRatioSchema>,
    confirmation: Confirmation,
): Promise<SaveResult> {
    assertSuperadmin(context.admin);
    const tenantId = tenantOf(context.admin.tenant_id);
    const next = new Prisma.Decimal(input.unified_sale_ratio);
    if (next.lte(0) || next.gt(1000)) invalid('统一售卖倍率须大于 0 且不超过 1000。');
    const result: { applied: boolean; impact: SaleRuleImpact } = await staged(confirmation.dry_run, async (db) => {
        const now = new Date();
        const inputs = await loadPlanInputs(db);
        const group = inputs.state.groups.find(
            (item) => tenantOf(item.tenant_id) === tenantId && item.tier_key === input.tier_key,
        );
        if (!group || group.unified_sale_ratio === null) invalid('该档次的计费分组尚未纳管。');
        const before = group.unified_sale_ratio;
        const proposed: PortalState = {
            ...inputs.state,
            groups: inputs.state.groups.map((item) => (item === group ? { ...item, unified_sale_ratio: next } : item)),
        };
        const impact = await compareSaleRules(db, inputs, proposed, now);
        if (confirmation.dry_run) return { applied: false, impact };
        assertConfirmed(impact, confirmation);
        await db.pricingBillingGroup.update({
            where: { newapi_group: group.newapi_group },
            data: { unified_sale_ratio: next },
        });
        await audit(db, context, 'pricing_unified_sale_ratio', input.tier_key, {
            newapi_group: group.newapi_group,
            before: before.toFixed(),
            after: next.toFixed(),
            impact: impactSummary(impact),
            below_cost_reason: confirmation.below_cost_reason ?? null,
        });
        return { applied: true, impact };
    });
    return { ...result, publish: result.applied ? await publishAfter(context, 'tier_save') : null };
}

/** Map service errors to the admin API's `{ error, message }` body. */
export function saleRuleErrorBody(error: unknown): { body: { error: string; message: string }; status: number } {
    if (error instanceof z.ZodError)
        return { body: { error: 'invalid_input', message: error.issues[0]?.message ?? '参数格式无效。' }, status: 400 };
    if (error instanceof SaleRulePublishError || error instanceof PricingPublishError)
        return { body: { error: error.code, message: error.message }, status: error.status };
    if (error instanceof SaleOptionsError)
        return { body: { error: 'sale_rules_options_invalid', message: error.message }, status: 409 };
    if (error && typeof error === 'object' && 'code' in error && ['P2028', 'P2034'].includes(String(error.code)))
        return { body: { error: 'pricing_publish_busy', message: '定价正在修改，请稍后重试。' }, status: 409 };
    console.error('[sale-rules] unexpected error', { name: error instanceof Error ? error.name : typeof error });
    return { body: { error: 'sale_rules_failed', message: '售卖规则处理失败，请稍后重试。' }, status: 500 };
}

export const publishSchema = z
    .object({ expected_hash: z.string().regex(/^[0-9a-f]{64}$/), confirm_increases: z.boolean().default(false) })
    .strict();

/** Manual publication of the previewed plan (spec §4.2: preview first, record who published). */
export async function publishManually(context: SaleRuleContext, input: z.infer<typeof publishSchema>) {
    assertSuperadmin(context.admin);
    return publishSaleRules({
        trigger: 'manual',
        actor: actorOf(context),
        expectedHash: input.expected_hash,
        confirmIncreases: input.confirm_increases,
    });
}
