import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/db';
import { getChannelStrict, NewApiError, updateChannelStrict, type NewApiChannel } from '@/lib/newapi/client';

/** The subset of a Portal catalog model needed for channel publishing. */
export interface ModelPublishModel {
    id?: string;
    slug: string;
    enabled: boolean;
    upstream_map: unknown;
}

/** The active Portal tier/channel topology. */
export interface ModelPublishGroup {
    key: string;
    enabled: boolean;
    newapi_channel_ids: number[];
    newapi_group: string;
    is_default: boolean;
    upstream_synced_at?: Date | string | null;
}

/** A full new-api channel object. Unknown fields are retained on output. */
export interface ModelPublishChannel {
    id: number;
    name?: string | null;
    models?: unknown;
    model_mapping?: unknown;
    [key: string]: unknown;
}

export type ModelPublishIssue =
    | { code: 'no_active_groups' }
    | { code: 'missing_channel'; channel_id: number; model: string; tier: string }
    | { code: 'unknown_tier'; tier: string; model: string }
    | { code: 'channel_not_owned_by_tier'; channel_id: number; tier: string; model: string }
    | { code: 'missing_upstream_map'; model: string }
    | { code: 'invalid_upstream_map'; model: string; tier?: string }
    | { code: 'tier_has_no_channels'; tier: string }
    | { code: 'invalid_default_count'; count: number }
    | { code: 'duplicate_newapi_group'; newapi_group: string; tiers: string[] }
    | { code: 'duplicate_channel_owner'; channel_id: number; tiers: string[] }
    | { code: 'invalid_newapi_group'; tier: string }
    | { code: 'invalid_channel_models'; channel_id: number }
    | { code: 'invalid_channel_mapping'; channel_id: number }
    | { code: 'mapping_conflict'; channel_id: number; model: string; current: string; expected: string };

export interface ModelPublishChannelChange {
    id: number;
    name: string | null;
    changed: boolean;
    added_models: string[];
    removed_models: string[];
    added_mappings: Record<string, string>;
    removed_mappings: Record<string, string>;
    changed_mappings: Record<string, { from: string; to: string }>;
    /** Complete object to pass to updateChannel after a fresh GET. */
    next: ModelPublishChannel;
}

export interface ModelPublishPlan {
    blocked: boolean;
    issues: ModelPublishIssue[];
    channels: ModelPublishChannelChange[];
    changed_channels: number;
    unchanged_channels: number;
}

export class ModelPublishError extends Error {
    constructor(
        public code: string,
        message: string,
        public status = 409,
    ) {
        super(message);
        this.name = 'ModelPublishError';
    }
}

export interface ModelPublishInput {
    models: ModelPublishModel[];
    groups: ModelPublishGroup[];
    channels: ModelPublishChannel[];
}

function parseList(value: unknown): string[] {
    if (Array.isArray(value))
        return value
            .filter((item): item is string => typeof item === 'string')
            .map((s) => s.trim())
            .filter(Boolean);
    if (typeof value !== 'string') return [];
    return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function parseMapping(value: unknown): Record<string, string> {
    let parsed: unknown = value;
    if (typeof value === 'string') {
        if (!value.trim()) return {};
        try {
            parsed = JSON.parse(value);
        } catch {
            return {};
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(parsed)) if (typeof item === 'string' && key.trim()) out[key] = item;
    return out;
}

function isStringMapping(value: unknown): value is Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.entries(value).every(
        ([key, item]) => key.trim().length > 0 && typeof item === 'string' && item.trim().length > 0,
    );
}

function validMapping(value: unknown): boolean {
    if (value === null || value === '') return true;
    if (typeof value !== 'string') return isStringMapping(value);
    if (!value.trim()) return false;
    try {
        const parsed = JSON.parse(value);
        return isStringMapping(parsed);
    } catch {
        return false;
    }
}

function validModels(value: unknown): boolean {
    if (typeof value === 'string') return value === '' || value.split(',').every((item) => item.trim().length > 0);
    return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function hasEffectiveChannels(group: ModelPublishGroup): boolean {
    return (
        Array.isArray(group.newapi_channel_ids) &&
        group.newapi_channel_ids.length > 0 &&
        group.newapi_channel_ids.every((id) => Number.isSafeInteger(id) && id > 0)
    );
}

function modelsValue(value: unknown, models: string[]): unknown {
    if (Array.isArray(value)) return models;
    return typeof value === 'string' || value === null || value === undefined ? models.join(',') : models;
}

function mappingValue(value: unknown, mapping: Record<string, string>): unknown {
    return typeof value === 'string' || value === null || value === undefined ? JSON.stringify(mapping) : mapping;
}

function sortedUnique(values: Iterable<string>): string[] {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * Build a deterministic, write-free Portal → new-api publication plan.
 *
 * The plan only manages model aliases present in the Portal catalog. Existing
 * channel fields and unrelated model aliases are copied through unchanged.
 */
export function buildModelPublishPlan(input: ModelPublishInput): ModelPublishPlan {
    const channelsById = new Map(input.channels.map((channel) => [channel.id, channel]));
    const groupsByKey = new Map(input.groups.filter((group) => group.enabled).map((group) => [group.key, group]));
    const issues: ModelPublishIssue[] = [];
    const targets = new Map<number, Map<string, string>>();

    // A complete Portal topology is required before publishing any channel.
    if (groupsByKey.size === 0) issues.push({ code: 'no_active_groups' });
    const defaults = [...groupsByKey.values()].filter((group) => group.is_default);
    if (defaults.length !== 1) issues.push({ code: 'invalid_default_count', count: defaults.length });
    const groupsByNewApiName = new Map<string, string[]>();
    for (const group of groupsByKey.values()) {
        if (!group.newapi_group.trim()) {
            issues.push({ code: 'invalid_newapi_group', tier: group.key });
            continue;
        }
        groupsByNewApiName.set(group.newapi_group, [...(groupsByNewApiName.get(group.newapi_group) ?? []), group.key]);
    }
    for (const [newapiGroup, tiers] of groupsByNewApiName) {
        const uniqueTiers = [...new Set(tiers)];
        if (uniqueTiers.length > 1)
            issues.push({ code: 'duplicate_newapi_group', newapi_group: newapiGroup, tiers: uniqueTiers });
    }
    const channelsByTier = new Map<number, string[]>();
    for (const group of groupsByKey.values()) {
        if (!Array.isArray(group.newapi_channel_ids)) continue;
        for (const channelId of new Set(group.newapi_channel_ids)) {
            if (!Number.isSafeInteger(channelId) || channelId <= 0) continue;
            channelsByTier.set(channelId, [...(channelsByTier.get(channelId) ?? []), group.key]);
        }
    }
    for (const [channelId, tiers] of channelsByTier) {
        const uniqueTiers = [...new Set(tiers)];
        if (uniqueTiers.length > 1) {
            const verifiedMirror = uniqueTiers.every((tier) => Boolean(groupsByKey.get(tier)?.upstream_synced_at));
            if (!verifiedMirror)
                issues.push({ code: 'duplicate_channel_owner', channel_id: channelId, tiers: uniqueTiers });
        }
    }
    for (const group of groupsByKey.values()) {
        if (!hasEffectiveChannels(group)) {
            issues.push({ code: 'tier_has_no_channels', tier: group.key });
        }
    }

    for (const model of input.models) {
        if (!model.enabled) continue;
        if (!model.upstream_map || typeof model.upstream_map !== 'object' || Array.isArray(model.upstream_map)) {
            issues.push({ code: 'invalid_upstream_map', model: model.slug });
            continue;
        }
        const entries = Object.entries(model.upstream_map);
        if (entries.length === 0) {
            issues.push({ code: 'missing_upstream_map', model: model.slug });
            continue;
        }
        for (const [tier, rawEntry] of entries) {
            if (
                !rawEntry ||
                typeof rawEntry !== 'object' ||
                Array.isArray(rawEntry) ||
                !Number.isSafeInteger((rawEntry as Record<string, unknown>).channel_id) ||
                ((rawEntry as Record<string, unknown>).channel_id as number) <= 0 ||
                typeof (rawEntry as Record<string, unknown>).upstream_model !== 'string' ||
                !(rawEntry as Record<string, unknown>).upstream_model ||
                !((rawEntry as Record<string, unknown>).upstream_model as string).trim()
            ) {
                issues.push({ code: 'invalid_upstream_map', model: model.slug, tier });
                continue;
            }
            const entry = rawEntry as { channel_id: number; upstream_model: string };
            const group = groupsByKey.get(tier);
            if (!group) {
                issues.push({ code: 'unknown_tier', tier, model: model.slug });
                continue;
            }
            if (!hasEffectiveChannels(group)) continue;
            if (!channelsById.has(entry.channel_id)) {
                issues.push({ code: 'missing_channel', channel_id: entry.channel_id, model: model.slug, tier });
                continue;
            }
            if (!group.newapi_channel_ids.includes(entry.channel_id)) {
                issues.push({
                    code: 'channel_not_owned_by_tier',
                    channel_id: entry.channel_id,
                    tier,
                    model: model.slug,
                });
                continue;
            }
            // The selected channel proves the model belongs to this tier, but
            // the tier is the routing unit: mirror the same alias/upstream
            // mapping to every registered member so new-api can apply its own
            // channel weights and failover.
            for (const channelId of group.newapi_channel_ids) {
                if (!channelsById.has(channelId)) {
                    issues.push({ code: 'missing_channel', channel_id: channelId, model: model.slug, tier });
                    continue;
                }
                const channelTargets = targets.get(channelId) ?? new Map<string, string>();
                const previous = channelTargets.get(model.slug);
                if (previous && previous !== entry.upstream_model) {
                    issues.push({
                        code: 'mapping_conflict',
                        channel_id: channelId,
                        model: model.slug,
                        current: previous,
                        expected: entry.upstream_model,
                    });
                } else {
                    channelTargets.set(model.slug, entry.upstream_model);
                    targets.set(channelId, channelTargets);
                }
            }
        }
    }

    const channels = input.channels.map((channel): ModelPublishChannelChange => {
        const invalidModels = !Object.hasOwn(channel, 'models') || !validModels(channel.models);
        const invalidMapping = !Object.hasOwn(channel, 'model_mapping') || !validMapping(channel.model_mapping);
        if (invalidModels) issues.push({ code: 'invalid_channel_models', channel_id: channel.id });
        if (invalidMapping) issues.push({ code: 'invalid_channel_mapping', channel_id: channel.id });
        if (invalidModels || invalidMapping) {
            return {
                id: channel.id,
                name: typeof channel.name === 'string' ? channel.name : null,
                changed: false,
                added_models: [],
                removed_models: [],
                added_mappings: {},
                removed_mappings: {},
                changed_mappings: {},
                next: channel,
            };
        }
        const beforeModels = parseList(channel.models);
        const beforeMapping = parseMapping(channel.model_mapping);
        const desired = targets.get(channel.id) ?? new Map<string, string>();
        const nextModels = [...beforeModels];

        const addedModels: string[] = [];
        const removedModels: string[] = [];
        const addedMappings: Record<string, string> = {};
        const removedMappings: Record<string, string> = {};
        const changedMappings: Record<string, { from: string; to: string }> = {};
        for (const [slug, upstream] of desired) {
            if (!nextModels.includes(slug)) {
                nextModels.push(slug);
                addedModels.push(slug);
            }
            const current = beforeMapping[slug];
            if (current === undefined) {
                addedMappings[slug] = upstream;
                beforeMapping[slug] = upstream;
            } else if (current !== upstream) {
                changedMappings[slug] = { from: current, to: upstream };
                beforeMapping[slug] = upstream;
            }
        }

        const next: ModelPublishChannel = {
            ...channel,
            models: modelsValue(channel.models, nextModels),
            model_mapping: mappingValue(channel.model_mapping, beforeMapping),
        };
        const changed =
            JSON.stringify(channel.models ?? null) !== JSON.stringify(next.models ?? null) ||
            JSON.stringify(channel.model_mapping ?? null) !== JSON.stringify(next.model_mapping ?? null);
        return {
            id: channel.id,
            name: typeof channel.name === 'string' ? channel.name : null,
            changed,
            added_models: sortedUnique(addedModels),
            removed_models: sortedUnique(removedModels),
            added_mappings: addedMappings,
            removed_mappings: removedMappings,
            changed_mappings: changedMappings,
            next,
        };
    });

    return {
        blocked: issues.length > 0,
        issues,
        channels,
        changed_channels: channels.filter((channel) => channel.changed).length,
        unchanged_channels: channels.filter((channel) => !channel.changed).length,
    };
}

/** Remove secrets and return a preview-safe channel diff. */
export function redactModelPublishPlan(plan: ModelPublishPlan): Omit<ModelPublishPlan, 'channels'> & {
    channels: Array<Omit<ModelPublishChannelChange, 'next'>>;
} {
    return {
        ...plan,
        channels: plan.channels.map((channel) => {
            const { next, ...change } = channel;
            // Keep this explicit so the redacted preview can never serialize
            // the complete channel object (which may contain credentials).
            void next;
            return change;
        }),
    };
}

type PublishInputWithSnapshot = ModelPublishInput;

function signingSecret(): string {
    const secret = process.env.PORTAL_JWT_SECRET;
    if (!secret) throw new ModelPublishError('publish_unavailable', '模型发布签名配置不可用，请检查服务配置。', 503);
    return secret;
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
            .join(',')}}`;
    return JSON.stringify(value) ?? 'null';
}

function issueToken(
    tenantId: string,
    input: PublishInputWithSnapshot,
    plan: ModelPublishPlan,
    timestamp: number,
): string {
    const payload = canonical({ purpose: 'portal-model-publish-v1', tenantId, timestamp, input, plan });
    return `${timestamp}.${createHmac('sha256', signingSecret()).update(payload).digest('hex')}`;
}

function verifyToken(token: string, tenantId: string, input: PublishInputWithSnapshot, plan: ModelPublishPlan): void {
    const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(token);
    const timestamp = Number(match?.[1]);
    if (
        !match ||
        !Number.isSafeInteger(timestamp) ||
        Date.now() - timestamp > 10 * 60_000 ||
        timestamp > Date.now() + 30_000
    )
        throw new ModelPublishError('preview_stale', '预览已过期，请重新读取模型和渠道后再确认发布。');
    const expected = createHmac('sha256', signingSecret())
        .update(canonical({ purpose: 'portal-model-publish-v1', tenantId, timestamp, input, plan }))
        .digest('hex');
    const actual = Buffer.from(match[2], 'hex');
    const expectedBytes = Buffer.from(expected, 'hex');
    if (actual.length !== expectedBytes.length || !timingSafeEqual(actual, expectedBytes))
        throw new ModelPublishError('preview_stale', '模型或 new-api 渠道已变化，请重新预览后再确认发布。');
}

async function readPublishInput(tenantId: string): Promise<ModelPublishInput> {
    const [groups, models] = await Promise.all([
        prisma.channelGroup.findMany({
            where: { tenant_id: tenantId, enabled: true },
            orderBy: [{ tier_level: 'asc' }, { key: 'asc' }],
            select: {
                key: true,
                enabled: true,
                newapi_channel_ids: true,
                newapi_group: true,
                is_default: true,
                upstream_synced_at: true,
            },
        }),
        prisma.catalogModel.findMany({
            where: { tenant_id: tenantId },
            orderBy: [{ sort_order: 'asc' }, { slug: 'asc' }],
            select: { id: true, slug: true, enabled: true, upstream_map: true },
        }),
    ]);
    const modelChannelIds = models
        .filter((model) => model.enabled)
        .flatMap((model) =>
            model.upstream_map && typeof model.upstream_map === 'object' && !Array.isArray(model.upstream_map)
                ? Object.values(model.upstream_map).flatMap((entry) => {
                      const channelId =
                          entry && typeof entry === 'object' && !Array.isArray(entry)
                              ? (entry as Record<string, unknown>).channel_id
                              : null;
                      return Number.isSafeInteger(channelId) ? [channelId as number] : [];
                  })
                : [],
        );
    const channelIds = [
        ...new Set(
            [...groups.flatMap((group) => group.newapi_channel_ids), ...modelChannelIds].filter(
                (id) => Number.isSafeInteger(id) && id > 0,
            ),
        ),
    ].sort((a, b) => a - b);
    const channels = await Promise.all(
        channelIds.map(async (id) => {
            try {
                return await getChannelStrict(id);
            } catch (error) {
                const status = error instanceof NewApiError ? `（HTTP ${error.status}）` : '';
                throw new ModelPublishError(
                    'channel_read_failed',
                    `读取渠道 #${id} 失败${status}，无法生成安全预览；本次尚未提交渠道修改。`,
                    502,
                );
            }
        }),
    );
    return {
        groups,
        models: models.map((model) => ({
            id: model.id,
            slug: model.slug,
            enabled: model.enabled,
            upstream_map: model.upstream_map,
        })),
        channels: channels as ModelPublishChannel[],
    };
}

function publicPreview(plan: ModelPublishPlan, token: string) {
    const channels = plan.channels
        .filter((channel) => channel.changed)
        .map((channel) => ({
            id: channel.id,
            name: channel.name,
            changes: [
                ...channel.added_models.map((slug) => ({ slug, action: 'add' as const })),
                ...channel.removed_models.map((slug) => ({ slug, action: 'remove' as const })),
                ...Object.entries(channel.changed_mappings).map(([slug, change]) => ({
                    slug,
                    action: 'update' as const,
                    from: change.from,
                    to: change.to,
                })),
                ...Object.entries(channel.added_mappings).map(([slug, to]) => ({ slug, action: 'map' as const, to })),
                ...Object.entries(channel.removed_mappings).map(([slug, from]) => ({
                    slug,
                    action: 'unmap' as const,
                    from,
                })),
            ],
        }));
    return {
        preview_token: token,
        channels,
        blocked: plan.blocked ? plan.issues : null,
    };
}

/** Read Portal models and live new-api channels and return a signed, redacted preview. */
export async function previewModelPublish(tenantId: string) {
    const input = await readPublishInput(tenantId);
    const plan = buildModelPublishPlan(input);
    const timestamp = Date.now();
    return publicPreview(plan, issueToken(tenantId, input, plan, timestamp));
}

async function auditPublishedChannel(
    tenantId: string,
    userId: string | null,
    change: ModelPublishChannelChange,
): Promise<void> {
    try {
        await prisma.adminAuditLog.create({
            data: {
                admin_user_id: userId,
                admin_email: null,
                level: userId ? 'super' : 'break_glass',
                action: 'model_catalog_publish',
                method: 'POST',
                path: '/api/admin/model-publish',
                target: `channel:${change.id}`,
                params: JSON.stringify({
                    tenant_id: tenantId,
                    channel_id: change.id,
                    added_models: change.added_models.length,
                    removed_models: change.removed_models.length,
                    added_mappings: Object.keys(change.added_mappings).length,
                    removed_mappings: Object.keys(change.removed_mappings).length,
                    changed_mappings: Object.keys(change.changed_mappings).length,
                }),
                client_ip: null,
                user_agent: null,
            },
        });
    } catch {
        // A successful new-api write must remain successful if the best-effort
        // audit sink is temporarily unavailable. The channel id is the only
        // value logged, never the channel object or its credentials.
        console.warn('[model-publish-audit] write failed', { channel_id: change.id });
    }
}

function publishedStateMatches(confirmed: ModelPublishChannel, expected: ModelPublishChannel): boolean {
    return (
        canonical(parseList(confirmed.models)) === canonical(parseList(expected.models)) &&
        canonical(parseMapping(confirmed.model_mapping)) === canonical(parseMapping(expected.model_mapping))
    );
}

function partialPublishSuffix(appliedChannels: number): string {
    return appliedChannels > 0
        ? `此前已有 ${appliedChannels} 个渠道写入并回读确认，请重新预览核对后再继续。`
        : '本次尚未确认任何渠道写入，请检查状态后重新预览。';
}

/** Re-read and verify the signed preview, then update complete channel objects and verify them again. */
export async function applyModelPublish(tenantId: string, userId: string | null, token: string) {
    const input = await readPublishInput(tenantId);
    const plan = buildModelPublishPlan(input);
    verifyToken(token, tenantId, input, plan);
    if (plan.blocked)
        throw new ModelPublishError('publish_blocked', '模型映射存在冲突或拓扑不完整，请先修正后重新预览。');
    const changed = plan.channels.filter((channel) => channel.changed);
    if (changed.length === 0)
        throw new ModelPublishError('nothing_to_publish', '模型目录已与 new-api 一致，无需发布。');

    // Refresh every target before the first PUT. If any channel changed since
    // preview, abort the whole batch before producing a partial publication.
    const preflightChannels = await Promise.all(
        changed.map(async (change) => {
            let latest: ModelPublishChannel;
            try {
                latest = (await getChannelStrict(change.id)) as ModelPublishChannel;
            } catch (error) {
                const status = error instanceof NewApiError ? `（HTTP ${error.status}）` : '';
                throw new ModelPublishError(
                    'channel_read_failed',
                    `发布前读取渠道 #${change.id} 失败${status}；本次尚未提交任何渠道修改。`,
                    502,
                );
            }
            const plannedCurrent = input.channels.find((channel) => channel.id === change.id);
            if (!plannedCurrent || canonical(latest) !== canonical(plannedCurrent))
                throw new ModelPublishError(
                    'preview_stale',
                    `渠道 #${change.id} 在发布前发生变化；本次尚未提交任何渠道修改。`,
                );
            return latest;
        }),
    );
    const preflightById = new Map(preflightChannels.map((channel) => [channel.id, channel]));

    let appliedChannels = 0;
    for (const change of changed) {
        const latest = preflightById.get(change.id);
        if (!latest)
            throw new ModelPublishError('preview_stale', `渠道 #${change.id} 无法确认；本次尚未提交任何渠道修改。`);

        try {
            await updateChannelStrict(change.next as NewApiChannel);
        } catch {
            // A failed HTTP response may still follow a committed PUT. Read the
            // channel before reporting the result so operators know whether it
            // reached the requested state.
            let afterFailedWrite: ModelPublishChannel | null = null;
            try {
                afterFailedWrite = (await getChannelStrict(change.id)) as ModelPublishChannel;
            } catch {
                // Keep the state explicitly unknown; never echo upstream errors.
            }
            if (!afterFailedWrite || !publishedStateMatches(afterFailedWrite, change.next)) {
                const statusDetail = afterFailedWrite ? '回读与预期不一致' : '无法读取当前状态';
                throw new ModelPublishError(
                    'publish_unverified',
                    `渠道 #${change.id} 的写入结果未确认（${statusDetail}）；${partialPublishSuffix(appliedChannels)}`,
                    502,
                );
            }
        }

        let confirmed: ModelPublishChannel;
        try {
            confirmed = (await getChannelStrict(change.id)) as ModelPublishChannel;
        } catch (error) {
            const status = error instanceof NewApiError ? `（HTTP ${error.status}）` : '';
            throw new ModelPublishError(
                'publish_unverified',
                `渠道 #${change.id} 已提交写入，但回读失败${status}；${partialPublishSuffix(appliedChannels)}`,
                502,
            );
        }
        if (!publishedStateMatches(confirmed, change.next))
            throw new ModelPublishError(
                'publish_unverified',
                `渠道 #${change.id} 写入后回读与预期不一致；${partialPublishSuffix(appliedChannels)}`,
                502,
            );
        appliedChannels++;
        await auditPublishedChannel(tenantId, userId, change);
    }
    return {
        preview: publicPreview(plan, token),
        applied: {
            channels: appliedChannels,
            models: changed.reduce((sum, channel) => sum + channel.added_models.length, 0),
        },
    };
}
