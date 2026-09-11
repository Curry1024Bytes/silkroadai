import 'server-only';
import { getCatalogSyncOptions, listChannelsForCatalogSync } from '@/lib/newapi/client';
import { replacementChannel } from './channel-replacement';
import type { RawSyncPrices } from '@/lib/newapi/catalog-sync-prices';

export interface SyncChannel {
    id: number;
    name: string;
    status: number;
    groups: string[];
    models: string[];
}
export interface NewApiSyncSource {
    channels: SyncChannel[];
    groups: Record<string, string>;
    prices: RawSyncPrices;
}

export async function readNewApiSyncSource(): Promise<NewApiSyncSource> {
    const [rows, options] = await Promise.all([listChannelsForCatalogSync(), getCatalogSyncOptions()]);
    const raw = options.UserUsableGroups;
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0)
        throw new Error('Missing usable groups');
    const groups: Record<string, string> = Object.create(null);
    for (const [group, label] of Object.entries(parsed)) {
        if (!group.trim() || typeof label !== 'string') throw new Error('Invalid usable group');
        if (!label.trim().startsWith('@')) groups[group] = label.trim() || group;
    }
    const channels = rows
        .map((row) => {
            if (typeof row.group !== 'string' || typeof row.models !== 'string' || !Number.isInteger(row.status))
                throw new Error('Incomplete channel metadata');
            const channel = replacementChannel(row);
            return {
                id: channel.id,
                name: channel.name,
                status: channel.status!,
                groups: channel.groups,
                models: channel.models,
            };
        })
        .sort((a, b) => a.id - b.id);
    return {
        channels,
        groups,
        prices: {
            modelRatio: options.ModelRatio,
            completionRatio: options.CompletionRatio,
            modelPrice: options.ModelPrice,
            groupRatio: options.GroupRatio,
        },
    };
}
