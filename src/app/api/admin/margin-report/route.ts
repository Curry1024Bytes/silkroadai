import { NextRequest, NextResponse } from 'next/server';
import { resolveAdmin } from '@/lib/admin/auth';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { buildActualMargin, type MarginChargeDetail } from '@/lib/billing/actual-margin';
import { loadMarginEvents, MarginSourceError } from '@/lib/billing/margin-source';
import { prisma } from '@/lib/db';
import { isSdSpecialLegacyModel, sdSpecialPublicModelForSku, SD_SPECIAL_GROUP } from '@/lib/sd-special-video';

export const runtime = 'nodejs';
const day = 86_400;
const tz = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });

function startOfDay(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const millis = Date.parse(value + 'T00:00:00+08:00');
    return Number.isFinite(millis) && tz.format(new Date(millis)) === value ? millis / 1_000 : NaN;
}

export async function GET(request: NextRequest) {
    if (!(await resolveAdmin(request, 'superadmin'))) return unauthorizedResponse(request);
    const params = request.nextUrl.searchParams;
    const today = tz.format(new Date());
    const lastDay = startOfDay(params.get('end') ?? today);
    const start = params.has('start') ? startOfDay(params.get('start') ?? '') : lastDay - 29 * day;
    const end = lastDay + day;
    if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        end - start > 93 * day ||
        start < startOfDay('2026-08-25')
    ) {
        return NextResponse.json({ error: 'invalid_period' }, { status: 400 });
    }

    try {
        const [users, catalog, groupRows, replicas] = await Promise.all([
            prisma.user.findMany({ where: { newapi_user_id: { not: null } }, select: { newapi_user_id: true } }),
            prisma.catalogModel.findMany({
                where: { enabled: true, archived: false },
                select: { slug: true, display_name: true, upstream_map: true },
            }),
            prisma.channelGroup.findMany({
                select: { key: true, newapi_group: true, display_name: true, enabled: true },
            }),
            prisma.customerModelBillingGroup.findMany({
                select: { internal_group: true, public_group: true, replica_channel_ids: true },
            }),
        ]);
        const { events, tasks } = await loadMarginEvents(
            users.flatMap(({ newapi_user_id: id }) => (id == null ? [] : [id])),
            start,
            end,
        );
        const groupNames = new Map(groupRows.map((group) => [group.newapi_group, group.display_name]));
        const groupsByKey = new Map(
            groupRows.filter((group) => group.enabled).map((group) => [group.key, group.newapi_group]),
        );
        const replicaGroups = new Map(
            replicas.flatMap((row) =>
                row.replica_channel_ids.map(
                    (channel) => [JSON.stringify([row.internal_group, channel]), row.public_group] as const,
                ),
            ),
        );

        const activeModels = new Map<string, string>();
        for (const row of catalog) {
            const keys = row.upstream_map && typeof row.upstream_map === 'object' ? Object.keys(row.upstream_map) : [];
            const sdOnly = keys.length > 0 && keys.every((key) => groupsByKey.get(key) === SD_SPECIAL_GROUP);
            const publicModel = sdOnly ? sdSpecialPublicModelForSku(row.slug) : undefined;
            // Suppressed SKUs are listed when historical ledger events exist.
            if (sdOnly && !publicModel && isSdSpecialLegacyModel(row.slug)) continue;
            activeModels.set(publicModel ?? row.slug, publicModel ?? row.display_name);
        }
        const ids = new Set<string>();
        for (const event of events) {
            for (const id of [event.task_id, event.request_id, event.upstream_request_id])
                if (id?.trim()) ids.add(id.trim());
        }
        for (const task of tasks) if (task.upstream_task_id) ids.add(task.upstream_task_id);
        const refs = [...ids];
        const costs = [];
        for (let i = 0; i < refs.length; i += 4_000) {
            costs.push(
                ...(await prisma.upstreamMarginCost.findMany({
                    where: { reference_id: { in: refs.slice(i, i + 4_000) } },
                    select: {
                        channel_id: true,
                        reference_kind: true,
                        reference_id: true,
                        amount: true,
                        status: true,
                        cny_per_unit: true,
                    },
                })),
            );
        }

        const detailModel = params.get('model');
        const detailChannel = Number(params.get('channel'));
        const detailGroup = params.get('group');
        const detailPage = Math.min(Math.max(Number(params.get('page')) || 1, 1), 8_000);
        const detail =
            detailModel &&
            params.has('channel') &&
            Number.isSafeInteger(detailChannel) &&
            detailGroup &&
            Number.isSafeInteger(detailPage);
        const charges: MarginChargeDetail[] = [];
        const report = buildActualMargin(
            events,
            tasks,
            costs,
            start,
            end,
            {
                activeModels: [...activeModels].map(([model, name]) => ({ model, name })),
                modelKey: (model, group) =>
                    group === SD_SPECIAL_GROUP ? (sdSpecialPublicModelForSku(model) ?? model) : model,
                groupLabel: (group, channel) => {
                    const actualGroup = replicaGroups.get(JSON.stringify([group, channel])) ?? group;
                    const display = groupNames.get(actualGroup) ?? actualGroup;
                    return actualGroup === group ? display : display + ' · 客户专属';
                },
            },
            detail
                ? (model, channel, group, charge) => {
                      if (model === detailModel && channel === detailChannel && group === detailGroup)
                          charges.push(charge);
                  }
                : undefined,
        );
        if (detail) {
            const pageSize = 25;
            charges.sort((a, b) => b.time - a.time);
            return NextResponse.json(
                {
                    charges: charges.slice((detailPage - 1) * pageSize, detailPage * pageSize),
                    total: charges.length,
                    pageSize,
                },
                { headers: { 'Cache-Control': 'no-store' } },
            );
        }
        return NextResponse.json(
            { ...report, start: tz.format(new Date(start * 1000)), end: tz.format(new Date(lastDay * 1000)) },
            { headers: { 'Cache-Control': 'no-store' } },
        );
    } catch (error) {
        const reason = error instanceof MarginSourceError ? error.reason : 'report_unavailable';
        return NextResponse.json({ error: reason }, { status: reason === 'range_too_large' ? 422 : 503 });
    }
}
