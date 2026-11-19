import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { assertPricingCatalogWritable, lockPricingPublisherReadOnly } from '@/lib/admin/pricing-publish-lock';
import { listTokensForCustomer, setChannelStatusStrict } from '@/lib/newapi/client';
import { invalidateSystemTokenCache } from '@/lib/newapi/system-token';
import { invalidateEffectiveRatioCache } from '@/lib/newapi/effective-group-ratios';
import { loadOfficialContext } from './context';
import { assertTierOutsideSaleRules } from './guards';
import { compileCustomerPreview } from './preview';
import { CustomerPricingError } from './math';
import {
    prepareNativeModelGroups,
    publishNativeCustomerPricing,
    restoreNativeCustomerPricing,
    rollbackNativeSnapshot,
    type NativeCustomerAuth,
    type NativeJournal,
    type NativePreviousBinding,
    type NativeSnapshot,
    type SafeTokenSnapshot,
    type NativeAutoPermissions,
} from './native';
import type { OfficialPricingDraft } from './types';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const TX = { timeout: 180000, maxWait: 5000 };
type Binding = Awaited<ReturnType<typeof prisma.customerPricingBinding.findMany>>[number];

function prior(row: Binding): NativePreviousBinding {
    if (!Array.isArray(row.model_groups) || !row.model_groups.length || !Array.isArray(row.token_snapshots))
        throw new CustomerPricingError('binding_invalid', '原客户计费绑定不完整，不能猜测恢复目标。');
    return {
        model_groups: row.model_groups as string[],
        token_snapshots: row.token_snapshots as unknown as SafeTokenSnapshot[],
        original_user_group: row.original_user_group,
        original_auto_permissions: row.original_auto_permissions as unknown as NativeAutoPermissions,
    };
}

/** Internal service tokens are owned by the customer too, but are not in the public Key table. */
async function tierTokenIds(
    auth: NativeCustomerAuth,
    publicGroup: string,
    currentGroups: string[],
    portalIds: number[],
) {
    const ids = new Set(portalIds);
    for (let page = 1; page <= 100; page += 1) {
        const result = await listTokensForCustomer(auth, page, 100);
        for (const token of result.items) {
            if (token.user_id !== auth.userId) throw new CustomerPricingError('token_owner', 'Key 所属用户核验失败。');
            const internal = token.name === 'portal-internal' || token.name === `portal-internal-${publicGroup}`;
            const sameAuto =
                token.group === 'auto' &&
                currentGroups.length > 0 &&
                Array.isArray(token.auto_groups) &&
                token.auto_groups.length === currentGroups.length &&
                token.auto_groups.every((g, i) => g === currentGroups[i]);
            if (internal && (token.group === publicGroup || sameAuto)) ids.add(token.id);
        }
        if (page * 100 >= result.total || !result.items.length) return [...ids].sort((a, b) => a - b);
    }
    throw new CustomerPricingError('too_many_tokens', 'Key 数量超过完整核验上限，未执行迁移。');
}

export interface SaveOfficialPricingArgs {
    userId: string;
    actorId: string | null;
    draft: OfficialPricingDraft;
    expectedVersion: string;
    previewHash: string;
    confirmBelowCost: boolean;
    confirmIncreases: boolean;
}

export async function saveCustomerOfficialPricing(args: SaveOfficialPricingArgs) {
    let changeId: string | null = null;
    let latest: NativeJournal | null = null;
    let auth: NativeCustomerAuth | null = null;
    let oldBinding: Binding | null = null;
    let bindingTouched = false;
    let modelGroups: string[] = [];
    const registryRows: string[] = [];
    const registryStatuses = new Map<string, string>();
    let newapiUserId: number | null = null;
    let successfulResult: { unchanged: boolean; affected_keys: number; change_id?: string } | null = null;
    try {
        const result = await prisma.$transaction(async (tx) => {
            await assertPricingCatalogWritable(tx);
            const context = await loadOfficialContext(args.userId, tx);
            const portalKeys = await tx.newApiToken.findMany({
                where: { user_id: args.userId, tier: args.draft.tier_key, status: 'active' },
                select: { newapi_token_id: true },
            });
            const plan = compileCustomerPreview(context, args.draft, portalKeys.length);
            if (args.expectedVersion !== context.version || args.previewHash !== plan.preview.hash)
                throw new CustomerPricingError('preview_stale', '价格、Key 或规则已经变化，请重新预览后确认。');
            if (plan.preview.blocked.length)
                throw new CustomerPricingError('preview_blocked', plan.preview.blocked.join('；'));
            if (plan.preview.below_cost && !args.confirmBelowCost)
                throw new CustomerPricingError(
                    'below_cost_unconfirmed',
                    '至少一个模型会低于采购成本，请在预览中明确确认。',
                );
            if (plan.preview.has_increases && !args.confirmIncreases)
                throw new CustomerPricingError('increase_unconfirmed', '该客户部分价格会上涨，请在预览中确认。');
            await assertTierOutsideSaleRules(plan.tier.key);
            const unfinished = await tx.customerPricingChange.findFirst({
                where: { tier_key: plan.tier.key, status: { in: ['preparing', 'applying', 'failed'] } },
                select: { id: true },
            });
            if (unfinished)
                throw new CustomerPricingError(
                    'unfinished_change',
                    `该分组有尚未核验的定价发布（${unfinished.id}），请先恢复。`,
                );
            if (!context.user.newapi_user_id || !context.user.newapi_access_token)
                throw new CustomerPricingError('customer_not_provisioned', '客户尚未完成 new-api 开户。');
            newapiUserId = context.user.newapi_user_id;
            auth = { userId: newapiUserId, accessToken: context.user.newapi_access_token };
            oldBinding = context.bindings.find((b) => b.tier_key === plan.tier.key) ?? null;
            if (plan.restoring && !oldBinding) return { unchanged: true, affected_keys: 0 };
            const earliest = context.bindings[0];
            const created = await prisma.customerPricingChange.create({
                data: {
                    user_id: args.userId,
                    tier_key: plan.tier.key,
                    actor_id: args.actorId,
                    status: 'preparing',
                    before: json({
                        binding: oldBinding,
                        rules: context.rules.filter((r) => r.tier_key === plan.tier.key),
                    }),
                    after: json({ draft: args.draft, preview: plan.preview }),
                    progress: {},
                },
            });
            changeId = created.id;
            const progress = async (snapshot: NativeJournal) => {
                latest = structuredClone(snapshot);
                await prisma.customerPricingChange.update({
                    where: { id: created.id },
                    data: { progress: json(snapshot) },
                });
                // Keep known copies out of public directory mirroring even when preparation later fails.
                if (snapshot.operation === 'prepare') {
                    for (const group of new Set(snapshot.created_channels.map((c) => c.group)))
                        await prisma.customerModelBillingGroup.updateMany({
                            where: { internal_group: group },
                            data: {
                                replica_channel_ids: snapshot.created_channels
                                    .filter((c) => c.group === group)
                                    .map((c) => c.id),
                            },
                        });
                }
                if (!/rollback|cleanup|unpublished|failed_replica/.test(snapshot.phase)) await tx.$queryRaw`SELECT 1`;
            };
            modelGroups = plan.models.map((m) => m.group);
            if (!plan.restoring) {
                for (const model of plan.models) {
                    const row = await prisma.customerModelBillingGroup.upsert({
                        where: { tier_key_model_id: { tier_key: plan.tier.key, model_id: model.model_id } },
                        create: {
                            tenant_id: context.user.tenant_id ?? PLATFORM_TENANT_ID,
                            tier_key: plan.tier.key,
                            model_id: model.model_id,
                            model_name: model.model_name,
                            public_group: plan.tier.public_group,
                            internal_group: model.group,
                            source_channel_ids: model.source_channel_ids,
                            replica_channel_ids: [],
                            source_fingerprint: '',
                            status: 'preparing',
                        },
                        update: {},
                    });
                    registryRows.push(row.id);
                    registryStatuses.set(model.group, row.status);
                }
                const prepared = await prepareNativeModelGroups(plan.models, progress);
                for (const model of prepared)
                    await prisma.customerModelBillingGroup.update({
                        where: { internal_group: model.group },
                        data: {
                            replica_channel_ids: model.replica_channel_ids,
                            source_fingerprint: model.source_fingerprint,
                            // Shared replicas may already serve another customer's active
                            // binding. Preparing an additional customer must not downgrade them.
                            status: registryStatuses.get(model.group) === 'active' ? 'active' : 'ready',
                        },
                    });
                plan.models = prepared;
            }
            await prisma.customerPricingBinding.upsert({
                where: { user_id_tier_key: { user_id: args.userId, tier_key: plan.tier.key } },
                create: {
                    user_id: args.userId,
                    tier_key: plan.tier.key,
                    public_group: plan.tier.public_group,
                    model_groups: modelGroups,
                    token_snapshots: [],
                    original_user_group: earliest?.original_user_group ?? '',
                    original_auto_permissions: earliest?.original_auto_permissions ?? {},
                    status: 'applying',
                },
                update: { status: 'applying' },
            });
            bindingTouched = true;
            await prisma.customerPricingChange.update({ where: { id: created.id }, data: { status: 'applying' } });
            const ids = await tierTokenIds(
                auth,
                plan.tier.public_group,
                oldBinding ? prior(oldBinding).model_groups : [],
                portalKeys.map((k) => k.newapi_token_id),
            );
            if (plan.restoring) {
                await restoreNativeCustomerPricing(
                    {
                        customerAuth: auth,
                        portalUserId: args.userId,
                        publicGroup: plan.tier.public_group,
                        portalTokenIds: ids,
                        previousBinding: prior(oldBinding!),
                        otherActiveBindings: context.bindings
                            .filter((b) => b.tier_key !== plan.tier.key && b.status === 'active')
                            .map((b) => prior(b)),
                    },
                    progress,
                );
                await tx.customerPricingBinding.delete({
                    where: { user_id_tier_key: { user_id: args.userId, tier_key: plan.tier.key } },
                });
            } else {
                const publication = await publishNativeCustomerPricing(
                    {
                        customerAuth: auth,
                        portalUserId: args.userId,
                        publicGroup: plan.tier.public_group,
                        models: plan.models,
                        portalTokenIds: ids,
                        ...(oldBinding ? { previousBinding: prior(oldBinding) } : {}),
                        ...(earliest
                            ? {
                                  originalUserGroup: earliest.original_user_group,
                                  originalAutoPermissions:
                                      earliest.original_auto_permissions as unknown as NativeAutoPermissions,
                              }
                            : {}),
                    },
                    progress,
                );
                await tx.customerPricingBinding.update({
                    where: { user_id_tier_key: { user_id: args.userId, tier_key: plan.tier.key } },
                    data: {
                        model_groups: publication.model_groups,
                        token_snapshots: json(publication.token_snapshots),
                        original_user_group: publication.original_user_group,
                        original_auto_permissions: json(publication.original_auto_permissions),
                        status: 'active',
                        revision: { increment: 1 },
                    },
                });
                await tx.customerModelBillingGroup.updateMany({
                    where: { internal_group: { in: publication.model_groups } },
                    data: { status: 'active' },
                });
            }
            const where = {
                user_id_tier_key_model_key: {
                    user_id: args.userId,
                    tier_key: args.draft.tier_key,
                    model_key: args.draft.model_id ?? '*',
                },
            };
            if (args.draft.official_multiplier === null)
                await tx.customerOfficialPriceRule.deleteMany({ where: where.user_id_tier_key_model_key });
            else
                await tx.customerOfficialPriceRule.upsert({
                    where,
                    create: {
                        tenant_id: context.user.tenant_id ?? PLATFORM_TENANT_ID,
                        ...where.user_id_tier_key_model_key,
                        official_multiplier: args.draft.official_multiplier,
                        created_by: args.actorId,
                    },
                    update: { official_multiplier: args.draft.official_multiplier, revision: { increment: 1 } },
                });
            await tx.adminAuditLog.create({
                data: {
                    admin_user_id: args.actorId,
                    level: 'super',
                    action: 'customer_official_pricing',
                    target: args.userId,
                    params: JSON.stringify({ change_id: created.id, draft: args.draft, affected_keys: ids.length }),
                    method: 'POST',
                    path: `/api/admin/customers/${args.userId}/official-pricing`,
                    client_ip: null,
                    user_agent: null,
                },
            });
            await tx.customerPricingChange.update({ where: { id: created.id }, data: { status: 'applied' } });
            successfulResult = { unchanged: false, affected_keys: ids.length, change_id: created.id };
            return successfulResult;
        }, TX);
        invalidateSystemTokenCache(args.userId);
        if (newapiUserId) invalidateEffectiveRatioCache(newapiUserId);
        return result;
    } catch (error) {
        let commitUncertain = false;
        // A lost COMMIT acknowledgement must not undo native prices after the local rules committed.
        if (changeId && successfulResult) {
            const id = changeId;
            const marker = await prisma
                .$transaction(
                    async (tx) => {
                        // Wait for the original transaction's commit/rollback before inspecting its commit marker.
                        await lockPricingPublisherReadOnly(tx);
                        return tx.customerPricingChange.findUnique({ where: { id }, select: { status: true } });
                    },
                    { timeout: 20000, maxWait: 5000 },
                )
                .catch(() => null);
            if (marker?.status === 'applied') {
                invalidateSystemTokenCache(args.userId);
                if (newapiUserId) invalidateEffectiveRatioCache(newapiUserId);
                return successfulResult;
            }
            commitUncertain = marker === null;
        }
        let restored = !commitUncertain;
        const snapshot = latest as NativeSnapshot | null;
        if (!commitUncertain && snapshot && snapshot.operation !== 'prepare' && auth) {
            try {
                await rollbackNativeSnapshot(snapshot, auth, async (progress) => {
                    if (changeId)
                        await prisma.customerPricingChange.update({
                            where: { id: changeId },
                            data: { progress: json(progress) },
                        });
                });
            } catch {
                restored = false;
            }
        } else if (snapshot?.operation === 'prepare' && (snapshot.pending_copy || snapshot.phase.includes('cleanup')))
            restored = false;
        if (bindingTouched) {
            if (restored) {
                const original = oldBinding as Binding | null;
                if (original)
                    await prisma.customerPricingBinding.update({
                        where: { id: original.id },
                        data: {
                            status: original.status,
                            model_groups: json(original.model_groups),
                            token_snapshots: json(original.token_snapshots),
                            original_user_group: original.original_user_group,
                            original_auto_permissions: json(original.original_auto_permissions),
                            revision: original.revision,
                        },
                    });
                else
                    await prisma.customerPricingBinding.deleteMany({
                        where: { user_id: args.userId, tier_key: args.draft.tier_key },
                    });
            } else
                await prisma.customerPricingBinding.updateMany({
                    where: { user_id: args.userId, tier_key: args.draft.tier_key },
                    data: { status: 'failed' },
                });
        }
        if (!restored) {
            // An uncertain native state must not continue accepting calls on its private replicas.
            const groups = await prisma.customerModelBillingGroup.findMany({
                where: { internal_group: { in: modelGroups } },
            });
            for (const id of new Set(groups.flatMap((g) => g.replica_channel_ids))) {
                try {
                    await setChannelStatusStrict(id, 2);
                } catch {
                    /* Persist the failed state below for recovery. */
                }
            }
        }
        if (changeId)
            await prisma.customerPricingChange.update({
                where: { id: changeId },
                data: {
                    status: restored ? 'compensated' : 'failed',
                    error: error instanceof CustomerPricingError ? error.message : '发布未完成，请根据记录核验。',
                },
            });
        if (registryRows.length && snapshot?.operation === 'prepare')
            await prisma.customerModelBillingGroup.updateMany({
                where: { id: { in: registryRows }, status: 'preparing' },
                data: { status: 'failed' },
            });
        invalidateSystemTokenCache(args.userId);
        if (newapiUserId) invalidateEffectiveRatioCache(newapiUserId);
        if (!restored)
            throw new CustomerPricingError(
                'publication_uncertain',
                `客户价格未能完整核验，已尝试暂停内部渠道，请先恢复发布记录 ${changeId}。`,
                503,
            );
        throw error;
    }
}
