import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { OptionWrite } from '@/lib/admin/pricing-simple-core';
import {
    getChannelStrict,
    getPricingPublishOptions,
    putOption,
    putSaleRuleOption,
    setChannelStatusStrict,
} from '@/lib/newapi/client';
import { internalNewApiUserGroup } from '@/lib/newapi/user-tier-multiplier';
import { GROUP_GROUP_RATIO_KEYS, mirrorRowPresent, parseNestedRatioMap } from '@/lib/pricing-rules/options';
import { loadOfficialContext } from './context';
import { compileOfficialRatio, CustomerPricingError, fingerprint, selectOfficialRule } from './math';

type Options = Record<string, unknown>;
type Writer = (writes: OptionWrite[]) => Promise<Options>;
type Delta = {
    key: OptionWrite['key'];
    entry: string;
    before: unknown;
    after: unknown;
    hadBefore: boolean;
    hasAfter: boolean;
};
type Owned = Record<string, Record<string, number>>;
type Replica = { id: number; status: number; group: string; model: string };

function dictionary(raw: unknown): Record<string, unknown> {
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new CustomerPricingError('pricing_options_invalid', '无法读取完整计费配置，拒绝改价。');
    return value as Record<string, unknown>;
}
const same = (left: unknown, right: unknown) => fingerprint(left ?? null) === fingerprint(right ?? null);
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

function deltasFor(before: Options, writes: OptionWrite[]): Delta[] {
    return writes.flatMap((write) => {
        const old = dictionary(before[write.key]);
        const next = dictionary(write.value);
        return [...new Set([...Object.keys(old), ...Object.keys(next)])].flatMap((entry) => {
            const hadBefore = Object.hasOwn(old, entry),
                hasAfter = Object.hasOwn(next, entry);
            return hadBefore === hasAfter && same(old[entry], next[entry])
                ? []
                : [
                      {
                          key: write.key,
                          entry,
                          before: old[entry],
                          after: next[entry],
                          hadBefore,
                          hasAfter,
                      },
                  ];
        });
    });
}

/** Merge only this operation's entries, preserving unrelated option edits. */
function deltaWrites(current: Options, deltas: Delta[], direction: 'after' | 'before'): OptionWrite[] {
    const maps = new Map<OptionWrite['key'], Record<string, unknown>>();
    for (const delta of deltas) {
        const live = maps.get(delta.key) ?? { ...dictionary(current[delta.key]) };
        const exists = Object.hasOwn(live, delta.entry);
        const isBefore = exists === delta.hadBefore && same(live[delta.entry], delta.before);
        const isAfter = exists === delta.hasAfter && same(live[delta.entry], delta.after);
        if (direction === 'after' ? !isBefore : !isBefore && !isAfter)
            throw new CustomerPricingError('pricing_rebase_stale', '计费配置被其他操作修改，请重新核对后再改价。');
        const present = direction === 'after' ? delta.hasAfter : delta.hadBefore;
        if (present) live[delta.entry] = delta[direction];
        else delete live[delta.entry];
        maps.set(delta.key, live);
    }
    return deltas.map((delta) => ({
        key: delta.key,
        value: maps.get(delta.key)!,
        entry: delta.entry,
        target: direction === 'after' ? delta.after : delta.before,
    }));
}

function verifyDeltas(options: Options, deltas: Delta[], direction: 'before' | 'after'): boolean {
    return deltas.every((delta) => {
        const dict = dictionary(options[delta.key]);
        return (
            Object.hasOwn(dict, delta.entry) === (direction === 'after' ? delta.hasAfter : delta.hadBefore) &&
            same(dict[delta.entry], delta[direction])
        );
    });
}

function ownedMatches(options: Options, expected: Owned): boolean {
    for (const key of GROUP_GROUP_RATIO_KEYS) {
        if (key !== GROUP_GROUP_RATIO_KEYS[0] && !mirrorRowPresent(options, key)) continue;
        const rows = parseNestedRatioMap(options[key], key);
        for (const [user, groups] of Object.entries(expected))
            for (const [group, ratio] of Object.entries(groups)) if (rows[user]?.[group] !== ratio) return false;
    }
    return true;
}

async function writeOwnedRows(target: Owned, acceptable: Owned[]): Promise<void> {
    const options = await getPricingPublishOptions();
    const current = parseNestedRatioMap(options.GroupGroupRatio, 'GroupGroupRatio');
    for (const [user, groups] of Object.entries(target)) {
        const row = { ...(current[user] ?? {}) };
        for (const [group, ratio] of Object.entries(groups)) {
            if (!acceptable.some((expected) => expected[user]?.[group] === row[group]))
                throw new CustomerPricingError('pricing_rebase_stale', '客户倍率在改价过程中变化，拒绝覆盖。');
            row[group] = ratio;
        }
        current[user] = row;
    }
    let failure: unknown;
    for (const key of GROUP_GROUP_RATIO_KEYS) {
        if (key !== GROUP_GROUP_RATIO_KEYS[0] && !mirrorRowPresent(options, key)) continue;
        try {
            await putSaleRuleOption(key, JSON.stringify(current));
        } catch (error) {
            failure = error;
        }
    }
    if (!ownedMatches(await getPricingPublishOptions(), target))
        throw failure ?? new CustomerPricingError('pricing_rebase_unverified', '客户倍率回读不一致。', 502);
}

/** Called under the existing pricing mutex. Prices stay absolute while public bases change. */
export async function withCustomerPricingRebase(
    tx: Prisma.TransactionClient,
    writes: OptionWrite[],
    rawWriter: Writer,
    meta: { beforeOptions?: Options; actorId?: string | null } = {},
): Promise<Options> {
    const bindings = await tx.customerPricingBinding.findMany({});
    if (bindings.some((binding) => binding.status !== 'active'))
        throw new CustomerPricingError('pricing_rebase_pending', '有客户定价尚未核验，请先恢复发布再修改公共价格。');
    // Preserve the old path's network calls and semantics for an unconfigured deployment.
    if (!bindings.length || !writes.length) return rawWriter(writes);
    const before = meta.beforeOptions ?? (await getPricingPublishOptions());
    const deltas = deltasFor(before, writes);
    if (!deltas.length) return rawWriter(writes);
    const after = { ...before, ...Object.fromEntries(writes.map((w) => [w.key, w.value])) };
    const previousRows = parseNestedRatioMap(before.GroupGroupRatio, 'GroupGroupRatio');
    const oldOwned: Owned = {},
        nextOwned: Owned = {};
    const replicas = new Map<number, Replica>();
    const affected: typeof bindings = [];
    const contexts = new Map<string, Awaited<ReturnType<typeof loadOfficialContext>>>();

    for (const binding of bindings) {
        const context =
            contexts.get(binding.user_id) ??
            (await loadOfficialContext(binding.user_id, tx, { pricingOptions: after }));
        contexts.set(binding.user_id, context);
        const tier = context.tiers.find((t) => t.key === binding.tier_key && t.public_group === binding.public_group);
        if (!tier) throw new CustomerPricingError('pricing_rebase_binding', '客户专属定价的原分组不可用。');
        const models = tier.models.filter((model) =>
            deltas.some((delta) =>
                delta.key === 'GroupRatio' || delta.key === 'group_ratio_setting.group_ratio'
                    ? delta.entry === tier.public_group
                    : delta.entry === model.model_name,
            ),
        );
        if (!models.length) continue;
        const groups = binding.model_groups;
        if (!Array.isArray(groups) || !groups.length || groups.some((g) => typeof g !== 'string'))
            throw new CustomerPricingError('pricing_rebase_binding', '客户专属计费分组未核验。');
        const userGroup = internalNewApiUserGroup(binding.user_id);
        oldOwned[userGroup] ??= {};
        nextOwned[userGroup] ??= {};
        for (const model of models) {
            const registry = context.registry.find((r) => r.tier_key === tier.key && r.model_id === model.model_id);
            if (
                !registry ||
                registry.status !== 'active' ||
                !groups.includes(registry.internal_group) ||
                !registry.replica_channel_ids.length
            )
                throw new CustomerPricingError('pricing_rebase_binding', '模型的专属计费渠道未完成核验。');
            const previous = previousRows[userGroup]?.[registry.internal_group];
            if (!(typeof previous === 'number' && Number.isFinite(previous) && previous > 0))
                throw new CustomerPricingError('pricing_rebase_binding', '客户原生专属倍率缺失。');
            const rule = selectOfficialRule(context.rules, tier.key, model.model_id);
            const next = rule
                ? compileOfficialRatio(model, rule.official_multiplier)
                : (tier.legacy_multiplier ?? tier.public_ratio);
            if (!(next > 0 && Number.isFinite(next)))
                throw new CustomerPricingError('pricing_rebase_ratio', '无法计算客户实际倍率。');
            oldOwned[userGroup][registry.internal_group] = previous;
            nextOwned[userGroup][registry.internal_group] = next;
            for (const id of registry.replica_channel_ids) {
                const old = replicas.get(id);
                if (old && (old.group !== registry.internal_group || old.model !== model.model_name))
                    throw new CustomerPricingError('pricing_rebase_replica', '专属渠道归属重复，拒绝改价。');
                if (!old) replicas.set(id, { id, status: 0, group: registry.internal_group, model: model.model_name });
            }
        }
        affected.push(binding);
    }
    if (!affected.length) return rawWriter(writes);
    // Validate every replica before pausing any one of them.
    for (const replica of replicas.values()) {
        const channel = await getChannelStrict(replica.id);
        const models = typeof channel.models === 'string' ? channel.models.split(',').map((s) => s.trim()) : [];
        if (
            channel.group !== replica.group ||
            models.length !== 1 ||
            models[0] !== replica.model ||
            ![1, 2, 3].includes(Number(channel.status))
        )
            throw new CustomerPricingError('pricing_rebase_replica', '专属渠道已被外部修改，请先核对。');
        replica.status = Number(channel.status);
    }

    const operationId = randomUUID();
    const logs: string[] = [];
    const activeReplicas = [...replicas.values()].filter((r) => r.status === 1);
    let remoteAttempted = false;
    let verifiedOptions: Options;
    try {
        for (const binding of affected) {
            const log = await prisma.customerPricingChange.create({
                data: {
                    user_id: binding.user_id,
                    tier_key: binding.tier_key,
                    actor_id: meta.actorId ?? null,
                    status: 'applying',
                    before: json({
                        operation: 'public_price_rebase',
                        operation_id: operationId,
                        deltas,
                        owned_rows: oldOwned,
                        replicas: [...replicas.values()],
                    }),
                    after: json({ operation: 'public_price_rebase', operation_id: operationId, owned_rows: nextOwned }),
                    progress: json({ phase: 'prepared' }),
                },
                select: { id: true },
            });
            logs.push(log.id);
        }
        // This durable gate survives a caller transaction abort after remote prices changed.
        // Only the caller's commit may expose active bindings and applied markers together
        // with its CatalogPrice snapshots.
        await prisma.customerPricingBinding.updateMany({
            where: { id: { in: affected.map((b) => b.id) } },
            data: { status: 'applying' },
        });
        for (const replica of activeReplicas) {
            remoteAttempted = true;
            await setChannelStatusStrict(replica.id, 2);
        }
        const locked = await getPricingPublishOptions();
        if (!ownedMatches(locked, oldOwned)) throw new CustomerPricingError('pricing_rebase_stale', '客户倍率已变化。');
        const mergedWrites = deltaWrites(locked, deltas, 'after');
        remoteAttempted = true;
        await rawWriter(mergedWrites);
        await writeOwnedRows(nextOwned, [oldOwned]);
        const checked = await getPricingPublishOptions();
        if (!verifyDeltas(checked, deltas, 'after') || !ownedMatches(checked, nextOwned))
            throw new CustomerPricingError('pricing_rebase_unverified', '公共价格与客户专属价无法核对。', 502);
        for (const replica of activeReplicas) await setChannelStatusStrict(replica.id, 1);
        verifiedOptions = checked;
    } catch (error) {
        let restored = !remoteAttempted;
        if (remoteAttempted) {
            try {
                for (const replica of activeReplicas) await setChannelStatusStrict(replica.id, 2);
                const current = await getPricingPublishOptions();
                await rawWriter(deltaWrites(current, deltas, 'before'));
                await writeOwnedRows(oldOwned, [oldOwned, nextOwned]);
                const verified = await getPricingPublishOptions();
                if (!verifyDeltas(verified, deltas, 'before') || !ownedMatches(verified, oldOwned))
                    throw new Error('rollback mismatch');
                for (const replica of activeReplicas) await setChannelStatusStrict(replica.id, 1);
                restored = true;
            } catch {
                restored = false;
            }
        }
        await prisma.customerPricingBinding.updateMany({
            where: { id: { in: affected.map((b) => b.id) } },
            data: { status: restored ? 'active' : 'failed' },
        });
        await prisma.customerPricingChange.updateMany({
            where: { id: { in: logs } },
            data: {
                status: restored ? 'compensated' : 'failed',
                error: error instanceof Error ? error.message.slice(0, 1000) : 'Public price rebase failed',
                progress: json({ phase: restored ? 'original_prices_restored' : 'requires_recovery' }),
            },
        });
        throw new CustomerPricingError(
            'pricing_rebase_failed',
            restored
                ? '改价未完成，原价格已恢复，请重新预览。'
                : '改价无法确认，专属渠道可能处于暂停状态。请先核对并恢复这次发布。',
            502,
        );
    }
    // Keep local finalization outside the remote compensation catch. A local
    // transaction error can hold row locks until its caller rolls back; global
    // compensation writes here would wait on our own transaction. Its durable
    // applying marker instead leaves a safe, retryable recovery operation.
    await tx.customerPricingBinding.updateMany({
        where: { id: { in: affected.map((b) => b.id) } },
        data: { status: 'active' },
    });
    await tx.customerPricingChange.updateMany({
        where: { id: { in: logs } },
        data: { status: 'applied', progress: json({ phase: 'verified' }) },
    });
    return verifiedOptions;
}

/** Older direct writes cannot safely recompile customer prices. */
export async function assertLegacyPriceWriteAllowed(modelName: string): Promise<void> {
    const bindings = await prisma.customerPricingBinding.findMany({
        where: { status: 'active' },
        select: { tier_key: true },
    });
    if (!bindings.length) return;
    const registry = await prisma.customerModelBillingGroup.findFirst({
        where: {
            model_name: modelName,
            tier_key: { in: bindings.map((b) => b.tier_key) },
        },
        select: { id: true },
    });
    if (registry)
        throw new CustomerPricingError(
            'pricing_official_managed',
            '该模型已有客户专属定价，请在「现有定价 → 模型基础价」修改并重新预览。',
        );
}

/** Durable rebase recovery uses the exact recorded deltas, never today's model prices. */
export async function recoverCustomerPricingRebase(before: unknown, after: unknown): Promise<void> {
    if (
        !before ||
        typeof before !== 'object' ||
        Array.isArray(before) ||
        !after ||
        typeof after !== 'object' ||
        Array.isArray(after)
    )
        throw new CustomerPricingError('recovery_invalid', '改价恢复记录不完整。');
    const original = before as Record<string, unknown>,
        target = after as Record<string, unknown>;
    if (
        original.operation !== 'public_price_rebase' ||
        target.operation !== original.operation ||
        typeof original.operation_id !== 'string' ||
        target.operation_id !== original.operation_id ||
        !Array.isArray(original.deltas) ||
        !Array.isArray(original.replicas) ||
        !original.owned_rows ||
        !target.owned_rows
    )
        throw new CustomerPricingError('recovery_invalid', '改价恢复记录不完整。');
    const deltas = original.deltas as Delta[];
    const replicas = original.replicas as Replica[];
    for (const replica of replicas) {
        const channel = await getChannelStrict(replica.id);
        if (channel.group !== replica.group || channel.models !== replica.model || ![1, 2, 3].includes(replica.status))
            throw new CustomerPricingError('recovery_conflict', '专属渠道归属已变化，未覆盖外部修改。');
    }
    for (const replica of replicas) await setChannelStatusStrict(replica.id, 2);
    const current = await getPricingPublishOptions();
    const writes = deltaWrites(current, deltas, 'before');
    for (const write of writes) await putOption(write.key, JSON.stringify(write.value), 15_000);
    await writeOwnedRows(original.owned_rows as Owned, [original.owned_rows as Owned, target.owned_rows as Owned]);
    const checked = await getPricingPublishOptions();
    if (!verifyDeltas(checked, deltas, 'before') || !ownedMatches(checked, original.owned_rows as Owned))
        throw new CustomerPricingError('recovery_unverified', '恢复后的实际价格尚未通过核验。', 503);
    for (const replica of replicas) if (replica.status === 1) await setChannelStatusStrict(replica.id, 1);
}
