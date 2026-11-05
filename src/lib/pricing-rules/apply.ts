/**
 * Remote writes for a resolved plan, inside the pricing coordination
 * transaction: options, customer moves, readback, Portal mirror and catalog.
 */
import 'server-only';
import type { Prisma } from '@prisma/client';
import { assertPricingCatalogWritable } from '@/lib/admin/pricing-publish-lock';
import { snapshotCatalog } from '@/lib/admin/pricing-simple';
import {
    getPricingPublishOptions,
    getSaleRuleOptions,
    getUser,
    putSaleRuleOption,
    updateUser,
    type NewApiUser,
    type SaleRuleWritableOption,
} from '@/lib/newapi/client';
import { SaleRulePublishError } from './errors';
import {
    GROUP_GROUP_RATIO_KEYS,
    GROUP_RATIO_KEYS,
    internalGroupFor,
    mirrorRowPresent,
    parseNestedRatioMap,
    parseRatioMap,
    sameRatioMaps,
    type NestedRatioMap,
    type RatioMap,
} from './options';
import type { MirrorOp, OptionFamily, PublishActor, SaleRulePlan, UserMove } from './plan';
import { tenantOf } from './state';

const WRITE_DEADLINE_MS = 90_000;

interface WriteContext {
    tx: Prisma.TransactionClient;
    deadline: number;
    /** Last confirmed value of each option family, starting from the plan's live values. */
    expected: Record<OptionFamily, RatioMap | NestedRatioMap>;
}

const FAMILY_KEYS: Record<OptionFamily, readonly [SaleRuleWritableOption, SaleRuleWritableOption]> = {
    group_ratio: GROUP_RATIO_KEYS,
    group_group_ratio: GROUP_GROUP_RATIO_KEYS,
};

function parseFamily(family: OptionFamily, raw: unknown, key: string): RatioMap | NestedRatioMap {
    return family === 'group_ratio' ? parseRatioMap(raw, key) : parseNestedRatioMap(raw, key);
}

function sameFamily(family: OptionFamily, options: Record<string, unknown> | null, key: string, value: unknown) {
    if (!options) return false;
    try {
        return sameRatioMaps(parseFamily(family, options[key], key), value);
    } catch {
        return false;
    }
}

async function guard(ctx: WriteContext) {
    await assertPricingCatalogWritable(ctx.tx);
    if (Date.now() > ctx.deadline)
        throw new SaleRulePublishError('sale_rules_timeout', '售卖规则发布超过安全写入时限，请核对当前状态后重试。');
}

/** An ambiguous failure may still have committed: only an exact readback counts as success. */
async function putConfirmed(key: SaleRuleWritableOption, family: OptionFamily, value: RatioMap | NestedRatioMap) {
    try {
        await putSaleRuleOption(key, JSON.stringify(value));
    } catch (error) {
        const readback = await getSaleRuleOptions().catch(() => null);
        if (sameFamily(family, readback, key, value)) return;
        throw error;
    }
}

/** The dotted copy failed after the classic one landed: put the classic one back so both stay identical. */
async function restoreClassic(ctx: WriteContext, family: OptionFamily, classic: SaleRuleWritableOption) {
    try {
        await assertPricingCatalogWritable(ctx.tx);
        await putConfirmed(classic, family, ctx.expected[family]);
    } catch (error) {
        console.error('[pricing-rules] CRITICAL could not restore option after a failed mirror write', {
            option: classic,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
/** Write one option family (classic key, then its dotted copy when that row exists) and read both back. */
async function writeFamily(ctx: WriteContext, family: OptionFamily, value: RatioMap | NestedRatioMap) {
    await guard(ctx);
    const [classic, dotted] = FAMILY_KEYS[family];
    const before = await getSaleRuleOptions();
    const mirrored = mirrorRowPresent(before, dotted);
    // new-api has no compare-and-set: refuse when someone changed the option since the plan was read.
    if (
        !sameFamily(family, before, classic, ctx.expected[family]) ||
        (mirrored && !sameFamily(family, before, dotted, ctx.expected[family]))
    )
        throw new SaleRulePublishError('sale_rules_remote_changed', 'new-api 分组倍率在发布过程中被修改，请重新预览。');
    await putConfirmed(classic, family, value);
    if (mirrored) {
        try {
            await guard(ctx);
            await putConfirmed(dotted, family, value);
        } catch (error) {
            await restoreClassic(ctx, family, classic);
            throw error;
        }
    }
    const after = await getSaleRuleOptions();
    if (!sameFamily(family, after, classic, value) || (mirrored && !sameFamily(family, after, dotted, value)))
        throw new SaleRulePublishError('sale_rules_unverified', 'new-api 未按预期保存分组倍率，请核对后重试。', 502);
    ctx.expected[family] = value;
}

/** Move one customer between its original and internal group, refusing when the group changed meanwhile. */
async function moveUser(ctx: WriteContext, move: UserMove) {
    await guard(ctx);
    const user: NewApiUser = await getUser(move.newapiUserId);
    if (user.group !== move.from)
        throw new SaleRulePublishError(
            'sale_rules_remote_changed',
            '客户的 new-api 分组在发布过程中被修改，请重新预览。',
        );
    let failure: unknown = null;
    try {
        await updateUser({ ...user, group: move.to }, 15_000);
    } catch (error) {
        failure = error;
    }
    const reloaded = await getUser(move.newapiUserId).catch(() => null);
    if (reloaded?.group === move.to) return;
    if (failure instanceof Error) throw failure;
    throw new SaleRulePublishError('sale_rules_unverified', 'new-api 未按预期保存客户分组，请核对后重试。', 502);
}

/** Final readback of everything the plan owns, including both copies of each option. */
async function verifyRemote(plan: SaleRulePlan) {
    const options = await getSaleRuleOptions();
    const groupRatio = parseRatioMap(options[GROUP_RATIO_KEYS[0]], GROUP_RATIO_KEYS[0]);
    const rows = parseNestedRatioMap(options[GROUP_GROUP_RATIO_KEYS[0]], GROUP_GROUP_RATIO_KEYS[0]);
    const problems: string[] = [];
    for (const [group, users] of Object.entries(plan.owned)) {
        if (groupRatio[group] !== plan.nextGroupRatio[group]) problems.push(group);
        for (const userId of users)
            if (rows[internalGroupFor(userId)]?.[group] !== plan.nextRows[internalGroupFor(userId)]?.[group])
                problems.push(`${group}/${userId}`);
    }
    for (const [classic, dotted, value] of [
        [GROUP_RATIO_KEYS[0], GROUP_RATIO_KEYS[1], groupRatio],
        [GROUP_GROUP_RATIO_KEYS[0], GROUP_GROUP_RATIO_KEYS[1], rows],
    ] as const)
        if (mirrorRowPresent(options, dotted) && !sameRatioMaps(decodeOption(options[dotted]), value))
            problems.push(`${dotted}≠${classic}`);
    if (problems.length)
        throw new SaleRulePublishError(
            'sale_rules_unverified',
            `new-api 回读与计划不一致：${problems.slice(0, 5).join('、')}`,
            502,
        );
}

function decodeOption(raw: unknown): unknown {
    if (typeof raw !== 'string') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}
/** Portal mirror rows for compiled customers. Hand-made (legacy) rows are never overwritten. */
async function writeMirror(tx: Prisma.TransactionClient, ops: MirrorOp[], actorId: string | null) {
    const now = new Date();
    for (const op of ops) {
        if (op.kind === 'disable') {
            await tx.userTierMultiplier.updateMany({
                where: { user_id: op.userId, tier_key: op.tierKey, managed_by_rules: true, enabled: true },
                data: { enabled: false, synced_at: now },
            });
            continue;
        }
        const data = {
            newapi_billing_group: op.newapiGroup,
            newapi_user_group: op.internalGroup,
            original_newapi_user_group: op.originalGroup,
            multiplier: op.ratio,
            enabled: true,
            managed_by_rules: true,
            synced_at: now,
        };
        const existing = await tx.userTierMultiplier.findUnique({
            where: { user_id_tier_key: { user_id: op.userId, tier_key: op.tierKey } },
            select: { id: true, enabled: true, managed_by_rules: true },
        });
        if (existing?.enabled && !existing.managed_by_rules)
            throw new SaleRulePublishError('sale_rules_legacy_row', '客户的旧专属倍率在发布过程中出现，请重新预览。');
        if (existing) await tx.userTierMultiplier.update({ where: { id: existing.id }, data });
        else
            await tx.userTierMultiplier.create({
                data: { ...data, user_id: op.userId, tier_key: op.tierKey, created_by: actorId },
            });
    }
}

/** Re-snapshot public catalog prices for every tier billed through a group whose ratio changed. */
async function refreshCatalog(tx: Prisma.TransactionClient, plan: SaleRulePlan, actorId: string | null) {
    const changed = Object.keys(plan.owned).filter(
        (group) => plan.liveGroupRatio[group] !== plan.nextGroupRatio[group],
    );
    if (!changed.length) return 0;
    const tiers = await tx.channelGroup.findMany({
        where: { newapi_group: { in: changed } },
        select: { tenant_id: true, key: true },
    });
    const byTenant = new Map<string, Set<string>>();
    for (const tier of tiers) {
        const keys = byTenant.get(tenantOf(tier.tenant_id)) ?? new Set<string>();
        byTenant.set(tenantOf(tier.tenant_id), keys.add(tier.key));
    }
    const options = await getPricingPublishOptions();
    let rows = 0;
    for (const [tenant, keys] of byTenant)
        rows += await snapshotCatalog(tx, tenant, options, actorId, ({ tier }) => keys.has(tier));
    return rows;
}
async function audit(tx: Prisma.TransactionClient, actor: PublishActor, publicationId: string, plan: SaleRulePlan) {
    await tx.adminAuditLog.create({
        data: {
            admin_user_id: actor.userId,
            admin_email: actor.email,
            level: actor.level,
            action: 'pricing_sale_rules_publish',
            method: 'POST',
            path: actor.path,
            target: publicationId,
            params: JSON.stringify({
                changes: plan.changes.length,
                increases: plan.changes.filter((change) => change.increase).length,
                moves: plan.moves.length,
                hash: plan.hash,
            }),
            client_ip: actor.ip,
            user_agent: actor.userAgent?.slice(0, 500) ?? null,
        },
    });
}

export async function applyPlan(
    tx: Prisma.TransactionClient,
    plan: SaleRulePlan,
    publicationId: string,
    actor: PublishActor | null,
): Promise<number> {
    if (!plan.resolved || plan.blocked)
        throw new SaleRulePublishError('sale_rules_blocked', '售卖规则计划未完成核对或被阻断，不能发布。');
    if (plan.mirror.some((op) => op.kind === 'upsert' && !op.originalGroup.trim()))
        throw new SaleRulePublishError('sale_rules_original_unknown', '有客户的原分组未记录，拒绝发布。');
    const ctx: WriteContext = {
        tx,
        deadline: Date.now() + WRITE_DEADLINE_MS,
        expected: { group_ratio: plan.liveGroupRatio, group_group_ratio: plan.liveRows },
    };
    for (const step of plan.steps) {
        if (step.kind === 'move') await moveUser(ctx, step.move);
        else await writeFamily(ctx, step.family, step.value);
    }
    await verifyRemote(plan);
    await writeMirror(tx, plan.mirror, actor?.userId ?? null);
    const catalogRows = await refreshCatalog(tx, plan, actor?.userId ?? null);
    if (actor) await audit(tx, actor, publicationId, plan);
    return catalogRows;
}
