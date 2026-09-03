import 'server-only';
import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

export interface TopologyGroup {
    key: string;
    newapi_group: string;
    newapi_channel_ids: number[];
    is_default: boolean;
    enabled: boolean;
    tier_level: number;
}

export interface UpstreamMapEntryLike {
    channel_id: number;
    upstream_model: string;
}

export type UpstreamMapLike = Record<string, UpstreamMapEntryLike>;

export type ChannelGroupTopologyIssue =
    | { code: 'no_enabled_groups' }
    | { code: 'empty_upstream_map' }
    | { code: 'invalid_default_count'; count: number }
    | { code: 'tier_has_no_channels'; tier: string }
    | { code: 'duplicate_newapi_group'; newapi_group: string; tiers: string[] }
    | { code: 'duplicate_channel_owner'; channel_id: number; tiers: string[] }
    | { code: 'unregistered_channel'; channel_id: number }
    | { code: 'unknown_tier'; tier: string }
    | { code: 'channel_not_owned_by_tier'; tier: string; channel_id: number; owner: string | null };

export class ChannelGroupTopologyError extends Error {
    constructor(
        public tenantId: string,
        public issues: ChannelGroupTopologyIssue[],
    ) {
        super(`invalid channel-group topology for tenant ${tenantId}: ${issues.map(formatTopologyIssue).join('; ')}`);
        this.name = 'ChannelGroupTopologyError';
    }
}

function formatTopologyIssue(issue: ChannelGroupTopologyIssue): string {
    switch (issue.code) {
        case 'no_enabled_groups':
            return 'no enabled channel group';
        case 'empty_upstream_map':
            return 'enabled model has no upstream mapping';
        case 'invalid_default_count':
            return `expected exactly one enabled default group, found ${issue.count}`;
        case 'tier_has_no_channels':
            return `tier ${issue.tier} has no registered channels`;
        case 'duplicate_newapi_group':
            return `new-api group ${issue.newapi_group} is exposed by multiple tiers (${issue.tiers.join(', ')})`;
        case 'duplicate_channel_owner':
            return `channel ${issue.channel_id} belongs to multiple tiers (${issue.tiers.join(', ')})`;
        case 'unregistered_channel':
            return `channel ${issue.channel_id} is not registered to an enabled tier`;
        case 'unknown_tier':
            return `unknown or disabled tier ${issue.tier}`;
        case 'channel_not_owned_by_tier':
            return `channel ${issue.channel_id} is not owned by tier ${issue.tier}${issue.owner ? ` (owner: ${issue.owner})` : ''}`;
    }
}

/**
 * A tenant's active routing topology. ChannelGroup is the only Portal-side
 * source of truth: callers must never invent `pool`, `default`, or another
 * fallback tier when this topology is incomplete.
 */
export class ChannelGroupTopology {
    readonly byTier = new Map<string, TopologyGroup>();
    readonly channelOwner = new Map<number, string>();
    readonly defaultGroup: TopologyGroup;

    constructor(
        readonly tenantId: string,
        readonly groups: TopologyGroup[],
    ) {
        const issues: ChannelGroupTopologyIssue[] = [];
        if (groups.length === 0) issues.push({ code: 'no_enabled_groups' });

        const defaults = groups.filter((group) => group.is_default);
        if (defaults.length !== 1) issues.push({ code: 'invalid_default_count', count: defaults.length });

        const owners = new Map<number, string[]>();
        const groupOwners = new Map<string, string[]>();
        for (const group of groups) {
            this.byTier.set(group.key, group);
            if (group.newapi_channel_ids.length === 0) issues.push({ code: 'tier_has_no_channels', tier: group.key });
            groupOwners.set(group.newapi_group, [...(groupOwners.get(group.newapi_group) ?? []), group.key]);
            for (const channelId of group.newapi_channel_ids) {
                owners.set(channelId, [...(owners.get(channelId) ?? []), group.key]);
            }
        }
        for (const [newapiGroup, tiers] of groupOwners) {
            const uniqueTiers = [...new Set(tiers)];
            if (uniqueTiers.length > 1) {
                issues.push({ code: 'duplicate_newapi_group', newapi_group: newapiGroup, tiers: uniqueTiers });
            }
        }
        for (const [channelId, tiers] of owners) {
            const uniqueTiers = [...new Set(tiers)];
            if (uniqueTiers.length > 1) {
                issues.push({ code: 'duplicate_channel_owner', channel_id: channelId, tiers: uniqueTiers });
            } else {
                this.channelOwner.set(channelId, uniqueTiers[0]);
            }
        }

        if (issues.length > 0) throw new ChannelGroupTopologyError(tenantId, issues);
        this.defaultGroup = defaults[0];
    }

    validateUpstreamMap(map: UpstreamMapLike, options: { allowEmpty?: boolean } = {}): ChannelGroupTopologyIssue[] {
        const entries = Object.entries(map);
        if (entries.length === 0 && !options.allowEmpty) return [{ code: 'empty_upstream_map' }];

        const issues: ChannelGroupTopologyIssue[] = [];
        for (const [tier, entry] of entries) {
            if (!this.byTier.has(tier)) {
                issues.push({ code: 'unknown_tier', tier });
                continue;
            }
            const owner = this.channelOwner.get(entry.channel_id) ?? null;
            if (owner !== tier) {
                issues.push({ code: 'channel_not_owned_by_tier', tier, channel_id: entry.channel_id, owner });
            }
        }
        return issues;
    }
}

export async function loadChannelGroupTopology(tenantId: string | null): Promise<ChannelGroupTopology> {
    const resolvedTenantId = tenantId ?? PLATFORM_TENANT_ID;
    const groups = await prisma.channelGroup.findMany({
        where: { tenant_id: resolvedTenantId, enabled: true },
        orderBy: [{ tier_level: 'asc' }, { key: 'asc' }],
        select: {
            key: true,
            newapi_group: true,
            newapi_channel_ids: true,
            is_default: true,
            enabled: true,
            tier_level: true,
        },
    });
    return new ChannelGroupTopology(resolvedTenantId, groups);
}

export function topologyErrorPayload(error: ChannelGroupTopologyError) {
    return {
        error: 'channel_group_topology_invalid',
        message: error.message,
        issues: error.issues,
    };
}
