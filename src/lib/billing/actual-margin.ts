import { Prisma } from '@prisma/client';
import { QUOTA_PER_USD, USD_TO_CNY_RATE } from '@/lib/newapi/quota-units';

export type ReferenceKind = 'task' | 'upstream' | 'request';
export interface MarginEvent {
    id: string;
    user_id: string;
    created_at: string;
    type: string;
    channel_id: string | null;
    channel_name: string | null;
    group_name: string | null;
    model_name: string | null;
    quota: string | null;
    request_id: string | null;
    upstream_request_id: string | null;
    task_id: string | null;
    is_task: boolean;
}
export interface MarginTask {
    task_id: string;
    user_id: string;
    channel_id: string;
    submit_time: string | null;
    finish_time: string | null;
    first_charge_at: string | null;
    last_charge_at: string | null;
    status: string | null;
    upstream_task_id: string | null;
}
export interface MarginCost {
    channel_id: number;
    reference_kind: string;
    reference_id: string;
    amount: Prisma.Decimal | string;
    cny_per_unit: Prisma.Decimal | string;
    status: string;
}
export interface ActiveMarginModel {
    model: string;
    name: string;
}
export interface MarginTotals {
    calls: number;
    netCny: string;
    verifiedCalls: number;
    verifiedNetCny: string;
    verifiedCostCny: string | null;
    profitCny: string | null;
    marginPct: string | null;
    pendingCalls: number;
    pendingNetCny: string;
    estimatedCalls: number;
    estimatedCostCny: string | null;
    estimatedProfitCny: string | null;
}
export interface MarginChannel extends MarginTotals {
    id: number;
    name: string;
    group: string;
}
export interface MarginModel extends MarginTotals {
    model: string;
    name: string;
    channels: MarginChannel[];
}
export interface ActualMarginReport {
    summary: MarginTotals;
    models: MarginModel[];
}
export interface MarginChargeDetail {
    id: string;
    time: number;
    references: Reference[];
    netCny: string;
    costCny: string | null;
    status: 'verified' | 'estimated' | 'pending';
}

type ModelLabels = {
    activeModels: ActiveMarginModel[];
    modelKey?: (name: string, group: string) => string;
    groupLabel?: (name: string, channel: number) => string;
};

type Reference = [ReferenceKind, string];
export function costReferenceKey(channel: number, kind: string, id: string) {
    return JSON.stringify([channel, kind, id]);
}

interface Charge {
    id: string;
    time: number;
    channel: number;
    channelName: string;
    group: string;
    model: string;
    quota: bigint;
    hasDebit: boolean;
    hasFailure: boolean;
    task: boolean;
    settledInPeriod: boolean;
    references: Reference[];
}

function taskKey(user: string, channel: string | null, task: string) {
    return JSON.stringify([String(user), String(channel), task]);
}

function accumulateCharges(events: MarginEvent[], tasks: MarginTask[], start: number, end: number) {
    const byTask = new Map(tasks.map((task) => [taskKey(task.user_id, task.channel_id, task.task_id), task]));
    const charges = new Map<string, Charge>();
    for (const row of events) {
        const channel = Number(row.channel_id) || 0;
        const type = Number(row.type);
        const id = row.task_id?.trim();
        const requestId = row.request_id?.trim();
        const upstreamId = row.upstream_request_id?.trim();
        const task = id ? byTask.get(taskKey(row.user_id, row.channel_id, id)) : undefined;
        const asyncTask = Boolean(id || row.is_task);
        const identity = id
            ? ['task', id]
            : requestId
              ? ['request', requestId]
              : upstreamId
                ? ['upstream', upstreamId]
                : ['log', row.id];
        const key = JSON.stringify([row.user_id, channel, ...identity]);
        let charge = charges.get(key);
        if (!charge) {
            const submitted = Number(task?.submit_time);
            const finished = Number(task?.finish_time);
            const settledInPeriod =
                !asyncTask ||
                Boolean(
                    task &&
                    (task.status === 'SUCCESS' || task.status === 'FAILURE') &&
                    submitted >= start &&
                    submitted < end &&
                    finished >= submitted &&
                    finished < end &&
                    task.first_charge_at != null &&
                    Number(task.first_charge_at) >= start &&
                    task.last_charge_at != null &&
                    Number(task.last_charge_at) < end,
                );
            charge = {
                id: row.id,
                time: Number(row.created_at),
                channel,
                channelName: row.channel_name || (channel ? '#' + channel : '未归属渠道'),
                group: row.group_name || '未归属分组',
                model: row.model_name || '（未记录模型）',
                quota: BigInt(0),
                hasDebit: false,
                hasFailure: false,
                task: asyncTask,
                settledInPeriod,
                references: [],
            };
            charges.set(key, charge);
        }
        // Submit/consume rows carry the model and group that the customer actually used.
        if (type === 2 && !charge.hasDebit) {
            charge.model = row.model_name || charge.model;
            charge.group = row.group_name || charge.group;
            charge.channelName = row.channel_name || charge.channelName;
        }
        if (type === 2 || type === 6) {
            const quota = BigInt(row.quota ?? '0');
            if (quota < BigInt(0)) throw new Error('Unexpected signed new-api quota');
            charge.quota += type === 2 ? quota : -quota;
        }
        charge.hasDebit ||= type === 2;
        charge.hasFailure ||= type === 5;
        const references: Reference[] = [];
        if (asyncTask) {
            if (task?.upstream_task_id) references.push(['task', task.upstream_task_id]);
            if (id) references.push(['task', id]);
        } else if (requestId) {
            references.push(['request', requestId]);
        }
        if (upstreamId) references.push(['upstream', upstreamId]);
        for (const [kind, ref] of references) {
            if (!charge.references.some(([existingKind, existingId]) => existingKind === kind && existingId === ref)) {
                charge.references.push([kind, ref]);
            }
        }
    }
    return [...charges.values()];
}

const decimal = (value: string | Prisma.Decimal) => new Prisma.Decimal(value);
const zero = () => decimal('0');

function empty() {
    return {
        calls: 0,
        quota: BigInt(0),
        verified: 0,
        verifiedQuota: BigInt(0),
        verifiedCost: zero(),
        estimated: 0,
        estimatedQuota: BigInt(0),
        estimatedCost: zero(),
        pending: 0,
        pendingQuota: BigInt(0),
    };
}

type Bucket = ReturnType<typeof empty>;

function add(bucket: Bucket, charge: Charge, cost: MarginCost | undefined) {
    bucket.calls++;
    bucket.quota += charge.quota;
    if (cost?.status === 'verified') {
        bucket.verified++;
        bucket.verifiedQuota += charge.quota;
        bucket.verifiedCost = bucket.verifiedCost.plus(decimal(cost.amount).times(cost.cny_per_unit));
    } else if (cost?.status === 'estimated') {
        bucket.estimated++;
        bucket.estimatedQuota += charge.quota;
        bucket.estimatedCost = bucket.estimatedCost.plus(decimal(cost.amount).times(cost.cny_per_unit));
    } else {
        bucket.pending++;
        bucket.pendingQuota += charge.quota;
    }
}

function cny(quota: bigint) {
    return decimal(quota.toString()).times(USD_TO_CNY_RATE).dividedBy(QUOTA_PER_USD);
}

function totals(bucket: Bucket): MarginTotals {
    const verifiedNet = cny(bucket.verifiedQuota);
    const profit = verifiedNet.minus(bucket.verifiedCost);
    return {
        calls: bucket.calls,
        netCny: cny(bucket.quota).toFixed(),
        verifiedCalls: bucket.verified,
        verifiedNetCny: verifiedNet.toFixed(),
        verifiedCostCny: bucket.verified ? bucket.verifiedCost.toFixed() : null,
        profitCny: bucket.verified ? profit.toFixed() : null,
        marginPct: bucket.verified && verifiedNet.gt(0) ? profit.times(100).dividedBy(verifiedNet).toFixed(4) : null,
        pendingCalls: bucket.pending,
        pendingNetCny: cny(bucket.pendingQuota).toFixed(),
        estimatedCalls: bucket.estimated,
        estimatedCostCny: bucket.estimated ? bucket.estimatedCost.toFixed() : null,
        estimatedProfitCny: bucket.estimated ? cny(bucket.estimatedQuota).minus(bucket.estimatedCost).toFixed() : null,
    };
}

export function marginRanking(a: MarginTotals, b: MarginTotals) {
    if (a.profitCny !== null && b.profitCny !== null) return decimal(a.profitCny).comparedTo(b.profitCny);
    if (a.profitCny !== null) return -1;
    if (b.profitCny !== null) return 1;
    return decimal(b.netCny).comparedTo(a.netCny) || b.calls - a.calls;
}

export function buildActualMargin(
    events: MarginEvent[],
    tasks: MarginTask[],
    costs: MarginCost[],
    start: number,
    end: number,
    labels: ModelLabels,
    onCharge?: (model: string, channel: number, group: string, detail: MarginChargeDetail) => void,
): ActualMarginReport {
    const byCostKey = new Map(
        costs.map((cost) => [costReferenceKey(cost.channel_id, cost.reference_kind, cost.reference_id), cost]),
    );
    const active = new Map(labels.activeModels.map((model) => [model.model, model.name]));
    const models = new Map<
        string,
        { totals: Bucket; channels: Map<string, { totals: Bucket; id: number; name: string; group: string }> }
    >();
    for (const model of active.keys()) models.set(model, { totals: empty(), channels: new Map() });
    const summary = empty();
    const charges = accumulateCharges(events, tasks, start, end);
    const referenceUses = new Map<string, number>();
    for (const charge of charges) {
        for (const [kind, id] of charge.references) {
            const key = costReferenceKey(charge.channel, kind, id);
            referenceUses.set(key, (referenceUses.get(key) ?? 0) + 1);
        }
    }

    for (const charge of charges) {
        const references = charge.references.map(([kind, id]) => costReferenceKey(charge.channel, kind, id));
        const found = references.filter((key) => byCostKey.has(key));
        const multiAttempt = !charge.task && charge.references.filter(([kind]) => kind === 'upstream').length > 1;
        // Multiple supplier aliases for one settlement are ambiguous. Pick a single invoice only when its identity is unique.
        const hasSettlement = charge.hasDebit || (charge.hasFailure && charge.quota === BigInt(0));
        const cost =
            hasSettlement &&
            charge.settledInPeriod &&
            !multiAttempt &&
            found.length === 1 &&
            referenceUses.get(found[0]) === 1
                ? byCostKey.get(found[0])
                : undefined;
        if (!charge.hasDebit && charge.quota === BigInt(0) && (!charge.hasFailure || !cost)) continue;

        const modelKey = labels.modelKey?.(charge.model, charge.group) ?? charge.model;
        let model = models.get(modelKey);
        if (!model) {
            model = { totals: empty(), channels: new Map() };
            models.set(modelKey, model);
        }
        const group = labels.groupLabel?.(charge.group, charge.channel) ?? charge.group;
        if (onCharge) {
            onCharge(modelKey, charge.channel, group, {
                id: charge.id,
                time: charge.time,
                references: charge.references,
                netCny: cny(charge.quota).toFixed(),
                costCny: cost ? decimal(cost.amount).times(cost.cny_per_unit).toFixed() : null,
                status: cost?.status === 'verified' || cost?.status === 'estimated' ? cost.status : 'pending',
            });
        }
        const channelKey = JSON.stringify([charge.channel, group]);
        let channel = model.channels.get(channelKey);
        if (!channel) {
            channel = { totals: empty(), id: charge.channel, name: charge.channelName, group };
            model.channels.set(channelKey, channel);
        }
        add(summary, charge, cost);
        add(model.totals, charge, cost);
        add(channel.totals, charge, cost);
    }

    return {
        summary: totals(summary),
        models: [...models.entries()]
            .map(([model, row]) => ({
                model,
                name: active.get(model) ?? model,
                ...totals(row.totals),
                channels: [...row.channels.values()]
                    .map(({ id, name, group, totals: bucket }) => ({ id, name, group, ...totals(bucket) }))
                    .sort(marginRanking),
            }))
            .sort(marginRanking),
    };
}
