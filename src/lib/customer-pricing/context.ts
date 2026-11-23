import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { ChannelGroupTopology } from '@/lib/channel-group-topology';
import { BASE_FX, groupRatioOf, readBasePrice } from '@/lib/admin/pricing-simple-core';
import { pricingCostConfigSchema } from '@/lib/admin/pricing-cost';
import { videoQuoteFromCostConfig } from '@/lib/admin/pricing-video-quote';
import { getPricingPublishOptions, listChannelsForCatalogSync } from '@/lib/newapi/client';
import { parseNestedRatioMap } from '@/lib/pricing-rules/options';
import { internalNewApiUserGroup } from '@/lib/newapi/user-tier-multiplier';
import {
    CustomerPricingError,
    fingerprint,
    flattenBase,
    officialMultiplierOf,
    roundPrice,
    selectOfficialRule,
} from './math';
import type { OfficialCustomerRule, OfficialModelContext, OfficialPriceCell, OfficialPricingView } from './types';

type DB = typeof prisma | Prisma.TransactionClient;
type RecordValue = Record<string, unknown>;
const object = (v: unknown): RecordValue | null =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as RecordValue) : null;
const names = (v: unknown) =>
    typeof v === 'string'
        ? v
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean)
        : [];
const CHANNEL_FINGERPRINT_OMISSIONS = new Set([
    'key',
    'channel_info',
    'balance',
    'used_quota',
    'response_time',
    'test_time',
]);

export interface OfficialContext extends OfficialPricingView {
    user: { id: string; tenant_id: string | null; newapi_user_id: number | null; newapi_access_token: string | null };
    options: Record<string, unknown>;
    channels: Awaited<ReturnType<typeof listChannelsForCatalogSync>>;
    bindings: Awaited<ReturnType<typeof prisma.customerPricingBinding.findMany>>;
    registry: Awaited<ReturnType<typeof prisma.customerModelBillingGroup.findMany>>;
    model_states: Record<string, unknown>;
}

export async function loadOfficialContext(
    userId: string,
    db: DB = prisma,
    overrides: { pricingOptions?: Record<string, unknown> } = {},
): Promise<OfficialContext> {
    const user = await db.user.findUnique({
        where: { id: userId },
        select: { id: true, tenant_id: true, newapi_user_id: true, newapi_access_token: true },
    });
    if (!user) throw new CustomerPricingError('customer_missing', '客户不存在。', 404);
    const tenantId = user.tenant_id ?? PLATFORM_TENANT_ID;
    const [groups, models, references, costRules, storedRules, legacy, bindings, registry, options, channels] =
        await Promise.all([
            db.channelGroup.findMany({
                where: { tenant_id: tenantId, enabled: true },
                orderBy: [{ tier_level: 'asc' }, { key: 'asc' }],
            }),
            db.catalogModel.findMany({
                where: { tenant_id: tenantId, enabled: true },
                orderBy: { id: 'asc' },
                select: { id: true, slug: true, display_name: true, upstream_map: true },
            }),
            db.customerOfficialReference.findMany({ where: { tenant_id: tenantId } }),
            db.pricingCostRule.findMany({
                where: { model: { tenant_id: tenantId, enabled: true } },
                select: {
                    model_id: true,
                    tier: true,
                    channel_id: true,
                    upstream_model: true,
                    revision: true,
                    config: true,
                },
            }),
            db.customerOfficialPriceRule.findMany({
                where: { user_id: userId },
                orderBy: [{ tier_key: 'asc' }, { model_key: 'asc' }],
            }),
            db.userTierMultiplier.findMany({ where: { user_id: userId, enabled: true } }),
            db.customerPricingBinding.findMany({ where: { user_id: userId }, orderBy: { created_at: 'asc' } }),
            db.customerModelBillingGroup.findMany({ where: { tenant_id: tenantId } }),
            overrides.pricingOptions ? Promise.resolve(overrides.pricingOptions) : getPricingPublishOptions(),
            listChannelsForCatalogSync(),
        ]);
    const topology = new ChannelGroupTopology(tenantId, groups);
    const channelById = new Map(channels.map((c) => [c.id, c]));
    const rules: OfficialCustomerRule[] = storedRules.map((r) => ({
        id: r.id,
        tier_key: r.tier_key,
        model_id: r.model_key === '*' ? null : r.model_key,
        official_multiplier: Number(r.official_multiplier),
        revision: r.revision,
    }));
    const matrix = parseNestedRatioMap(options.GroupGroupRatio, 'GroupGroupRatio');
    const userRatios = matrix[internalNewApiUserGroup(userId)] ?? {};
    const modelStates: Record<string, unknown> = {};
    const tiers = groups.map((group) => {
        const groupRatio = groupRatioOf(options, group.newapi_group);
        const publicRatio = groupRatio ?? 0;
        const old = legacy.find((r) => r.tier_key === group.key && r.newapi_billing_group === group.newapi_group);
        const binding = bindings.find((b) => b.tier_key === group.key);
        const rows: OfficialModelContext[] = [];
        for (const model of models) {
            const map = object(model.upstream_map);
            const mapping = object(map?.[group.key]);
            if (!mapping) continue;
            const name = typeof mapping.upstream_model === 'string' ? mapping.upstream_model : '';
            const channelId = Number(mapping.channel_id);
            const row: OfficialModelContext = {
                model_id: model.id,
                model_name: name,
                display_name: model.display_name,
                tier_key: group.key,
                public_group: group.newapi_group,
                public_ratio: publicRatio,
                source_channel_ids: [],
                reference_revision: null,
                reference_source: null,
                reference_available: false,
                unavailable_reason: null,
                shape: '',
                cells: [],
                public_official_multiplier: null,
                current_official_multiplier: null,
                current_ratio: Number(old?.multiplier ?? publicRatio),
                current_ratio_verified: binding?.status !== 'active',
                current_rule_scope: old ? 'legacy' : null,
            };
            try {
                if (
                    !name ||
                    !Number.isSafeInteger(channelId) ||
                    topology.validateUpstreamMap({ [group.key]: { channel_id: channelId, upstream_model: name } })
                        .length
                )
                    throw new CustomerPricingError('invalid_topology', '模型渠道归属尚未核对。');
                if (publicRatio <= 0) throw new CustomerPricingError('missing_group_ratio', '分组倍率无效。');
                if (model.slug !== name)
                    throw new CustomerPricingError('model_alias', '目录模型名与实际计费模型名不同，请先核对映射。');
                const sources = group.newapi_channel_ids
                    .map((id) => channelById.get(id))
                    .filter(
                        (c) =>
                            c &&
                            c.status === 1 &&
                            names(c.group).includes(group.newapi_group) &&
                            names(c.models).includes(name),
                    );
                row.source_channel_ids = sources.map((c) => c!.id).sort((a, b) => a - b);
                if (!row.source_channel_ids.length)
                    throw new CustomerPricingError('model_unavailable', '该模型没有已启用的来源渠道。');
                // A published native rate can be verified independently of its official reference.
                if (binding?.status === 'active') {
                    const native = registry.find((r) => r.tier_key === group.key && r.model_id === model.id);
                    if (
                        !native ||
                        native.status !== 'active' ||
                        native.model_name !== name ||
                        native.public_group !== group.newapi_group ||
                        !Array.isArray(binding.model_groups) ||
                        !binding.model_groups.includes(native.internal_group) ||
                        !native.replica_channel_ids.length
                    )
                        throw new CustomerPricingError('binding_drift', '客户模型计费分组与已发布绑定无法核对。');
                    const actualRatio = userRatios[native.internal_group];
                    if (typeof actualRatio !== 'number' || !Number.isFinite(actualRatio) || actualRatio <= 0)
                        throw new CustomerPricingError('binding_drift', '客户实际计费倍率与已发布规则无法核对。');
                    row.current_ratio = actualRatio;
                    row.current_ratio_verified = true;
                }
                const base = readBasePrice(options, name);
                if (!base) throw new CustomerPricingError('model_unpriced', 'new-api 未设置模型价格。');
                const flat = flattenBase(base, BASE_FX);
                row.shape = flat.shape;
                modelStates[`${group.key}/${model.id}`] = {
                    base,
                    channels: sources.map((c) => {
                        // A configuration fingerprint must not include live response counters or any secret material.
                        return Object.fromEntries(
                            Object.entries(c!).filter(([key]) => !CHANNEL_FINGERPRINT_OMISSIONS.has(key)),
                        );
                    }),
                };
                const explicit = references.find((r) => r.model_id === model.id && r.tier_key === group.key);
                const costRow = costRules.find(
                    (r) =>
                        r.model_id === model.id &&
                        r.tier === group.key &&
                        r.channel_id === channelId &&
                        r.upstream_model === name,
                );
                const parsedCost = costRow ? pricingCostConfigSchema.safeParse(costRow.config) : null;
                const videoQuote = parsedCost?.success ? videoQuoteFromCostConfig(parsedCost.data, name) : null;
                let reference: Map<string, number> | null = null;
                if (explicit) {
                    if (explicit.shape !== flat.shape)
                        throw new CustomerPricingError(
                            'reference_shape_changed',
                            '当前计费档位与已确认官方基准不同，请重新核对基准。',
                        );
                    const refCells = explicit.cells as unknown;
                    if (!Array.isArray(refCells))
                        throw new CustomerPricingError('reference_invalid', '官方基准格式无效。');
                    reference = new Map(
                        refCells.map((c) => {
                            const rec = object(c);
                            if (
                                !rec ||
                                typeof rec.key !== 'string' ||
                                typeof rec.official_cny !== 'number' ||
                                !Number.isFinite(rec.official_cny) ||
                                rec.official_cny < 0
                            )
                                throw new CustomerPricingError('reference_invalid', '官方基准包含无效金额。');
                            return [rec.key, rec.official_cny];
                        }),
                    );
                    row.reference_revision = `reference:${explicit.id}:${explicit.revision}`;
                    row.reference_source = explicit.source_note;
                } else if (videoQuote && base.mode === 'video_token') {
                    reference = new Map(videoQuote.official.map((c) => [`${c.resolution}·${c.video_input}`, c.price]));
                    row.reference_revision = `video:${costRow!.revision}:${fingerprint(videoQuote.official)}`;
                    row.reference_source = '已保存的视频官方价格矩阵（人民币／百万 token）';
                }
                if (
                    reference &&
                    (reference.size !== flat.cells.length || flat.cells.some((c) => !reference!.has(c.key)))
                )
                    throw new CustomerPricingError('reference_incomplete', '官方基准必须完整覆盖全部计费档位。');
                row.cells = flat.cells.map((c) => {
                    const official = reference?.get(c.key) ?? 0;
                    const costCell = videoQuote?.official.find((v) => `${v.resolution}·${v.video_input}` === c.key);
                    return {
                        key: c.key,
                        label: c.label,
                        unit: c.unit,
                        base_cny: c.amount,
                        public_cny: roundPrice(c.amount * publicRatio),
                        official_cny: official,
                        cost_cny:
                            costCell && videoQuote?.buy_discount != null
                                ? roundPrice(costCell.price * videoQuote.buy_discount)
                                : null,
                    } satisfies OfficialPriceCell;
                });
                row.reference_available = reference !== null;
                row.unavailable_reason = reference
                    ? null
                    : '尚未确认官方基准。请录入官方单价、币种和来源后再设置官方价倍率。';
                row.public_official_multiplier = reference ? officialMultiplierOf(row.cells, publicRatio) : null;
                const own = selectOfficialRule(rules, group.key, model.id);
                if (own) row.current_rule_scope = own.model_id ? 'model' : 'tier';
                row.current_official_multiplier = reference ? officialMultiplierOf(row.cells, row.current_ratio) : null;
                if (binding && binding.status !== 'active')
                    row.unavailable_reason = '该客户定价尚待核验，请先恢复未完成的发布。';
            } catch (error) {
                row.reference_available = false;
                row.unavailable_reason = error instanceof Error ? error.message : '无法核对模型定价。';
            }
            rows.push(row);
        }
        return {
            key: group.key,
            display_name: group.display_name,
            public_group: group.newapi_group,
            public_ratio: publicRatio,
            legacy_multiplier: old ? Number(old.multiplier) : null,
            models: rows,
            binding_status: binding?.status ?? null,
        };
    });
    const version = fingerprint({
        tiers,
        rules,
        modelStates,
        bindings: bindings.map((b) => [b.tier_key, b.status, b.revision]),
        userRatios,
    });
    return { version, tiers, rules, user, options, channels, bindings, registry, model_states: modelStates };
}

/** Never send authentication tokens, complete options, or source channel objects to a browser. */
export function publicOfficialView(context: OfficialContext): OfficialPricingView {
    return { version: context.version, tiers: context.tiers, rules: context.rules };
}
