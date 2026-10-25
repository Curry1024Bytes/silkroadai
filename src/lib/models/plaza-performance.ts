import 'server-only';
import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import type { BrowserCatalog } from './catalog-browser-types';

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}
function finite(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
}
function metrics(raw: unknown) {
    const row = record(raw);
    if (!row || !finite(row.avg_latency_ms) || !finite(row.avg_tps) || !finite(row.success_rate, 100)) return null;
    return { avg_latency_ms: row.avg_latency_ms, avg_tps: row.avg_tps, success_rate: row.success_rate };
}
function series(raw: unknown) {
    return (Array.isArray(raw) ? raw : []).flatMap((value) => {
        const row = record(value);
        const measured = metrics(row);
        return row && measured && finite(row.ts) && finite(row.avg_ttft_ms)
            ? [{ ...measured, ts: row.ts, avg_ttft_ms: row.avg_ttft_ms }]
            : [];
    });
}
function successSeries(raw: unknown) {
    return (Array.isArray(raw) ? raw : []).flatMap((value) => {
        const row = record(value);
        return row && finite(row.ts) && finite(row.success_rate, 100)
            ? [{ ts: row.ts, success_rate: row.success_rate }]
            : [];
    });
}
function windowFields(data: JsonRecord) {
    return {
        ...(finite(data.window_start) ? { window_start: data.window_start } : {}),
        ...(finite(data.window_end) ? { window_end: data.window_end } : {}),
    };
}

/** Read only: do not call listEnabledChannelGroups, which can reconcile/write upstream groups. */
export async function loadPlazaPerformanceGroups(catalog: BrowserCatalog) {
    const rows = await prisma.channelGroup.findMany({
        where: { enabled: true, tenant_id: PLATFORM_TENANT_ID },
        select: { key: true, newapi_group: true },
    });
    const byKey = new Map(catalog.tiers.map((tier) => [tier.key, tier]));
    const mapping = new Map<string, { key: string; label: string }>();
    for (const row of rows) {
        const tier = byKey.get(row.key);
        if (!tier) continue;
        if (mapping.has(row.newapi_group)) throw new Error('Ambiguous model performance group');
        mapping.set(row.newapi_group, { key: tier.key, label: tier.label });
    }
    return mapping;
}

export function filterPlazaPerformance(
    raw: unknown,
    model: BrowserCatalog['models'][number],
    groups: Map<string, { key: string; label: string }>,
) {
    const envelope = record(raw);
    const data = record(envelope?.data);
    if (envelope?.success !== true || !data || data.model_name !== model.slug || !Array.isArray(data.groups))
        throw new Error('Invalid model performance response');
    const filtered = data.groups.flatMap((value) => {
        const row = record(value);
        const group = row && typeof row.group === 'string' ? groups.get(row.group) : undefined;
        const measured = metrics(row);
        return row && group && Object.hasOwn(model.pricesByTier, group.key) && measured && finite(row.avg_ttft_ms)
            ? [{ group: group.label, ...measured, avg_ttft_ms: row.avg_ttft_ms, series: series(row.series) }]
            : [];
    });
    // An aggregate that contains excluded groups must not be attributed to the visible groups.
    const complete = filtered.length > 0 && filtered.length === data.groups.length;
    return {
        success: true,
        data: {
            model_name: model.slug,
            groups: filtered,
            ...windowFields(data),
            ...(complete ? { summary: metrics(data.summary), series: series(data.series) } : {}),
        },
    };
}

/** These are explicitly model-wide measurements, never a claim about the selected tariff. */
export function filterPlazaPerformanceSummary(raw: unknown, visible: Set<string>) {
    const envelope = record(raw);
    const data = record(envelope?.data);
    if (envelope?.success !== true || !data || !Array.isArray(data.models))
        throw new Error('Invalid performance summary');
    const models = data.models.flatMap((value) => {
        const row = record(value);
        const measured = metrics(row);
        return row && typeof row.model_name === 'string' && visible.has(row.model_name) && measured
            ? [
                  {
                      model_name: row.model_name,
                      ...measured,
                      ...(finite(row.request_count) ? { request_count: row.request_count } : {}),
                  },
              ]
            : [];
    });
    const recent = record(data.recent_success_series) ?? {};
    return {
        success: true,
        data: {
            models,
            ...windowFields(data),
            recent_success_series: Object.fromEntries(
                Object.entries(recent)
                    .filter(([name]) => visible.has(name))
                    .map(([name, values]) => [name, successSeries(values)]),
            ),
        },
    };
}
