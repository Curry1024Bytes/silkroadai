import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ChannelGroupTopology, ChannelGroupTopologyError, type UpstreamMapLike } from '@/lib/channel-group-topology';
import type { AdminPrincipal } from './auth';
import { canonicalSync } from './newapi-sync-plan';
import { assertPricingCatalogWritable } from './pricing-publish-lock';
import type { ChannelGroupRetirementSource } from './channel-group-retirement-source';
import type { ChannelGroupRetirementPreview, ChannelGroupRetirementResult } from './channel-group-retirement-types';

export class ChannelGroupRetirementError extends Error {
    constructor(
        public code: string,
        message: string,
        public status = 409,
    ) {
        super(message);
        this.name = 'ChannelGroupRetirementError';
    }
}

const groupSelect = {
    id: true,
    tenant_id: true,
    key: true,
    display_name: true,
    newapi_group: true,
    newapi_channel_ids: true,
    is_default: true,
    enabled: true,
    tier_level: true,
    updated_at: true,
} satisfies Prisma.ChannelGroupSelect;
type RetirementDb = Pick<Prisma.TransactionClient, 'channelGroup' | 'catalogModel' | 'newApiToken'>;
type Selection = { groupId: string; tenantId: string | null; replacementDefaultId?: string | null };

function objectMap(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Builds the entire local transaction plan without modifying rows or issuing network requests. */
export async function buildChannelGroupRetirement(
    db: RetirementDb,
    selection: Selection,
    source: ChannelGroupRetirementSource,
) {
    const { groupId, tenantId } = selection;
    const groups = await db.channelGroup.findMany({
        where: { tenant_id: tenantId },
        select: groupSelect,
        orderBy: { id: 'asc' },
    });
    const group = groups.find((row) => row.id === groupId);
    if (!group) throw new ChannelGroupRetirementError('group_not_found', '渠道分组不存在，请刷新列表。', 404);
    if (group.newapi_group !== source.group_name)
        throw new ChannelGroupRetirementError('preview_stale', '分组名称已变化，请重新预览后确认。');
    const [catalog, keys] = await Promise.all([
        db.catalogModel.findMany({
            where: { tenant_id: tenantId },
            select: { id: true, slug: true, display_name: true, enabled: true, upstream_map: true, updated_at: true },
            orderBy: { id: 'asc' },
        }),
        db.newApiToken.findMany({
            where: { tier: group.key, user: { tenant_id: tenantId } },
            // Never read token values, access credentials, quota cache or alias.
            select: { id: true, user_id: true, newapi_token_id: true, status: true, tier: true },
            orderBy: { id: 'asc' },
        }),
    ]);
    const issues: ChannelGroupRetirementPreview['issues'] = [];
    const remaining = groups.filter((row) => row.id !== group.id && row.enabled);
    const defaultCandidates = remaining.filter((candidate) => {
        try {
            new ChannelGroupTopology(
                tenantId ?? '',
                remaining.map((row) => ({ ...row, is_default: row.id === candidate.id })),
            );
            return true;
        } catch (error) {
            if (!(error instanceof ChannelGroupTopologyError)) throw error;
            return false;
        }
    });
    let replacementDefaultId = selection.replacementDefaultId ?? null;
    if (group.is_default) {
        if (!replacementDefaultId && defaultCandidates.length === 1) replacementDefaultId = defaultCandidates[0].id;
        if (!defaultCandidates.length) {
            issues.push({
                code: 'replacement_default_unavailable',
                message: '这是默认档次，请先准备另一个已启用且渠道归属有效的分组，才能删除。',
            });
        } else if (!replacementDefaultId) {
            issues.push({ code: 'replacement_default_required', message: '请选择删除后的默认档次。' });
        } else if (!defaultCandidates.some((candidate) => candidate.id === replacementDefaultId)) {
            issues.push({ code: 'replacement_default_invalid', message: '所选默认档次已不可用，请重新选择。' });
        }
    } else if (replacementDefaultId) {
        issues.push({
            code: 'replacement_default_unexpected',
            message: '本分组不是默认档次，无需更换默认档。请重新预览。',
        });
    }
    const updates = catalog.flatMap((model) => {
        const map = objectMap(model.upstream_map);
        if (!map || !Object.hasOwn(map, group.key)) return [];
        const nextMap = { ...map };
        delete nextMap[group.key];
        return [{ ...model, nextMap, nextEnabled: model.enabled && Object.keys(nextMap).length > 0 }];
    });
    const nextGroups = remaining.map((row) => ({
        ...row,
        is_default: group.is_default ? row.id === replacementDefaultId : row.is_default,
    }));
    try {
        const topology = new ChannelGroupTopology(tenantId ?? '', nextGroups);
        for (const model of catalog) {
            const update = updates.find((row) => row.id === model.id);
            if (!(update?.nextEnabled ?? model.enabled)) continue;
            const map = objectMap(update?.nextMap ?? model.upstream_map);
            const validEntries =
                map &&
                Object.values(map).every((entry) => {
                    const item = objectMap(entry);
                    return (
                        item &&
                        Number.isSafeInteger(item.channel_id) &&
                        (item.channel_id as number) > 0 &&
                        typeof item.upstream_model === 'string' &&
                        item.upstream_model.trim().length > 0
                    );
                });
            if (!validEntries || topology.validateUpstreamMap(map as UpstreamMapLike).length) {
                issues.push({
                    code: 'invalid_model_mapping',
                    message: `模型「${model.slug}」在其他档次仍有无效映射，请先修正后再删除。`,
                });
            }
        }
    } catch (error) {
        if (!(error instanceof ChannelGroupTopologyError)) throw error;
        if (!issues.some((issue) => issue.code.startsWith('replacement_default_'))) {
            issues.push({
                code: 'invalid_topology',
                message: '删除后须保留一个有效的默认档次，且其他启用分组的渠道归属不能重复。',
            });
        }
    }
    const preview: ChannelGroupRetirementPreview = {
        group: {
            id: group.id,
            key: group.key,
            display_name: group.display_name,
            newapi_group: group.newapi_group,
            is_default: group.is_default,
            enabled: group.enabled,
        },
        models: updates.map((row) => ({
            id: row.id,
            slug: row.slug,
            display_name: row.display_name,
            was_enabled: row.enabled,
            will_disable: row.enabled && !row.nextEnabled,
            remaining_tiers: Object.keys(row.nextMap).sort(),
        })),
        existing_keys: { active: keys.filter((row) => row.status === 'active').length, total: keys.length },
        default_candidates: defaultCandidates.map(({ id, key, display_name }) => ({ id, key, display_name })),
        replacement_default_id: replacementDefaultId,
        upstream: source.upstream,
        issues,
        canApply: issues.length === 0,
        preview_token: '',
    };
    // Identity and status matter, not just counts. Include all tenant groups/models
    // because they establish the final topology; quota refreshes do not invalidate a preview.
    const snapshot = { groupId, tenantId, groups, catalog, keys, replacementDefaultId, source };
    return { preview, group, updates, snapshot };
}

type Plan = Awaited<ReturnType<typeof buildChannelGroupRetirement>>;
export type ChannelGroupRetirementPlan = Plan;
function actor(admin: AdminPrincipal) {
    return { id: admin.user?.id ?? null, tenant: admin.tenant_id, role: admin.role, breakGlass: admin.viaBreakGlass };
}
function digest(value: unknown) {
    // Normalize dates to ISO strings before canonical ordering. Date has no
    // enumerable properties and must not collapse to {} in a state signature.
    return createHash('sha256')
        .update(canonicalSync(JSON.parse(JSON.stringify(value))))
        .digest('hex');
}
function signingSecret() {
    const secret = process.env.PORTAL_JWT_SECRET;
    if (!secret || secret.length < 32)
        throw new ChannelGroupRetirementError(
            'retirement_unavailable',
            '删除预览签名配置不可用，请检查服务配置。',
            503,
        );
    return secret;
}
function sign(encoded: string) {
    return createHmac('sha256', signingSecret()).update(`channel-group-retirement-v1.${encoded}`).digest('base64url');
}
function issueToken(plan: Plan, admin: AdminPrincipal) {
    const payload = Buffer.from(
        JSON.stringify({
            issuedAt: Date.now(),
            actor: digest(actor(admin)),
            state: digest(plan.snapshot),
            groupId: plan.group.id,
            tenantId: plan.group.tenant_id,
        }),
    ).toString('base64url');
    return `${payload}.${sign(payload)}`;
}
function verifyToken(token: string, plan: Plan, admin: AdminPrincipal) {
    const parts = token.split('.');
    const invalid = () => new ChannelGroupRetirementError('preview_invalid', '删除预览无效，请重新预览后确认。', 400);
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) throw invalid();
    const expected = Buffer.from(sign(parts[0]));
    const actual = Buffer.from(parts[1]);
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw invalid();
    let payload: { issuedAt?: unknown; actor?: unknown; state?: unknown; groupId?: unknown; tenantId?: unknown };
    try {
        payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    } catch {
        throw invalid();
    }
    if (
        !payload ||
        typeof payload !== 'object' ||
        payload.actor !== digest(actor(admin)) ||
        payload.groupId !== plan.group.id ||
        payload.tenantId !== plan.group.tenant_id ||
        !Number.isSafeInteger(payload.issuedAt)
    )
        throw invalid();
    const age = Date.now() - (payload.issuedAt as number);
    if (age < 0 || age >= 10 * 60 * 1000)
        throw new ChannelGroupRetirementError('preview_expired', '删除预览已过期，请重新预览后确认。');
    if (payload.state !== digest(plan.snapshot))
        throw new ChannelGroupRetirementError(
            'preview_stale',
            '分组、模型、Key 或 new-api 状态已变化，请重新预览后确认。',
        );
}

export async function previewChannelGroupRetirement(
    selection: Selection,
    source: ChannelGroupRetirementSource,
    admin: AdminPrincipal,
) {
    const plan = await buildChannelGroupRetirement(prisma, selection, source);
    plan.preview.preview_token = issueToken(plan, admin);
    return plan.preview;
}

export async function applyChannelGroupRetirement(
    selection: Selection,
    source: ChannelGroupRetirementSource,
    admin: AdminPrincipal,
    previewToken: string,
): Promise<ChannelGroupRetirementResult> {
    // The caller rereads upstream outside this transaction. No network requests,
    // price/history/cost/key deletion, or new-api mutations occur here.
    return prisma.$transaction(
        async (tx) => {
            await assertPricingCatalogWritable(tx);
            const plan = await buildChannelGroupRetirement(tx, selection, source);
            verifyToken(previewToken, plan, admin);
            if (!plan.preview.canApply)
                throw new ChannelGroupRetirementError('retirement_blocked', plan.preview.issues[0].message);
            return commitChannelGroupRetirement(tx, plan, selection.tenantId);
        },
        { isolationLevel: 'Serializable', timeout: 15000 },
    );
}

/** Internal final step: caller must own the publication mutex and validate its durable job plan. */
export async function commitChannelGroupRetirement(
    tx: Prisma.TransactionClient,
    plan: ChannelGroupRetirementPlan,
    tenantId: string | null,
): Promise<ChannelGroupRetirementResult> {
    for (const model of plan.updates) {
        await tx.catalogModel.update({
            where: { id: model.id, tenant_id: tenantId, updated_at: model.updated_at },
            data: { upstream_map: model.nextMap as Prisma.InputJsonValue, enabled: model.nextEnabled },
        });
    }
    // Delete the old default before enabling its replacement: the partial
    // unique index is immediate, while transaction commit remains atomic.
    await tx.channelGroup.delete({
        where: { id: plan.group.id, tenant_id: tenantId, updated_at: plan.group.updated_at },
    });
    let replacementName: string | null = null;
    if (plan.group.is_default && plan.preview.replacement_default_id) {
        await tx.channelGroup.updateMany({
            where: { tenant_id: tenantId, is_default: true, enabled: true },
            data: { is_default: false },
        });
        const replacement = await tx.channelGroup.update({
            where: { id: plan.preview.replacement_default_id, tenant_id: tenantId, enabled: true },
            data: { is_default: true },
        });
        replacementName = replacement.display_name;
    }
    return {
        group_key: plan.group.key,
        group_name: plan.group.display_name,
        updated_models: plan.updates.length,
        disabled_models: plan.preview.models.filter((row) => row.will_disable).length,
        existing_keys: plan.preview.existing_keys,
        replacement_default_name: replacementName,
    };
}
