import 'server-only';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { assertPricingCatalogWritable } from '@/lib/admin/pricing-publish-lock';
import { getChannelStrict, listChannelsForCatalogSync, setChannelStatusStrict } from '@/lib/newapi/client';
import { invalidateSystemTokenCache } from '@/lib/newapi/system-token';
import { invalidateEffectiveRatioCache } from '@/lib/newapi/effective-group-ratios';
import { CustomerPricingError } from './math';
import { rollbackNativeSnapshot, type NativeSnapshot } from './native';
import { recoverCustomerPricingRebase } from './rebase';

const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new CustomerPricingError('recovery_invalid', '恢复记录不完整，未猜测恢复目标。');
    return value as Record<string, unknown>;
};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const id = z.number().int().positive().safe();
const assignment = z
    .object({
        group: z.string().min(1),
        auto_groups: z.array(z.string().min(1)).nullable().optional(),
        cross_group_retry: z.boolean().optional(),
    })
    .passthrough();
const journalSchema = z.object({
    version: z.literal(1),
    operation: z.enum(['prepare', 'publish', 'restore']),
    phase: z.string(),
    options: z.array(
        z.object({
            key: z.enum([
                'GroupRatio',
                'GroupGroupRatio',
                'group_ratio_setting.group_ratio',
                'group_ratio_setting.group_group_ratio',
                'group_ratio_setting.group_special_usable_group',
                'MaxTokenAutoGroups',
            ]),
            before: z.string().nullable(),
            after: z.string(),
            attempted: z.boolean(),
            verified: z.boolean(),
        }),
    ),
    tokens: z.array(
        z.object({
            before: assignment.extend({ id, user_id: id, status: z.number().int() }),
            after: assignment,
            attempted: z.boolean(),
            verified: z.boolean(),
        }),
    ),
    user: z
        .object({
            id,
            before_group: z.string().min(1),
            after_group: z.string().min(1),
            attempted: z.boolean(),
            verified: z.boolean(),
        })
        .nullable(),
    created_channels: z.array(
        z.object({ id, source_id: id, group: z.string().min(1), model: z.string().min(1), configured: z.boolean() }),
    ),
    pending_copy: z
        .object({ source_id: id, suffix: z.string().min(1), group: z.string().min(1), model: z.string().min(1) })
        .nullable(),
});

function journal(value: unknown, nativeUserId: number): NativeSnapshot {
    const parsed = journalSchema.safeParse(value);
    if (
        !parsed.success ||
        (parsed.data.user && parsed.data.user.id !== nativeUserId) ||
        parsed.data.tokens.some((entry) => entry.before.user_id !== nativeUserId)
    )
        throw new CustomerPricingError('recovery_invalid', '原生发布恢复记录不完整。');
    return parsed.data as unknown as NativeSnapshot;
}

async function stopPreparedCopies(snapshot: NativeSnapshot) {
    const ids = new Set(snapshot.created_channels.map((c) => c.id));
    if (snapshot.pending_copy) {
        const pending = snapshot.pending_copy;
        const source = await getChannelStrict(pending.source_id);
        // The generated suffix includes both the private group and source ID;
        // matching it also survives an operator renaming the original source.
        const copies = (await listChannelsForCatalogSync()).filter(
            (c) => c.id !== source.id && typeof c.name === 'string' && c.name.endsWith(pending.suffix),
        );
        // The complete inventory contains no matching channel when the copy did not persist.
        if (copies.length > 1)
            throw new CustomerPricingError('recovery_ambiguous_copy', '发现多个同名渠道副本，请先核验归属。');
        for (const copy of copies) ids.add(copy.id);
    }
    for (const id of ids) await setChannelStatusStrict(id, 2);
}

/** Retryable recovery restores the last committed contract using its durable before-images. */
export async function recoverCustomerOfficialPricing(args: {
    userId: string;
    changeId: string;
    actorId: string | null;
}) {
    const result = await prisma.$transaction(
        async (tx) => {
            await assertPricingCatalogWritable(tx);
            const change = await tx.customerPricingChange.findFirst({
                where: { id: args.changeId, user_id: args.userId },
            });
            if (!change) throw new CustomerPricingError('change_missing', '发布记录不存在。', 404);
            // An applied marker committed atomically with local rules: never roll back a successful COMMIT.
            if (['applied', 'compensated'].includes(change.status)) return { unchanged: true, change_id: change.id };
            if (!['preparing', 'applying', 'failed'].includes(change.status))
                throw new CustomerPricingError('recovery_status', '该记录当前不能恢复。');
            const before = object(change.before);
            const user = await tx.user.findUnique({
                where: { id: args.userId },
                select: { newapi_user_id: true, newapi_access_token: true },
            });
            if (!user?.newapi_user_id || !user.newapi_access_token)
                throw new CustomerPricingError('customer_not_provisioned', '无法取得客户原生计费身份。');
            if (before.operation === 'public_price_rebase') {
                const siblings = await tx.customerPricingChange.findMany({
                    where: { before: { path: ['operation_id'], equals: String(before.operation_id) } },
                });
                if (siblings.some((s) => s.status === 'applied'))
                    throw new CustomerPricingError(
                        'recovery_conflict',
                        '同一改价操作已存在成功标记，需先核验提交结果。',
                    );
                await recoverCustomerPricingRebase(change.before, change.after);
                await tx.customerPricingBinding.updateMany({
                    where: { OR: siblings.map((s) => ({ user_id: s.user_id, tier_key: s.tier_key })) },
                    data: { status: 'active' },
                });
                await tx.customerPricingChange.updateMany({
                    where: { id: { in: siblings.map((s) => s.id) } },
                    data: { status: 'compensated', error: null, progress: { phase: 'original_prices_restored' } },
                });
            } else {
                const progress = object(change.progress);
                // A crash before the first journal has not made any remote write.
                if (Object.keys(progress).length) {
                    const snapshot = journal(progress, user.newapi_user_id);
                    if (snapshot.operation === 'prepare') {
                        await stopPreparedCopies(snapshot);
                        const createdGroups = [...new Set(snapshot.created_channels.map((c) => c.group))];
                        if (snapshot.pending_copy) createdGroups.push(snapshot.pending_copy.group);
                        await tx.customerModelBillingGroup.updateMany({
                            where: { internal_group: { in: createdGroups } },
                            data: { replica_channel_ids: [], source_fingerprint: '', status: 'preparing' },
                        });
                    } else
                        await rollbackNativeSnapshot(
                            snapshot,
                            { userId: user.newapi_user_id, accessToken: user.newapi_access_token },
                            async (next) => {
                                await prisma.customerPricingChange.update({
                                    where: { id: change.id },
                                    data: { progress: json(next) },
                                });
                            },
                        );
                    if (snapshot.operation !== 'prepare') {
                        const groups = await tx.customerModelBillingGroup.findMany({
                            where: { tier_key: change.tier_key },
                        });
                        for (const group of groups)
                            for (const id of group.replica_channel_ids) {
                                const channel = await getChannelStrict(id);
                                if (channel.group !== group.internal_group || channel.models !== group.model_name)
                                    throw new CustomerPricingError(
                                        'recovery_conflict',
                                        '渠道归属已经变化，未重新启用。',
                                    );
                                await setChannelStatusStrict(id, 1);
                            }
                    }
                }
                const original = before.binding;
                if (original === null) {
                    await tx.customerPricingBinding.deleteMany({
                        where: { user_id: args.userId, tier_key: change.tier_key },
                    });
                } else {
                    const row = object(original);
                    if (row.user_id !== args.userId || row.tier_key !== change.tier_key || row.status !== 'active')
                        throw new CustomerPricingError('recovery_invalid', '原计费绑定不能核对。');
                    const data = {
                        public_group: String(row.public_group),
                        model_groups: json(row.model_groups),
                        token_snapshots: json(row.token_snapshots),
                        original_user_group: String(row.original_user_group),
                        original_auto_permissions: json(row.original_auto_permissions),
                        status: 'active',
                        revision: Number(row.revision),
                    };
                    await tx.customerPricingBinding.upsert({
                        where: { user_id_tier_key: { user_id: args.userId, tier_key: change.tier_key } },
                        create: { user_id: args.userId, tier_key: change.tier_key, ...data },
                        update: data,
                    });
                }
                // An older interrupted preparation may have downgraded reused registry
                // rows to ready. Restore every still-serving shared group only after
                // checking the channel identities; never clear its existing replicas.
                const activeBindings = await tx.customerPricingBinding.findMany({
                    where: { tier_key: change.tier_key, status: 'active' },
                    select: { model_groups: true },
                });
                const activeGroups = [
                    ...new Set(
                        activeBindings.flatMap((binding) => {
                            if (
                                !Array.isArray(binding.model_groups) ||
                                binding.model_groups.some((group) => typeof group !== 'string')
                            )
                                throw new CustomerPricingError('recovery_invalid', '活动客户计费分组无法核对。');
                            return binding.model_groups as string[];
                        }),
                    ),
                ];
                if (activeGroups.length) {
                    const shared = await tx.customerModelBillingGroup.findMany({
                        where: { tier_key: change.tier_key, internal_group: { in: activeGroups } },
                    });
                    if (shared.length !== activeGroups.length)
                        throw new CustomerPricingError('recovery_invalid', '活动客户的模型计费登记缺失。');
                    for (const group of shared) {
                        if (!group.replica_channel_ids.length)
                            throw new CustomerPricingError('recovery_invalid', '活动客户的模型计费渠道缺失。');
                        for (const id of group.replica_channel_ids) {
                            const channel = await getChannelStrict(id);
                            if (channel.group !== group.internal_group || channel.models !== group.model_name)
                                throw new CustomerPricingError('recovery_conflict', '共享计费渠道归属变化，未覆盖。');
                            await setChannelStatusStrict(id, 1);
                        }
                    }
                    await tx.customerModelBillingGroup.updateMany({
                        where: { internal_group: { in: activeGroups } },
                        data: { status: 'active' },
                    });
                }
                await tx.customerPricingChange.update({
                    where: { id: change.id },
                    data: { status: 'compensated', error: null },
                });
            }
            await tx.adminAuditLog.create({
                data: {
                    admin_user_id: args.actorId,
                    level: 'super',
                    action: 'customer_official_pricing_recover',
                    target: args.userId,
                    params: JSON.stringify({ change_id: change.id }),
                    method: 'POST',
                    path: `/api/admin/customers/${args.userId}/official-pricing`,
                },
            });
            invalidateSystemTokenCache(args.userId);
            invalidateEffectiveRatioCache(user.newapi_user_id);
            return { unchanged: false, change_id: change.id };
        },
        { timeout: 180000, maxWait: 5000 },
    );
    return result;
}
