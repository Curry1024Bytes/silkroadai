import 'server-only';
import { generateChannelGroupKey } from '@/lib/channel-group-key';
import { inferVendor, isImageModel, toDisplayName } from '@/lib/newapi/import-catalog';
import { readSyncPrice } from '@/lib/newapi/catalog-sync-prices';
import type { TopologyGroup, UpstreamMapLike } from '@/lib/channel-group-topology';
import type { NewApiSyncItem } from './newapi-sync-types';
import type { NewApiSyncSource, SyncChannel } from './newapi-sync-source';

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
function item(
    kind: NewApiSyncItem['kind'],
    key: string,
    title: string,
    change: NewApiSyncItem['change'],
): NewApiSyncItem {
    return {
        id: operationId(kind, key),
        kind,
        change,
        title,
        before: [],
        after: [],
        notes: [],
        selectable: true,
        defaultSelected: change === 'new' || change === 'update',
        canActivate: false,
        dependsOn: [],
    };
}

/** Build a reviewable, deterministic plan. No writes, no network and no guessed channel ownership. */
export function buildNewApiSyncPlan(state: SyncState, source: NewApiSyncSource, now: number): SyncPlan {
    const plan: SyncPlan = {
        items: [],
        warnings: [],
        unchanged: { groups: 0, models: 0, prices: 0 },
        groups: [],
        models: [],
        prices: [],
    };
    const active = source.channels.filter((channel) => channel.status === 1);
    const groupsByName = new Map<string, SyncGroup[]>();
    for (const group of state.groups)
        groupsByName.set(group.newapi_group, [...(groupsByName.get(group.newapi_group) ?? []), group]);
    const assigned = new Map<string, SyncChannel[]>();
    for (const channel of active) {
        const owners = state.groups.filter((group) => group.enabled && group.newapi_channel_ids.includes(channel.id));
        const names = channel.groups.filter((name) => Object.hasOwn(source.groups, name));
        let name: string | undefined;
        if (owners.length === 1 && names.includes(owners[0].newapi_group)) name = owners[0].newapi_group;
        else if (owners.length === 0 && names.length === 1) name = names[0];
        if (name) assigned.set(name, [...(assigned.get(name) ?? []), channel]);
        else if (names.length || owners.length)
            plan.warnings.push(
                `渠道 #${channel.id}「${channel.name}」归属不明确或分组已改变，请在渠道分组核对；本次不自动改档。`,
            );
    }
    const usedKeys = new Set(state.groups.map((group) => group.key));
    let level = Math.max(0, ...state.groups.map((group) => group.tier_level)) + 1;
    const candidates = new Map<string, { group: SyncGroup; channels: SyncChannel[]; operation?: GroupChange }>();
    for (const name of [...new Set([...Object.keys(source.groups), ...groupsByName.keys()])].sort()) {
        const matches = groupsByName.get(name) ?? [];
        if (matches.length > 1) {
            plan.warnings.push(`new-api 分组「${name}」对应多个 Portal 档次，请先核对归属。`);
            continue;
        }
        const current = matches[0] ?? null;
        const live = Object.hasOwn(source.groups, name);
        const channels = assigned.get(name) ?? [];
        const key = current?.key ?? generateChannelGroupKey(name, usedKeys);
        usedKeys.add(key);
        const next: SyncGroup = current
            ? { ...current, newapi_channel_ids: channels.map((channel) => channel.id) }
            : {
                  id: '',
                  key,
                  display_name: source.groups[name],
                  newapi_group: name,
                  newapi_channel_ids: channels.map((channel) => channel.id),
                  enabled: false,
                  is_default: false,
                  tier_level: level++,
                  updated_at: '',
              };
        if (!live || channels.length === 0) {
            if (!current) {
                const row = item('group', key, source.groups[name], 'new');
                row.after = ['保存为停用候选，尚无可唯一登记的启用渠道'];
                row.notes = ['在 new-api 核对渠道分组后重新同步。'];
                const operation = { item: row, current, next };
                plan.groups.push(operation);
                plan.items.push(row);
            } else {
                const row = item('group', key, current.display_name, 'unavailable');
                row.before = current.newapi_channel_ids.map((id) => `渠道 #${id}`);
                row.after = [live ? '没有可唯一归属的启用渠道' : 'new-api 分组已删除或隐藏'];
                row.notes = ['保留档次、客户 Key 和历史价格，请核对渠道或下架受影响模型。'];
                row.selectable = false;
                row.defaultSelected = false;
                plan.items.push(row);
            }
            continue;
        }
        const changed =
            !current ||
            !equal(
                [...current.newapi_channel_ids].sort((a, b) => a - b),
                next.newapi_channel_ids,
            );
        let operation: GroupChange | undefined;
        if (changed || !current?.enabled) {
            const row = item('group', key, next.display_name, current ? 'update' : 'new');
            row.before = current ? current.newapi_channel_ids.map((id) => `渠道 #${id}`) : ['尚无档次'];
            row.after = channels.map((channel) => `#${channel.id} ${channel.name}`);
            row.canActivate = !current?.enabled;
            row.defaultSelected = changed;
            if (row.canActivate) row.notes.push('默认保存为停用候选；勾选启用后才可供客户选择。');
            if (row.canActivate) row.notes.push('启用后重新预览，可为已有上架模型补充本档映射。');
            operation = { item: row, current, next };
            plan.groups.push(operation);
            plan.items.push(row);
        } else plan.unchanged.groups++;
        candidates.set(key, { group: next, channels, operation });
    }

    const existingBySlug = new Map(state.models.map((model) => [model.slug, model]));
    const slugs = new Set(state.models.map((model) => model.slug));
    for (const candidate of candidates.values())
        for (const channel of candidate.channels) for (const slug of channel.models) slugs.add(slug);
    let sort = Math.max(0, ...state.models.map((model) => model.sort_order));
    const plannedModels = new Map<string, SyncModel>();
    for (const slug of [...slugs].sort()) {
        const current = existingBySlug.get(slug) ?? null;
        const next: SyncModel = current
            ? { ...current, upstream_map: { ...current.upstream_map } }
            : {
                  id: '',
                  slug,
                  display_name: toDisplayName(slug),
                  vendor: inferVendor(slug),
                  modality: isImageModel(slug) ? 'image' : 'chat',
                  enabled: false,
                  sort_order: ++sort,
                  upstream_map: {},
                  updated_at: '',
              };
        const notes: string[] = [];
        for (const [tier, entry] of Object.entries(current?.upstream_map ?? {})) {
            const candidate = candidates.get(tier);
            const supporting =
                candidate?.channels.filter((channel) => channel.models.includes(entry.upstream_model)) ?? [];
            if (supporting.some((channel) => channel.id === entry.channel_id)) continue;
            if (supporting.length === 1) next.upstream_map[tier] = { ...entry, channel_id: supporting[0].id };
            else
                notes.push(
                    `${tier} · ${entry.upstream_model}：${supporting.length ? '有多个替换渠道，请手动选择' : '渠道已删除、停用或不再支持该模型'}。`,
                );
        }
        for (const [tier, candidate] of candidates) {
            if (Object.hasOwn(next.upstream_map, tier)) continue;
            // Do not attach an inactive tier to an already published model.
            if (current?.enabled && !candidate.group.enabled) continue;
            const matching = candidate.channels.filter((channel) => channel.models.includes(slug));
            if (matching.length === 1) next.upstream_map[tier] = { channel_id: matching[0].id, upstream_model: slug };
            else if (matching.length > 1) notes.push(`${tier}：多个渠道提供同名模型，请先选择目录登记渠道。`);
        }
        if (!current && Object.keys(next.upstream_map).length === 0) {
            if (notes.length) {
                const row = item('model', slug, slug, 'missing');
                row.notes = notes;
                row.selectable = false;
                row.defaultSelected = false;
                plan.items.push(row);
            }
            continue;
        }
        if (current && Object.keys(next.upstream_map).length === 0)
            notes.push('当前模型没有可用渠道映射，保持未上架。');
        const changed = !current || !equal(current.upstream_map, next.upstream_map);
        if (changed || (!current?.enabled && notes.length === 0)) {
            const row = item('model', slug, next.display_name, current ? 'update' : 'new');
            row.before = current ? mapLines(current.upstream_map) : ['尚无目录模型'];
            row.after = mapLines(next.upstream_map);
            row.notes = notes;
            row.canActivate = !current?.enabled && notes.length === 0;
            row.defaultSelected = changed;
            if (row.canActivate)
                row.notes.push('默认保存为未上架模型；上架需关联档次已启用、价格完整，并另行确认真实调用可用。');
            for (const tier of Object.keys(next.upstream_map)) {
                const operation = candidates.get(tier)?.operation;
                if (
                    operation &&
                    (operation.current === null || !equal(current?.upstream_map[tier], next.upstream_map[tier]))
                )
                    row.dependsOn.push(operation.item.id);
            }
            plan.models.push({ item: row, current, next });
            plan.items.push(row);
        } else if (notes.length) {
            const row = item('model', slug, next.display_name, 'unavailable');
            row.before = mapLines(next.upstream_map);
            row.notes = notes;
            row.after = ['保留模型及历史；请核对渠道，必要时在模型管理中下架'];
            row.selectable = false;
            row.defaultSelected = false;
            plan.items.push(row);
        } else plan.unchanged.models++;
        plannedModels.set(slug, next);
    }

    // Registry removals must migrate ALL references, including unpublished models.
    for (const operation of plan.groups) {
        if (!operation.current) continue;
        const removed = operation.current.newapi_channel_ids.filter(
            (id) => !operation.next.newapi_channel_ids.includes(id),
        );
        for (const model of state.models) {
            const entry = model.upstream_map[operation.next.key];
            if (!entry || !removed.includes(entry.channel_id)) continue;
            const modelChange = plan.models.find((change) => change.next.slug === model.slug);
            if (modelChange && !removed.includes(modelChange.next.upstream_map[operation.next.key]?.channel_id))
                operation.item.dependsOn.push(modelChange.item.id);
            else {
                operation.item.selectable = false;
                operation.item.defaultSelected = false;
                operation.item.canActivate = false;
                operation.item.notes.push(`模型「${model.display_name}」无法迁移到新渠道，请先处理该模型的归属。`);
            }
        }
    }
    // A blocked registry operation also blocks its dependent mapping changes.
    let propagated = true;
    while (propagated) {
        propagated = false;
        for (const row of plan.items)
            if (
                row.selectable &&
                row.dependsOn.some((id) => plan.items.find((other) => other.id === id)?.selectable === false)
            ) {
                row.selectable = false;
                row.defaultSelected = false;
                row.canActivate = false;
                row.notes.push('关联变更尚需核对，本项暂不能同步。');
                propagated = true;
            }
    }

    for (const [slug, model] of plannedModels)
        for (const [tier, mapping] of Object.entries(model.upstream_map)) {
            const candidate = candidates.get(tier);
            if (
                !candidate ||
                !candidate.channels.some(
                    (channel) => channel.id === mapping.channel_id && channel.models.includes(mapping.upstream_model),
                )
            )
                continue;
            const current = model.id ? currentSyncPrice(state, model.id, tier, now) : null;
            const result = readSyncPrice(source.prices, mapping.upstream_model, candidate.group.newapi_group);
            const price = result.price;
            const protectedSku = /^gpt-image-2-(1k|2k|4k)$/.test(slug);
            const scheduled = state.prices.some(
                (row) => row.model_id === model.id && row.tier === tier && Date.parse(row.effective_from) > now,
            );
            const unsupported =
                (result.basis === 'request' && model.modality !== 'image') ||
                (result.basis === 'token' && model.modality === 'image');
            if (!price || protectedSku || scheduled || unsupported) {
                if (protectedSku && current) {
                    plan.unchanged.prices++;
                    continue;
                }
                const row = item(
                    'price',
                    `${slug}\u0000${tier}`,
                    `${model.display_name} · ${candidate.group.display_name}`,
                    'missing',
                );
                row.before = priceLines(current);
                row.after = ['保留已有价格，待核对'];
                row.selectable = false;
                row.defaultSelected = false;
                row.notes = [
                    protectedSku
                        ? '固定图片规格的价格需按规格单独核对，不从通用上游价格覆盖。'
                        : scheduled
                          ? '已有未来生效价格，请先核对定价计划。'
                          : unsupported
                            ? '该计费方式无法用当前目录价格完整表达，请到定价页核对。'
                            : (result.reason ?? '未能读取完整价格，未使用默认倍率推算。'),
                ];
                plan.items.push(row);
                continue;
            }
            if (current && equal(valueOf(current), price)) {
                plan.unchanged.prices++;
                continue;
            }
            const row = item(
                'price',
                `${slug}\u0000${tier}`,
                `${model.display_name} · ${candidate.group.display_name}`,
                current ? 'update' : 'new',
            );
            row.before = priceLines(current);
            row.after = priceLines(price);
            row.defaultSelected = !current;
            row.notes = ['把 new-api 当前零售价记录到 Portal；新增价格版本、保留历史和成本，不回写 new-api。'];
            const modelChange = plan.models.find((change) => change.next.slug === slug);
            if (
                modelChange &&
                (!modelChange.current || !equal(modelChange.current.upstream_map, modelChange.next.upstream_map))
            )
                row.dependsOn.push(modelChange.item.id);
            if (candidate.operation) row.dependsOn.push(candidate.operation.item.id);
            if (row.dependsOn.some((id) => plan.items.find((other) => other.id === id)?.selectable === false)) {
                row.selectable = false;
                row.defaultSelected = false;
                row.notes.push('关联渠道或模型需先核对。');
            }
            plan.prices.push({ item: row, slug, tier, current, next: price, mapping });
            plan.items.push(row);
        }
    return plan;
}
