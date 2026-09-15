import 'server-only';
import { getCatalogSyncOptions, listChannelsForCatalogSync } from '@/lib/newapi/client';
import type { ChannelGroupRetirementUpstream } from './channel-group-retirement-types';

export interface ChannelGroupRetirementSource {
    group_name: string;
    upstream: ChannelGroupRetirementUpstream;
    // Only non-secret membership metadata is retained for preview revalidation.
    evidence: {
        channels: { id: number; groups: string[] }[] | null;
        usable_groups: string[] | null;
        ratio_groups: string[] | null;
    };
}

function mapKeys(raw: unknown, kind: 'labels' | 'ratios'): string[] | null {
    try {
        const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        if (
            Object.entries(value).some(
                ([key, item]) =>
                    !key.trim() ||
                    (kind === 'labels'
                        ? typeof item !== 'string'
                        : typeof item !== 'number' || !Number.isFinite(item) || item < 0),
            )
        )
            return null;
        // Empty dictionaries are a valid, complete answer. Hidden (@...) labels
        // remain included: hiding a group does not mean it was deleted.
        return Object.keys(value).sort();
    } catch {
        return null;
    }
}

/** GET-only; uncertainty must never be presented as a confirmed upstream deletion. */
export async function readChannelGroupRetirementSource(groupName: string): Promise<ChannelGroupRetirementSource> {
    const [channelRead, optionRead] = await Promise.allSettled([listChannelsForCatalogSync(), getCatalogSyncOptions()]);
    let channels: ChannelGroupRetirementSource['evidence']['channels'] = null;
    if (channelRead.status === 'fulfilled') {
        const rows = channelRead.value;
        if (
            Array.isArray(rows) &&
            rows.every((row) => row && Number.isSafeInteger(row.id) && row.id > 0 && typeof row.group === 'string') &&
            new Set(rows.map((row) => row.id)).size === rows.length
        ) {
            channels = rows
                .map((row) => ({
                    id: row.id,
                    groups: [
                        ...new Set(
                            (row.group as string)
                                .split(',')
                                .map((name) => name.trim())
                                .filter(Boolean),
                        ),
                    ].sort(),
                }))
                .sort((a, b) => a.id - b.id);
        }
    }
    const usable = optionRead.status === 'fulfilled' ? mapKeys(optionRead.value.UserUsableGroups, 'labels') : null;
    const ratios = optionRead.status === 'fulfilled' ? mapKeys(optionRead.value.GroupRatio, 'ratios') : null;
    const present =
        channels?.some((channel) => channel.groups.includes(groupName)) ||
        usable?.includes(groupName) ||
        ratios?.includes(groupName);
    const upstream: ChannelGroupRetirementUpstream = present
        ? {
              status: 'present',
              message: 'new-api 中仍有这个分组的配置。本次只清理 Portal，不会删除 new-api 分组、渠道或已有 Key。',
          }
        : channels !== null && usable !== null && ratios !== null
          ? {
                status: 'missing',
                message: '已核对 new-api 的完整渠道列表和分组配置，未发现这个分组。可以清理 Portal 中的对应记录。',
            }
          : {
                status: 'unknown',
                message:
                    '暂时无法完整确认 new-api 分组状态。本次仍可只清理 Portal；已有 Key 的实际可用性以 new-api 为准。',
            };
    return { group_name: groupName, upstream, evidence: { channels, usable_groups: usable, ratio_groups: ratios } };
}
