import 'server-only';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ChannelGroupTopology, ChannelGroupTopologyError, type UpstreamMapLike } from '@/lib/channel-group-topology';
import type { NewApiChannel } from '@/lib/newapi/client';
import type { ChannelReplacementPreview, ReplacementChannel, ReplacementGroup } from './channel-replacement-types';

export class ChannelReplacementError extends Error {
    constructor(
        public code: string,
        message: string,
        public status = 409,
    ) {
        super(message);
    }
}

const groupSelect = {
    id: true,
    tenant_id: true,
    key: true,
    display_name: true,
    newapi_group: true,
    newapi_channel_ids: true,
    enabled: true,
    is_default: true,
    tier_level: true,
    updated_at: true,
} satisfies Prisma.ChannelGroupSelect;

/** Whitelist metadata: full new-api channel objects may contain credentials. */
export function replacementChannel(channel: NewApiChannel, owner: string | null = null): ReplacementChannel {
    const split = (value: unknown) =>
        typeof value === 'string'
            ? [
                  ...new Set(
                      value
                          .split(',')
                          .map((item) => item.trim())
                          .filter(Boolean),
                  ),
              ].sort()
            : [];
    return {
        id: channel.id,
        name: typeof channel.name === 'string' ? channel.name : `#${channel.id}`,
        status: typeof channel.status === 'number' ? channel.status : null,
        groups: split(channel.group),
        models: split(channel.models),
        owner,
    };
}

function publicGroup(group: ReplacementGroup): ReplacementGroup {
    const { id, key, display_name, newapi_group, newapi_channel_ids, enabled } = group;
    return { id, key, display_name, newapi_group, newapi_channel_ids, enabled };
}

function upstreamMap(value: unknown): UpstreamMapLike {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as UpstreamMapLike) : {};
}

// Stable JSON ordering makes a preview insensitive to JSONB key ordering.
function canonical(value: unknown): string {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

export async function buildChannelReplacement(
    db: Pick<Prisma.TransactionClient, 'channelGroup' | 'catalogModel'>,
    groupId: string,
    tenantId: string | null,
    sourceId: number,
    target: ReplacementChannel,
) {
    // Read every tier, including disabled ones, from the selected group's tenant.
    const groups = await db.channelGroup.findMany({
        where: { tenant_id: tenantId },
        select: groupSelect,
        orderBy: { id: 'asc' },
    });
    const group = groups.find((item) => item.id === groupId);
    if (!group) throw new ChannelReplacementError('group_not_found', '渠道分组不存在，请刷新列表。', 404);
    const issues: ChannelReplacementPreview['issues'] = [];
    const issue = (code: string, message: string) => issues.push({ code, message });
    if (!group.enabled) issue('tier_disabled', '请先启用该档次，再替换渠道。');
    if (!group.newapi_channel_ids.includes(sourceId))
        issue('source_not_registered', '原渠道已不在本档次，请刷新后重新选择。');
    if (sourceId === target.id) issue('same_channel', '请选择与原渠道不同的新渠道。');
    if (target.status !== 1) issue('target_disabled', '新渠道未启用，请先在 new-api 确认渠道状态。');
    if (!target.groups.includes(group.newapi_group)) {
        issue('group_mismatch', `新渠道不属于 new-api 分组「${group.newapi_group}」，请先在 new-api 核对分组。`);
    }
    const owner = groups.find(
        (item) => item.id !== group.id && item.enabled && item.newapi_channel_ids.includes(target.id),
    );
    if (owner) issue('channel_already_assigned', `新渠道已登记在「${owner.display_name}」，不能同时归属两个启用档次。`);
    const nextIds = [...new Set(group.newapi_channel_ids.map((id) => (id === sourceId ? target.id : id)))];
    const catalog = await db.catalogModel.findMany({
        where: { tenant_id: tenantId },
        select: { id: true, slug: true, display_name: true, enabled: true, upstream_map: true, updated_at: true },
        orderBy: { id: 'asc' },
    });
    // Include disabled models as well, so re-enabling a model cannot resurrect the old channel.
    const affected = catalog.filter((model) => upstreamMap(model.upstream_map)[group.key]?.channel_id === sourceId);
    const models = affected.map((model) => {
        const upstreamModel = upstreamMap(model.upstream_map)[group.key].upstream_model;
        return {
            id: model.id,
            slug: model.slug,
            display_name: model.display_name,
            enabled: model.enabled,
            upstream_model: upstreamModel,
            supported: target.models.includes(upstreamModel),
        };
    });
    const missing = models.filter((model) => !model.supported);
    if (missing.length)
        issue('missing_models', `新渠道缺少 ${missing.length} 个模型，请选择覆盖完整的渠道；缺失项已在下方标出。`);
    const updates = affected.map((model) => {
        const map = upstreamMap(model.upstream_map);
        return { ...model, nextMap: { ...map, [group.key]: { ...map[group.key], channel_id: target.id } } };
    });
    try {
        const topology = new ChannelGroupTopology(
            tenantId ?? '',
            groups
                .filter((item) => item.enabled)
                .map((item) => (item.id === group.id ? { ...item, newapi_channel_ids: nextIds } : item)),
        );
        for (const model of updates) {
            if (topology.validateUpstreamMap(model.nextMap, { allowEmpty: !model.enabled }).length) {
                issue('invalid_model_mapping', `模型「${model.slug}」还有其他无效档次映射，请先在模型管理中修正。`);
            }
        }
    } catch (error) {
        if (!(error instanceof ChannelGroupTopologyError)) throw error;
        issue('invalid_topology', '档次配置存在重复归属或默认档异常，请先检查渠道分组。');
    }
    const preview: ChannelReplacementPreview = {
        group: publicGroup(group),
        source_channel_id: sourceId,
        target: { ...target, owner: owner?.key ?? group.key },
        next_channel_ids: nextIds,
        models,
        issues,
        canApply: issues.length === 0,
        preview_token: createHash('sha256').update(canonical({ groups, catalog, sourceId, target })).digest('hex'),
    };
    return { preview, updates, group };
}

export async function applyChannelReplacement(args: {
    groupId: string;
    tenantId: string | null;
    sourceId: number;
    target: ReplacementChannel;
    previewToken: string;
}) {
    // No network calls or price/key writes inside this transaction. A failed model or
    // registry write rolls the whole replacement back; serialization conflicts require a new preview.
    return prisma.$transaction(
        async (tx) => {
            const plan = await buildChannelReplacement(tx, args.groupId, args.tenantId, args.sourceId, args.target);
            if (plan.preview.preview_token !== args.previewToken) {
                throw new ChannelReplacementError('preview_stale', '配置已发生变化，请重新预览后再确认替换。');
            }
            if (!plan.preview.canApply)
                throw new ChannelReplacementError('replacement_blocked', plan.preview.issues[0].message);
            for (const model of plan.updates) {
                await tx.catalogModel.update({
                    where: { id: model.id, tenant_id: args.tenantId, updated_at: model.updated_at },
                    data: { upstream_map: model.nextMap as Prisma.InputJsonValue },
                });
            }
            await tx.channelGroup.update({
                where: { id: plan.group.id, tenant_id: args.tenantId, updated_at: plan.group.updated_at },
                data: { newapi_channel_ids: plan.preview.next_channel_ids },
            });
            return plan.preview;
        },
        { isolationLevel: 'Serializable', timeout: 15000 },
    );
}
