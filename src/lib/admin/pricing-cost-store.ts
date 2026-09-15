import 'server-only';
import type { Prisma, PricingCostRule } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ChannelGroupTopology, type TopologyGroup, type UpstreamMapLike } from '@/lib/channel-group-topology';
import type { AdminPrincipal } from './auth';
import { tenantScope } from './tenant-scope';
import { assertPricingCatalogWritable, PricingPublishError } from './pricing-publish-lock';
import { pricingCostConfigSchema, calculateCostPricing } from './pricing-cost';
import type { StoredPricingCostRule } from './pricing-cost-types';

export const costRuleSaveSchema = z
    .object({
        model_id: z.string().uuid(),
        tier: z.string().trim().min(1).max(200),
        expected_revision: z.number().int().positive().max(2_147_483_646).nullable(),
        config: pricingCostConfigSchema,
    })
    .strict();
export const costRuleBulkSchema = z.object({ rules: z.array(costRuleSaveSchema).min(1).max(30) }).strict();
export type CostRuleSave = z.infer<typeof costRuleSaveSchema>;
export type CostDb = Pick<Prisma.TransactionClient, 'catalogModel' | 'channelGroup' | 'pricingCostRule'>;
export type CostModel = {
    id: string;
    tenant_id: string | null;
    enabled: boolean;
    modality: string;
    slug: string;
    upstream_map: unknown;
};
export type CostGroup = TopologyGroup & { tenant_id: string | null };

/** Only an explicit, valid current model/tier/channel association can own a cost quote. */
export function costMapping(model: CostModel, tier: string, groups: CostGroup[]) {
    try {
        if (
            !model.enabled ||
            !model.upstream_map ||
            typeof model.upstream_map !== 'object' ||
            Array.isArray(model.upstream_map)
        )
            throw new Error();
        const raw = model.upstream_map as UpstreamMapLike;
        for (const entry of Object.values(raw)) {
            if (
                !entry ||
                !Number.isSafeInteger(entry.channel_id) ||
                entry.channel_id <= 0 ||
                typeof entry.upstream_model !== 'string' ||
                !entry.upstream_model.trim()
            )
                throw new Error();
        }
        const topology = new ChannelGroupTopology(
            model.tenant_id ?? '',
            groups.filter((group) => group.tenant_id === model.tenant_id && group.enabled),
        );
        if (topology.validateUpstreamMap(raw).length || !raw[tier]) throw new Error();
        return raw[tier];
    } catch {
        throw new PricingPublishError(
            'pricing_cost_mapping_invalid',
            '模型或档次已停用，或渠道归属有变化。请先核对模型与渠道分组。',
        );
    }
}

export function publicCostRule(rule: PricingCostRule, model: CostModel, groups: CostGroup[]): StoredPricingCostRule {
    let mapping_current = false;
    try {
        const mapping = costMapping(model, rule.tier, groups);
        mapping_current = mapping.channel_id === rule.channel_id && mapping.upstream_model === rule.upstream_model;
    } catch {
        /* Retain the quote for reference, never silently rebind it. */
    }
    return {
        id: rule.id,
        model_id: rule.model_id,
        tier: rule.tier,
        channel_id: rule.channel_id,
        upstream_model: rule.upstream_model,
        revision: rule.revision,
        config: pricingCostConfigSchema.parse(rule.config),
        updated_at: rule.updated_at.toISOString(),
        mapping_current,
    };
}

export async function listCostRules(admin: AdminPrincipal) {
    const [rules, groups] = await Promise.all([
        prisma.pricingCostRule.findMany({
            where: { model: tenantScope(admin) },
            include: { model: true },
            orderBy: { updated_at: 'desc' },
        }),
        prisma.channelGroup.findMany({ where: tenantScope(admin) }),
    ]);
    return rules.map((rule) => publicCostRule(rule, rule.model, groups));
}

/** The caller transaction also owns the publication coordinator row lock. */
export async function saveCostRulesInTransaction(
    tx: Prisma.TransactionClient,
    inputs: CostRuleSave[],
    admin: AdminPrincipal,
) {
    if (
        !inputs.length ||
        inputs.length > 30 ||
        new Set(inputs.map((input) => `${input.model_id}\0${input.tier}`)).size !== inputs.length
    ) {
        throw new PricingPublishError('pricing_cost_duplicate', '每批最多 30 条，且同一模型与档次只能出现一次。', 400);
    }
    await assertPricingCatalogWritable(tx);
    const groups = await tx.channelGroup.findMany({ where: tenantScope(admin) });
    const saved: StoredPricingCostRule[] = [];
    for (const candidate of inputs) {
        const input = costRuleSaveSchema.parse(candidate);
        calculateCostPricing(input.config); // Validate calculated range before storing a quote.
        const model = await tx.catalogModel.findFirst({ where: { id: input.model_id, ...tenantScope(admin) } });
        if (!model) throw new PricingPublishError('model_not_found', '模型不存在。', 404);
        const expectedBasis = model.modality === 'video' ? 'video' : model.modality === 'image' ? 'image' : 'token';
        if (input.config.basis !== expectedBasis)
            throw new PricingPublishError('pricing_cost_basis', '成本计量方式与该模型类型不一致。', 400);
        const mapping = costMapping(model, input.tier, groups);
        const existing = await tx.pricingCostRule.findUnique({
            where: { model_id_tier: { model_id: input.model_id, tier: input.tier } },
        });
        if ((existing?.revision ?? null) !== input.expected_revision)
            throw new PricingPublishError(
                'pricing_cost_revision',
                '成本资料已被更新，请刷新后再保存，避免覆盖其他修改。',
            );
        const data = {
            channel_id: mapping.channel_id,
            upstream_model: mapping.upstream_model,
            config: input.config as Prisma.InputJsonValue,
            updated_by: admin.user?.id ?? null,
        };
        const rule = existing
            ? await tx.pricingCostRule.update({
                  where: { id: existing.id },
                  data: { ...data, revision: { increment: 1 } },
              })
            : await tx.pricingCostRule.create({
                  data: { ...data, model_id: model.id, tier: input.tier, created_by: admin.user?.id ?? null },
              });
        await tx.pricingCostRuleRevision.create({
            data: {
                rule_id: rule.id,
                revision: rule.revision,
                channel_id: rule.channel_id,
                upstream_model: rule.upstream_model,
                config: rule.config as Prisma.InputJsonValue,
                created_by: admin.user?.id ?? null,
            },
        });
        saved.push(publicCostRule(rule, model, groups));
    }
    return saved;
}

export function saveCostRules(inputs: CostRuleSave[], admin: AdminPrincipal) {
    return prisma.$transaction((tx) => saveCostRulesInTransaction(tx, inputs, admin), { timeout: 30_000 });
}
