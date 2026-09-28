import 'server-only';
import { generateChannelGroupKey } from '@/lib/channel-group-key';
import { inferVendor, isImageModel, toDisplayName } from '@/lib/newapi/import-catalog';
import { readSyncPrice } from '@/lib/newapi/catalog-sync-prices';
import {
    ChannelGroupTopology,
    ChannelGroupTopologyError,
    type ChannelGroupTopologyIssue,
    type TopologyGroup,
    type UpstreamMapLike,
} from '@/lib/channel-group-topology';
import type { NewApiSyncItem, NewApiSyncSummary } from './newapi-sync-types';
import type { NewApiSyncSource } from './newapi-sync-source';

export interface SyncGroup extends TopologyGroup {
    id: string;
    display_name: string;
    updated_at: string;
}
export interface SyncPrice {
    id: string;
    model_id: string;
    tier: string;
    effective_from: string;
    input_cny_per_1m: number | null;
    output_cny_per_1m: number | null;
    per_image_cny: number | null;
    cost_cny_per_1m: number | null;
}
export type PriceValues = Pick<SyncPrice, 'input_cny_per_1m' | 'output_cny_per_1m' | 'per_image_cny'>;
export interface SyncModel {
    id: string;
    slug: string;
    display_name: string;
    vendor: string;
    modality: string;
    enabled: boolean;
    sort_order: number;
    upstream_map: UpstreamMapLike;
    updated_at: string;
}
export interface SyncState {
    groups: SyncGroup[];
    models: SyncModel[];
    prices: SyncPrice[];
}
export interface GroupChange {
    item: NewApiSyncItem;
    current: SyncGroup | null;
    next: SyncGroup;
}
export interface ModelChange {
    item: NewApiSyncItem;
    current: SyncModel | null;
    next: SyncModel;
}
export interface PriceChange {
    item: NewApiSyncItem;
    slug: string;
    tier: string;
    current: SyncPrice | null;
    next: PriceValues;
    mapping: UpstreamMapLike[string];
}
export interface SyncPlan {
    items: NewApiSyncItem[];
    warnings: string[];
    summary: NewApiSyncSummary;
    /** Set when the aligned catalog would be inconsistent; nothing can be applied. */
    blocked: string | null;
    unchanged: { groups: number; models: number; prices: number };
    groups: GroupChange[];
    models: ModelChange[];
    prices: PriceChange[];
}

export function canonicalSync(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalSync).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonicalSync(item)}`)
            .join(',')}}`;
    return JSON.stringify(value) ?? 'null';
}
const equal = (a: unknown, b: unknown) => canonicalSync(a) === canonicalSync(b);
const operationId = (kind: string, ...values: string[]) => `${kind}:${values.map(encodeURIComponent).join(':')}`;
const mapLines = (map: UpstreamMapLike) =>
    Object.entries(map)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tier, entry]) => `${tier} · #${entry.channel_id} · ${entry.upstream_model}`);
const priceLines = (price: PriceValues | null) =>
    !price
        ? ['未设置目录价格']
        : price.per_image_cny !== null
          ? [`¥${price.per_image_cny} / 张`]
          : [
                `输入 ¥${price.input_cny_per_1m ?? '未设置'} / 百万 token`,
                `输出 ¥${price.output_cny_per_1m ?? '未设置'} / 百万 token`,
            ];
const valueOf = (price: PriceValues): PriceValues => ({
    input_cny_per_1m: price.input_cny_per_1m,
    output_cny_per_1m: price.output_cny_per_1m,
    per_image_cny: price.per_image_cny,
});
export function currentSyncPrice(state: SyncState, modelId: string, tier: string, now: number): SyncPrice | null {
    return (
        state.prices
            .filter(
                (price) => price.model_id === modelId && price.tier === tier && Date.parse(price.effective_from) <= now,
            )
            .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.id.localeCompare(a.id))[0] ?? null
    );
}
export const PROTECTED_SKU = /^gpt-image-2-(1k|2k|4k)$/;
/** A catalog price that can actually be charged for the model's modality. */
export function validSyncPrice(value: PriceValues | null, modality: string): boolean {
    const ok = (amount: number | null) => amount !== null && Number.isFinite(amount) && amount >= 0;
    return (
        !!value &&
        (modality === 'image'
            ? ok(value.per_image_cny)
            : value.per_image_cny === null && ok(value.input_cny_per_1m) && ok(value.output_cny_per_1m))
    );
}
function groupRatioNames(raw: unknown): Set<string> {
    let parsed = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            return new Set();
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set();
    return new Set(
        Object.entries(parsed)
            .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
            .map(([name]) => name),
    );
}
function topologyMessage(issues: ChannelGroupTopologyIssue[]): string {
    const lines = issues.map((issue) => {
        switch (issue.code) {
            case 'no_enabled_groups':
                return '同步后没有任何启用的档次';
            case 'invalid_default_count':
                return '同步后需要恰好一个启用的默认档次';
            case 'duplicate_newapi_group':
                return `new-api 分组「${issue.newapi_group}」对应多个启用档次（${issue.tiers.join('、')}）`;
            case 'duplicate_channel_owner':
                return `渠道 #${issue.channel_id} 同时登记在多个启用档次（${issue.tiers.join('、')}）`;
            case 'tier_has_no_channels':
                return `档次「${issue.tier}」没有渠道`;
            case 'unknown_tier':
                return `模型引用了未启用的档次「${issue.tier}」`;
            case 'channel_not_owned_by_tier':
                return `渠道 #${issue.channel_id} 不属于档次「${issue.tier}」`;
            default:
                return '档次配置不完整';
        }
    });
    return `${[...new Set(lines)].join('；')}。请先在 new-api 或渠道分组中核对后重新同步。`;
}
function listed(items: string[]): string {
    const shown = items.slice(0, 10).join('、');
    return items.length > 10 ? `${shown} 等 ${items.length} 项` : shown;
}
function item(
    kind: NewApiSyncItem['kind'],
    key: string,
    title: string,
    change: NewApiSyncItem['change'],
    before: string[],
    after: string[],
): NewApiSyncItem {
    return { id: operationId(kind, key), kind, change, title, before, after };
}

type PriceStatus =
    | { ok: true; current: SyncPrice | null; next: PriceValues | null }
    | { ok: false; issue: 'protected' | 'scheduled' | 'unsupported' | 'missing'; reason: string };

/**
 * Align the Portal catalog with new-api: new-api channels decide which models each tier sells,
 * new-api prices decide the catalog price. Deterministic, no writes and no network.
 * Models are never deleted; purchase rates, display names and price history are preserved.
 */
export function buildNewApiSyncPlan(state: SyncState, source: NewApiSyncSource, now: number): SyncPlan {
    const plan: SyncPlan = {
        items: [],
        warnings: [],
        summary: {
            groups_created: 0,
            groups_updated: 0,
            models_published: 0,
            models_unpublished: 0,
            models_updated: 0,
            prices_updated: 0,
        },
        blocked: null,
        unchanged: { groups: 0, models: 0, prices: 0 },
        groups: [],
        models: [],
        prices: [],
    };
    const channelById = new Map(source.channels.map((channel) => [channel.id, channel]));
    const groupsByName = new Map<string, SyncGroup[]>();
    for (const group of state.groups)
        groupsByName.set(group.newapi_group, [...(groupsByName.get(group.newapi_group) ?? []), group]);
    const usable = (name: string) => Object.hasOwn(source.groups, name);
    const ratioNames = groupRatioNames(source.prices.groupRatio);

    // 1. Each active channel belongs to exactly one tier: its existing owner if still valid, else its only group.
    const assigned = new Map<string, number[]>();
    const ambiguous: string[] = [];
    for (const channel of source.channels.filter((row) => row.status === 1)) {
        const names = [...new Set(channel.groups.filter((name) => usable(name) || groupsByName.has(name)))];
        const owners = state.groups.filter((group) => group.enabled && group.newapi_channel_ids.includes(channel.id));
        let name: string | undefined;
        if (owners.length === 1 && names.includes(owners[0].newapi_group)) name = owners[0].newapi_group;
        else if (names.length === 1) name = names[0];
        else if (names.length > 1) ambiguous.push(`#${channel.id}「${channel.name}」（${names.join('、')}）`);
        if (name) assigned.set(name, [...(assigned.get(name) ?? []), channel.id]);
    }
    if (ambiguous.length)
        plan.warnings.push(
            `${ambiguous.length} 个渠道同时属于多个分组，无法判断归属，本次不登记：${listed(ambiguous)}`,
        );

    // 2. Tier registries follow new-api; new sellable groups become enabled tiers.
    const channelLines = (ids: number[]) =>
        ids.length ? ids.map((id) => `#${id} ${channelById.get(id)?.name ?? '（new-api 中已不存在）'}`) : ['没有渠道'];
    const groupStatus = (enabled: boolean) => (enabled ? '状态：已启用' : '状态：停用');
    const usedKeys = new Set(state.groups.map((group) => group.key));
    let level = Math.max(0, ...state.groups.map((group) => group.tier_level)) + 1;
    const nextGroups: SyncGroup[] = [];
    for (const name of [...new Set([...Object.keys(source.groups), ...groupsByName.keys()])].sort()) {
        const matches = groupsByName.get(name) ?? [];
        if (matches.length > 1) {
            plan.warnings.push(`new-api 分组「${name}」对应多个 Portal 档次，请先核对归属；本次不修改这些档次。`);
            nextGroups.push(...matches);
            continue;
        }
        const current = matches[0] ?? null;
        const ids = (assigned.get(name) ?? []).sort((a, b) => a - b);
        if (!current) {
            if (!ids.length) continue;
            if (!ratioNames.has(name)) {
                plan.warnings.push(
                    `new-api 分组「${source.groups[name] ?? name}」没有设置分组倍率，暂不建档次；设置倍率后重新同步即可。`,
                );
                continue;
            }
            const key = generateChannelGroupKey(name, usedKeys);
            usedKeys.add(key);
            const next: SyncGroup = {
                id: '',
                key,
                display_name: source.groups[name],
                newapi_group: name,
                newapi_channel_ids: ids,
                enabled: true,
                is_default: false,
                tier_level: level++,
                updated_at: '',
            };
            const row = item(
                'group',
                key,
                next.display_name,
                'create',
                ['尚无档次'],
                [...channelLines(ids), groupStatus(true)],
            );
            plan.groups.push({ item: row, current, next });
            plan.items.push(row);
            plan.summary.groups_created++;
            nextGroups.push(next);
            continue;
        }
        if (current.enabled && ids.length && !usable(name))
            plan.warnings.push(
                `new-api 分组「${name}」已不在用户可选分组中，档次「${current.display_name}」仍按渠道同步，请确认是否继续售卖。`,
            );
        let enabled = current.enabled;
        if (!ids.length) {
            if (current.enabled && current.is_default) {
                plan.blocked ??= `默认档次「${current.display_name}」在 new-api 已没有可用渠道，请先在 new-api 恢复渠道，或在渠道分组中更换默认档次。`;
                nextGroups.push(current);
                continue;
            }
            enabled = false;
        }
        const next: SyncGroup = { ...current, newapi_channel_ids: ids, enabled };
        nextGroups.push(next);
        if (equal(current.newapi_channel_ids, ids) && enabled === current.enabled) {
            plan.unchanged.groups++;
            continue;
        }
        const row = item(
            'group',
            current.key,
            current.display_name,
            'update',
            [...channelLines(current.newapi_channel_ids), groupStatus(current.enabled)],
            [...channelLines(ids), groupStatus(enabled)],
        );
        plan.groups.push({ item: row, current, next });
        plan.items.push(row);
        plan.summary.groups_updated++;
    }
    const enabledGroups = nextGroups
        .filter((group) => group.enabled)
        .sort((a, b) => a.tier_level - b.tier_level || a.key.localeCompare(b.key));
    const byKey = new Map(nextGroups.map((group) => [group.key, group]));
    let topology: ChannelGroupTopology | null = null;
    try {
        topology = new ChannelGroupTopology('', enabledGroups);
    } catch (error) {
        if (!(error instanceof ChannelGroupTopologyError)) throw error;
        plan.blocked ??= topologyMessage(error.issues);
    }
    const owners = new Map<number, string[]>();
    for (const group of enabledGroups)
        for (const id of group.newapi_channel_ids) owners.set(id, [...(owners.get(id) ?? []), group.key]);
    const sellable = (tier: string, entry: UpstreamMapLike[string]) => {
        const channel = channelById.get(entry.channel_id);
        const owner = owners.get(entry.channel_id);
        return (
            byKey.get(tier)?.enabled === true &&
            owner?.length === 1 &&
            owner[0] === tier &&
            channel?.status === 1 &&
            channel.models.includes(entry.upstream_model)
        );
    };
    const supportingChannel = (group: SyncGroup, upstream: string) =>
        group.newapi_channel_ids.find((id) => sellable(group.key, { channel_id: id, upstream_model: upstream }));

    // 3. Models: sold while any tier sells them, published once a tier also has a valid price.
    const priceStatus = (model: SyncModel, tier: string, upstream: string): PriceStatus => {
        const group = byKey.get(tier)!;
        const current = model.id ? currentSyncPrice(state, model.id, tier, now) : null;
        if (PROTECTED_SKU.test(model.slug))
            return current && validSyncPrice(current, model.modality)
                ? { ok: true, current, next: null }
                : { ok: false, issue: 'protected', reason: '' };
        const live = readSyncPrice(source.prices, upstream, group.newapi_group);
        if (!live.price) return { ok: false, issue: 'missing', reason: live.reason ?? '价格不完整' };
        if ((live.basis === 'request') !== (model.modality === 'image'))
            return { ok: false, issue: 'unsupported', reason: '' };
        if (current && equal(valueOf(current), live.price)) return { ok: true, current, next: null };
        if (
            state.prices.some(
                (row) => row.model_id === model.id && row.tier === tier && Date.parse(row.effective_from) > now,
            )
        )
            return { ok: false, issue: 'scheduled', reason: '' };
        return { ok: true, current, next: live.price };
    };
    const issues = {
        missing: [] as string[],
        unsupported: [] as string[],
        scheduled: [] as string[],
        protected: [] as string[],
    };
    const priceChanges: PriceChange[] = [];
    const modelStatus = (enabled: boolean) => (enabled ? '状态：已上架' : '状态：未上架');
    const existingBySlug = new Map(state.models.map((model) => [model.slug, model]));
    const slugs = new Set(state.models.map((model) => model.slug));
    // An upstream name another catalog entry already sells in a tier is not offered again there.
    const claimed = new Set(
        state.models.flatMap((model) =>
            Object.entries(model.upstream_map).map(([tier, entry]) => `${tier}\u0000${entry.upstream_model}`),
        ),
    );
    for (const group of enabledGroups)
        for (const id of group.newapi_channel_ids)
            for (const slug of channelById.get(id)?.models ?? [])
                if (!claimed.has(`${group.key}\u0000${slug}`)) slugs.add(slug);
    let sort = Math.max(0, ...state.models.map((model) => model.sort_order));
    const finalModels: SyncModel[] = [];
    for (const slug of [...slugs].sort()) {
        const current = existingBySlug.get(slug) ?? null;
        const base: SyncModel = current ?? {
            id: '',
            slug,
            display_name: toDisplayName(slug),
            vendor: inferVendor(slug),
            modality: isImageModel(slug) ? 'image' : 'chat',
            enabled: false,
            sort_order: 0,
            upstream_map: {},
            updated_at: '',
        };
        const map: UpstreamMapLike = {};
        for (const [tier, entry] of Object.entries(base.upstream_map)) {
            const group = byKey.get(tier);
            if (!group?.enabled) continue;
            if (sellable(tier, entry)) map[tier] = entry;
            else {
                const replacement = supportingChannel(group, entry.upstream_model);
                if (replacement !== undefined) map[tier] = { ...entry, channel_id: replacement };
                // Keep a still-owned reference so metering keeps resolving the tier; drop anything invalid.
                else if (owners.get(entry.channel_id)?.length === 1 && owners.get(entry.channel_id)?.[0] === tier)
                    map[tier] = entry;
            }
        }
        const statuses = new Map<string, PriceStatus>();
        for (const [tier, entry] of Object.entries(map))
            if (sellable(tier, entry)) statuses.set(tier, priceStatus(base, tier, entry.upstream_model));
        for (const group of enabledGroups) {
            if (Object.hasOwn(map, group.key) || claimed.has(`${group.key}\u0000${slug}`)) continue;
            const channelId = supportingChannel(group, slug);
            if (channelId === undefined) continue;
            const status = priceStatus(base, group.key, slug);
            statuses.set(group.key, status);
            // A tier is only added once it can be priced.
            if (status.ok) map[group.key] = { channel_id: channelId, upstream_model: slug };
        }
        const selling = Object.entries(map).filter(([tier, entry]) => sellable(tier, entry));
        const enabled =
            selling.length > 0 &&
            (current?.enabled === true || selling.some(([tier]) => statuses.get(tier)?.ok === true));
        for (const [tier, status] of statuses) {
            if (status.ok) continue;
            const label = `${base.display_name} · ${byKey.get(tier)!.display_name}`;
            issues[status.issue].push(status.issue === 'missing' ? `${label}（${status.reason}）` : label);
        }
        if (!current && !enabled) continue;
        // A published model lists only the tiers that actually sell it.
        if (enabled) for (const [tier, entry] of Object.entries(map)) if (!sellable(tier, entry)) delete map[tier];
        const next: SyncModel = { ...base, upstream_map: map, enabled, sort_order: current ? base.sort_order : ++sort };
        finalModels.push(next);
        for (const [tier] of selling) {
            const status = statuses.get(tier);
            if (!status?.ok || !Object.hasOwn(map, tier)) continue;
            if (!status.next) {
                plan.unchanged.prices++;
                continue;
            }
            const row = item(
                'price',
                `${slug}\u0000${tier}`,
                `${next.display_name} · ${byKey.get(tier)!.display_name}`,
                status.current ? 'update' : 'create',
                priceLines(status.current),
                priceLines(status.next),
            );
            priceChanges.push({
                item: row,
                slug,
                tier,
                current: status.current,
                next: status.next,
                mapping: map[tier],
            });
        }
        const lines = (value: UpstreamMapLike) => (Object.keys(value).length ? mapLines(value) : ['没有渠道映射']);
        const change: NewApiSyncItem['change'] | null = !current
            ? 'create'
            : enabled !== current.enabled
              ? enabled
                  ? 'publish'
                  : 'unpublish'
              : equal(current.upstream_map, map)
                ? null
                : 'update';
        if (!change) {
            plan.unchanged.models++;
            continue;
        }
        const after = [...lines(map), modelStatus(enabled)];
        if (change === 'unpublish') after.push('new-api 已没有启用渠道提供该模型');
        const row = item(
            'model',
            slug,
            next.display_name,
            change,
            current ? [...lines(current.upstream_map), modelStatus(current.enabled)] : ['尚无目录模型'],
            after,
        );
        plan.models.push({ item: row, current, next });
        plan.items.push(row);
        if (change === 'create' || change === 'publish') plan.summary.models_published++;
        else if (change === 'unpublish') plan.summary.models_unpublished++;
        else plan.summary.models_updated++;
    }
    for (const change of priceChanges) {
        plan.prices.push(change);
        plan.items.push(change.item);
        plan.summary.prices_updated++;
    }
    if (topology)
        for (const model of finalModels)
            if (model.enabled) {
                const problems = topology.validateUpstreamMap(model.upstream_map);
                if (problems.length) plan.blocked ??= `模型「${model.display_name}」：${topologyMessage(problems)}`;
            }
    const price = (kind: keyof typeof issues, text: string) => {
        if (issues[kind].length) plan.warnings.push(`${issues[kind].length} ${text}${listed(issues[kind])}`);
    };
    price('missing', '项未读取到 new-api 价格，未上架或未更新价格：');
    price('unsupported', '项的 new-api 计费方式无法用目录价格表达（按次/按 token 不匹配），请到定价页核对：');
    price('scheduled', '项已有未来生效价格，本次不覆盖：');
    price('protected', '项为固定图片规格，价格需在定价页单独核对，不从通用上游价格覆盖：');
    return plan;
}
