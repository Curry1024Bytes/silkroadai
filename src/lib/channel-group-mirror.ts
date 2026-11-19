import 'server-only';
import type { ChannelGroup, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { assertPricingCatalogWritable } from '@/lib/admin/pricing-publish-lock';
import {
    getCatalogSyncOptions,
    getChannelStrict,
    listChannelsForCatalogSync,
    setChannelStatusStrict,
} from '@/lib/newapi/client';
import { generateChannelGroupKey } from '@/lib/channel-group-key';

export interface MirrorSource {
    groups: { name: string; label: string; selectable: boolean; channels: number[] }[];
    staleInternalSources?: { id: string; internalGroup: string; replicaIds: number[] }[];
}
type MirrorRow = Pick<
    ChannelGroup,
    | 'id'
    | 'key'
    | 'newapi_group'
    | 'display_name'
    | 'enabled'
    | 'is_default'
    | 'newapi_channel_ids'
    | 'tier_level'
    | 'upstream_present'
    | 'upstream_synced_at'
>;
type MirrorValues = Pick<MirrorRow, 'display_name' | 'enabled' | 'newapi_channel_ids' | 'upstream_present'>;

/** A complete validated snapshot is required before treating absence as deletion. */
export async function readGroupMirrorSource(): Promise<MirrorSource> {
    const [options, channels, internal] = await Promise.all([
        getCatalogSyncOptions(),
        listChannelsForCatalogSync(),
        prisma.customerModelBillingGroup.findMany({
            select: {
                id: true,
                internal_group: true,
                replica_channel_ids: true,
                source_channel_ids: true,
                public_group: true,
                model_name: true,
                status: true,
            },
        }),
    ]);
    const internalGroups = new Set(internal.map((row) => row.internal_group));
    const internalChannels = new Set(internal.flatMap((row) => row.replica_channel_ids));
    const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
    const parts = (value: unknown): string[] =>
        typeof value === 'string'
            ? value
                  .split(',')
                  .map((v) => v.trim())
                  .filter(Boolean)
            : [];
    const staleInternalSources = internal
        .filter(
            (row) =>
                ['active', 'stale'].includes(row.status) &&
                (row.source_channel_ids.length === 0 ||
                    row.source_channel_ids.some((id) => {
                        const source = channelsById.get(id);
                        return (
                            !source ||
                            source.status !== 1 ||
                            !parts(source.group).includes(row.public_group) ||
                            !parts(source.models).includes(row.model_name)
                        );
                    })),
        )
        .map((row) => ({ id: row.id, internalGroup: row.internal_group, replicaIds: row.replica_channel_ids }));
    function dictionary(raw: unknown, ratios: boolean): Record<string, string | number> {
        const data: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Incomplete group options');
        for (const [name, value] of Object.entries(data)) {
            if (
                !name.trim() ||
                name !== name.trim() ||
                (ratios ? typeof value !== 'number' || !Number.isFinite(value) || value < 0 : typeof value !== 'string')
            )
                throw new Error('Invalid group options');
        }
        return data as Record<string, string | number>;
    }
    const labels = dictionary(options.UserUsableGroups, false);
    const ratios = dictionary(options.GroupRatio, true);
    const names = new Set([...Object.keys(ratios), ...Object.keys(labels)].filter((name) => !internalGroups.has(name)));
    const members = new Map<string, Set<number>>();
    for (const channel of channels) {
        if (!Number.isSafeInteger(channel.id) || channel.id <= 0 || typeof channel.group !== 'string')
            throw new Error('Incomplete channel membership');
        if (internalChannels.has(channel.id)) continue;
        for (const name of channel.group
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)) {
            if (internalGroups.has(name)) continue;
            names.add(name);
            const ids = members.get(name) ?? new Set<number>();
            ids.add(channel.id);
            members.set(name, ids);
        }
    }
    return {
        ...(staleInternalSources.length ? { staleInternalSources } : {}),
        groups: [...names].map((name) => ({
            name,
            label: typeof labels[name] === 'string' && labels[name].trim() ? (labels[name] as string) : name,
            selectable: Object.hasOwn(labels, name) && !(labels[name] as string).trim().startsWith('@'),
            channels: [...(members.get(name) ?? [])].sort((a, b) => a - b),
        })),
    };
}

/** External new-api edits are detected on synchronization, not intercepted at their source. */
async function pauseStaleInternalSources(source: MirrorSource): Promise<void> {
    const stale = source.staleInternalSources ?? [];
    if (!stale.length) return;
    const failures: unknown[] = [];
    for (const row of stale) {
        for (const id of row.replicaIds) {
            try {
                const channel = await getChannelStrict(id);
                if (channel.group !== row.internalGroup) throw new Error('Registered replica ownership changed');
                if (channel.status === 1) await setChannelStatusStrict(id, 2);
            } catch (error) {
                failures.push(error);
            }
        }
    }
    // This mark survives a later mirror transaction failure and prevents an
    // incomplete pause from being represented as a healthy source registry.
    await prisma.customerModelBillingGroup.updateMany({
        where: { id: { in: stale.map((row) => row.id) }, status: 'active' },
        data: { status: 'stale' },
    });
    if (failures.length) throw new Error('Source channel changed; private replica shutdown needs reconciliation');
}

/** Keys and financial history are stable; a removed group becomes an archived registry entry. */
export function planGroupMirror(rows: MirrorRow[], source: MirrorSource) {
    const updates: { row: MirrorRow; data: MirrorValues }[] = [];
    const creates: (MirrorValues & { key: string; newapi_group: string; tier_level: number })[] = [];
    const used = new Set(rows.map((row) => row.key));
    const covered = new Set<string>();
    const live = new Map(source.groups.map((group) => [group.name, group]));
    let level = Math.max(-1, ...rows.map((row) => row.tier_level)) + 1;
    // Prefer the existing default/active row if old manual configuration has duplicate names.
    const ordered = [...rows].sort(
        (a, b) =>
            Number(b.is_default) - Number(a.is_default) ||
            Number(b.enabled) - Number(a.enabled) ||
            a.id.localeCompare(b.id),
    );
    for (const row of ordered) {
        const group = covered.has(row.newapi_group) ? undefined : live.get(row.newapi_group);
        if (group) covered.add(group.name);
        const data: MirrorValues = group
            ? {
                  display_name: group.label,
                  enabled: group.selectable,
                  newapi_channel_ids: group.channels,
                  upstream_present: true,
              }
            : { display_name: row.display_name, enabled: false, newapi_channel_ids: [], upstream_present: false };
        if (
            !row.upstream_synced_at ||
            row.display_name !== data.display_name ||
            row.enabled !== data.enabled ||
            row.upstream_present !== data.upstream_present ||
            JSON.stringify(row.newapi_channel_ids) !== JSON.stringify(data.newapi_channel_ids)
        )
            updates.push({ row, data });
    }
    for (const group of source.groups) {
        if (covered.has(group.name)) continue;
        const key = generateChannelGroupKey(group.name, used);
        used.add(key);
        creates.push({
            key,
            newapi_group: group.name,
            display_name: group.label,
            enabled: group.selectable,
            newapi_channel_ids: group.channels,
            upstream_present: true,
            tier_level: level++,
        });
    }
    return { updates, creates };
}

/** Remove only mappings whose tier/channel membership was removed upstream. No price writes. */
export function reconcileMirroredMap(
    raw: unknown,
    groups: { key: string; enabled: boolean; newapi_channel_ids: number[] }[],
) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid model mappings');
    const byTier = new Map(groups.map((group) => [group.key, group]));
    return Object.fromEntries(
        Object.entries(raw).filter(([tier, entry]) => {
            const group = byTier.get(tier);
            return (
                group?.enabled &&
                entry &&
                typeof entry === 'object' &&
                'channel_id' in entry &&
                typeof entry.channel_id === 'number' &&
                group.newapi_channel_ids.includes(entry.channel_id)
            );
        }),
    );
}

async function runMirror() {
    const source = await readGroupMirrorSource();
    const before = await prisma.channelGroup.findMany({ where: { tenant_id: PLATFORM_TENANT_ID } });
    const initial = planGroupMirror(before, source);
    if (!initial.updates.length && !initial.creates.length && !source.staleInternalSources?.length) return;
    await prisma.$transaction(
        async (tx) => {
            await assertPricingCatalogWritable(tx);
            // A customer-pricing publication may have created channel replicas
            // while this mirror waited for the shared lock. Do not persist its
            // pre-lock, partially prepared membership snapshot.
            const confirmedSource = await readGroupMirrorSource();
            await pauseStaleInternalSources(confirmedSource);
            const rows = await tx.channelGroup.findMany({ where: { tenant_id: PLATFORM_TENANT_ID } });
            const plan = planGroupMirror(rows, confirmedSource);
            const now = new Date();
            // Disable obsolete rows first, so replacing duplicate historical registries cannot violate uniqueness.
            for (const { row, data } of [...plan.updates].sort(
                (a, b) => Number(a.data.enabled) - Number(b.data.enabled),
            ))
                await tx.channelGroup.update({ where: { id: row.id }, data: { ...data, upstream_synced_at: now } });
            for (const data of plan.creates)
                await tx.channelGroup.create({
                    data: { ...data, tenant_id: PLATFORM_TENANT_ID, is_default: false, upstream_synced_at: now },
                });
            if (!plan.updates.length && !plan.creates.length) return;
            const next = rows.map((row) => ({
                ...row,
                ...(plan.updates.find((update) => update.row.id === row.id)?.data ?? {}),
            }));
            const groups = [...next, ...plan.creates];
            const models = await tx.catalogModel.findMany({
                where: { tenant_id: PLATFORM_TENANT_ID, enabled: true },
                select: { id: true, upstream_map: true },
            });
            for (const model of models) {
                const map = reconcileMirroredMap(model.upstream_map, groups);
                if (JSON.stringify(map) !== JSON.stringify(model.upstream_map))
                    await tx.catalogModel.update({
                        where: { id: model.id },
                        data: {
                            upstream_map: map as Prisma.InputJsonValue,
                            ...(Object.keys(map).length ? {} : { enabled: false }),
                        },
                    });
            }
        },
        { isolationLevel: 'Serializable', timeout: 15000 },
    );
}

let inflight: Promise<void> | null = null;
let lastAttempt = 0;
let lastSucceeded = false;
export function __resetGroupMirrorForTests() {
    inflight = null;
    lastAttempt = 0;
    lastSucceeded = false;
}

/** Admin refresh waits for a fresh snapshot; customer reads share a one-minute cache. */
export async function mirrorChannelGroups(force = false): Promise<void> {
    if (inflight) return inflight;
    if (!force && Date.now() - lastAttempt < 60_000) {
        if (!lastSucceeded) throw new Error('Group mirror unavailable');
        return;
    }
    lastAttempt = Date.now();
    lastSucceeded = false;
    inflight = runMirror()
        .then(() => {
            lastSucceeded = true;
        })
        .finally(() => {
            inflight = null;
        });
    return inflight;
}
