/**
 * Sale-rule publisher entry points: preview, publish, the scheduler tick and
 * publication history. Portal is the source of truth; new-api GroupRatio and
 * GroupGroupRatio are compiled outputs (spec 2026-11-05 §11).
 */
import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { assertPricingCatalogWritable, PricingPublishError } from '@/lib/admin/pricing-publish-lock';
import { getSaleRuleOptions, listChannelsForCatalogSync } from '@/lib/newapi/client';
import { applyPlan } from './apply';
import { SaleRulePublishError } from './errors';
import {
    internalGroupFor,
    mergeGroupGroupRatio,
    ratioChanges,
    sameRatioMaps,
    type NestedRatioMap,
    type RatioMap,
} from './options';
import {
    belowCostItems,
    draftPlan,
    mirrorOps,
    ownedPairs,
    planHash,
    writeSteps,
    type PlanInputs,
    type PublishActor,
    type PublishTrigger,
    type ResolveMode,
    type SaleRulePlan,
} from './plan';
import { resolveRemote } from './resolve';
import { loadPortalState, type Db } from './state';

export { SaleRulePublishError } from './errors';
export { SALE_RULE_LEAD_MS } from './state';
export type { PublishActor, PublishTrigger, ResolveMode, SaleRulePlan } from './plan';

const TX_OPTIONS = { timeout: 120_000, maxWait: 5_000 };

export async function loadPlanInputs(db: Db): Promise<PlanInputs> {
    const [state, options, channels] = await Promise.all([
        loadPortalState(db),
        getSaleRuleOptions(),
        listChannelsForCatalogSync(),
    ]);
    if (!channels.length)
        throw new SaleRulePublishError(
            'sale_rules_channels_empty',
            'new-api 渠道列表为空，拒绝按空模型清单编译。',
            502,
        );
    return { state, options, channels };
}

/** Plan against already-loaded inputs. Only `resolve: 'always'` (or 'auto' with work) checks customers remotely. */
export async function evaluateSaleRulePlan(
    db: Db,
    inputs: PlanInputs,
    now: Date,
    resolve: ResolveMode,
): Promise<SaleRulePlan> {
    const draft = draftPlan(inputs, now);
    const liveRows = draft.live.groupGroupRatio;
    let owned = ownedPairs(draft.compile, draft.groups, new Set());
    let nextRows = mergeGroupGroupRatio(liveRows, owned, draft.compile.customerRows);
    const pending =
        !sameRatioMaps(draft.live.groupRatio, draft.nextGroupRatio) ||
        !sameRatioMaps(liveRows, nextRows) ||
        mirrorOps(inputs.state, owned, nextRows, {}).length > 0;
    const resolution =
        !draft.blocked && (resolve === 'always' || (resolve === 'auto' && pending))
            ? await resolveRemote({ db, state: inputs.state, live: draft.live, owned, nextRows })
            : null;
    const held = new Set(resolution?.held.keys() ?? []);
    if (held.size) {
        owned = ownedPairs(draft.compile, draft.groups, held);
        nextRows = mergeGroupGroupRatio(liveRows, owned, draft.compile.customerRows);
    }
    const diagnostics = [
        ...draft.diagnostics,
        ...(resolution?.held.values() ?? []),
        ...(resolution?.diagnostics ?? []),
    ];
    const moves = resolution?.moves ?? [];
    const belowCost = belowCostItems({
        state: inputs.state,
        owned,
        nextGroupRatio: draft.nextGroupRatio,
        nextRows,
        served: draft.served,
        options: inputs.options,
    });
    for (const item of belowCost)
        diagnostics.push({
            level: 'warn',
            code: 'below_cost',
            message: `${item.model} 售价倍率 ${item.ratio} 低于成本线 ${item.floor.toFixed(6)}。`,
            newapiGroup: item.newapiGroup,
            userId: item.userId ?? undefined,
        });
    const ratios = { liveGroupRatio: draft.live.groupRatio, nextGroupRatio: draft.nextGroupRatio, liveRows, nextRows };
    const heldIds = [...held].sort();
    return {
        now,
        compile: draft.compile,
        owned,
        ...ratios,
        changes: ratioChanges({ ...ratios, owned }),
        moves,
        held: heldIds,
        belowCost,
        diagnostics,
        steps: resolution ? writeSteps({ ...ratios, owned, moves }) : [],
        mirror: resolution ? mirrorOps(inputs.state, owned, nextRows, resolution.originals) : [],
        resolved: resolution !== null,
        blocked: draft.blocked,
        hash: planHash({ ...ratios, owned, moves, held: heldIds, blocked: draft.blocked }),
    };
}

export async function buildSaleRulePlan(db: Db, now: Date, resolve: ResolveMode): Promise<SaleRulePlan> {
    return evaluateSaleRulePlan(db, await loadPlanInputs(db), now, resolve);
}

export interface PublishResult {
    outcome: 'noop' | 'applied';
    publicationId: string | null;
    plan: SaleRulePlan;
    catalogRows: number;
}

export interface PublishOptions {
    trigger: PublishTrigger;
    actor: PublishActor | null;
    /** Hash of the plan the operator previewed; required for manual publishes. */
    expectedHash?: string;
    /** A manual publish that raises any customer's price needs this (spec §6). */
    confirmIncreases?: boolean;
    /** Run the remote customer checks even when nothing differs. */
    verify?: boolean;
}

const hasWork = (plan: SaleRulePlan) => plan.resolved && (plan.steps.length > 0 || plan.mirror.length > 0);

function snapshot(plan: SaleRulePlan, ratios: RatioMap, rows: NestedRatioMap) {
    return Object.fromEntries(
        Object.entries(plan.owned).map(([group, users]) => [
            group,
            {
                ratio: ratios[group] ?? null,
                customers: Object.fromEntries(
                    users.map((userId) => [userId, rows[internalGroupFor(userId)]?.[group] ?? null]),
                ),
            },
        ]),
    );
}

function json(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function translate(error: unknown): Error {
    if (error instanceof SaleRulePublishError) return error;
    if (error instanceof PricingPublishError) return new SaleRulePublishError(error.code, error.message, error.status);
    if (error && typeof error === 'object' && 'code' in error && ['P2028', 'P2034'].includes(String(error.code)))
        return new SaleRulePublishError('pricing_publish_busy', '定价正在修改，请稍后核对再重试。');
    return error instanceof Error ? error : new Error(String(error));
}
/**
 * Compile, check and publish sale rules to new-api. The draft runs without the
 * lock; the publication re-plans inside the pricing coordination transaction so
 * it never acts on a stale read.
 */
export async function publishSaleRules(options: PublishOptions): Promise<PublishResult> {
    const now = new Date();
    const stale = () =>
        new SaleRulePublishError('sale_rules_stale', '售卖规则或 new-api 状态已变化，请重新预览后再发布。');
    const draft = await buildSaleRulePlan(prisma, now, options.expectedHash || options.verify ? 'always' : 'auto');
    if (options.expectedHash && draft.hash !== options.expectedHash) throw stale();
    if (draft.blocked && options.trigger === 'manual')
        throw new SaleRulePublishError('sale_rules_blocked', '存在阻断问题，请先处理后再发布。');
    if (options.trigger === 'manual' && !options.confirmIncreases && draft.changes.some((change) => change.increase))
        throw new SaleRulePublishError('sale_rules_increase_unconfirmed', '本次发布会让部分客户涨价，请确认后再发布。');
    if (!hasWork(draft)) return { outcome: 'noop', publicationId: null, plan: draft, catalogRows: 0 };
    const run = { publicationId: null as string | null };
    let result: { plan: SaleRulePlan; catalogRows: number };
    try {
        result = await prisma.$transaction(async (tx) => {
            await assertPricingCatalogWritable(tx);
            const plan = await buildSaleRulePlan(tx, now, 'always');
            if (options.expectedHash && plan.hash !== options.expectedHash) throw stale();
            if (!hasWork(plan)) return { plan, catalogRows: 0 };
            // The coordination lock is held: any row still applying belongs to a run that died.
            await prisma.pricingRulePublication.updateMany({
                where: { status: 'applying' },
                data: { status: 'interrupted', error: '上一次发布未正常结束' },
            });
            const publication = await prisma.pricingRulePublication.create({
                data: {
                    trigger: options.trigger,
                    actor_id: options.actor?.userId ?? null,
                    actor_email: options.actor?.email ?? null,
                    status: 'applying',
                    target_at: now,
                    preview_hash: options.expectedHash ?? null,
                    before: json(snapshot(plan, plan.liveGroupRatio, plan.liveRows)),
                    after: json(snapshot(plan, plan.nextGroupRatio, plan.nextRows)),
                    diagnostics: json(plan.diagnostics),
                    moves: json(plan.moves),
                },
                select: { id: true },
            });
            run.publicationId = publication.id;
            return { plan, catalogRows: await applyPlan(tx, plan, publication.id, options.actor) };
        }, TX_OPTIONS);
    } catch (error) {
        if (run.publicationId)
            await prisma.pricingRulePublication
                .update({ where: { id: run.publicationId }, data: { status: 'failed', error: errorText(error) } })
                .catch(() => undefined);
        throw translate(error);
    }
    if (!run.publicationId) return { outcome: 'noop', publicationId: null, ...result };
    await prisma.pricingRulePublication
        .update({ where: { id: run.publicationId }, data: { status: 'applied' } })
        .catch((error) =>
            console.error('[pricing-rules] publication applied but its status was not saved', {
                publicationId: run.publicationId,
                error: errorText(error),
            }),
        );
    return { outcome: 'applied', publicationId: run.publicationId, ...result };
}
/** Read-only plan with every remote customer check. Takes no lock and writes nothing. */
export function previewSaleRules(now = new Date()): Promise<SaleRulePlan> {
    return buildSaleRulePlan(prisma, now, 'always');
}

const BUSY_CODES = new Set(['pricing_publish_busy', 'channel_group_retirement_busy']);
let lastBlockKey = '';

/**
 * One scheduler pass. `verify` re-runs the remote customer checks even when
 * nothing differs, so drift made outside Portal is reported and repaired.
 * Busy coordination is a skip, not an error.
 */
export async function runSaleRuleSchedulerTick(
    verify = false,
): Promise<{ outcome: 'noop' | 'applied' | 'busy'; publicationId: string | null }> {
    try {
        const result = await publishSaleRules({ trigger: 'scheduler', actor: null, verify });
        if (result.plan.resolved || result.plan.blocked) {
            const blocks = result.plan.diagnostics
                .filter((item) => item.level === 'block')
                .map((item) => ({ code: item.code, group: item.newapiGroup, user: item.userId }));
            const key = JSON.stringify(blocks);
            if (key !== lastBlockKey && blocks.length)
                console.warn('[pricing-rules] sale rules blocked', {
                    count: blocks.length,
                    blocks: blocks.slice(0, 20),
                });
            lastBlockKey = key;
        }
        return { outcome: result.outcome, publicationId: result.publicationId };
    } catch (error) {
        if (error instanceof SaleRulePublishError && BUSY_CODES.has(error.code))
            return { outcome: 'busy', publicationId: null };
        throw error;
    }
}

export async function listSaleRulePublications(take = 30) {
    return prisma.pricingRulePublication.findMany({
        orderBy: { created_at: 'desc' },
        take: Math.min(Math.max(1, take), 100),
        select: {
            id: true,
            trigger: true,
            actor_email: true,
            status: true,
            target_at: true,
            before: true,
            after: true,
            diagnostics: true,
            moves: true,
            error: true,
            created_at: true,
        },
    });
}
