import 'server-only';
import type { AdminPrincipal } from './auth';
import { tenantScope } from './tenant-scope';
import { prisma } from '@/lib/db';
import { readPublishState, readPublishSource } from './pricing-publish';
import { buildPublishPlan, dictionary, type PublishState, type PublishSource } from './pricing-publish-plan';
import { readSyncPrice } from '@/lib/newapi/catalog-sync-prices';
import { costMapping } from './pricing-cost-store';
import type { PricingCostCapability } from './pricing-cost-types';
import { PricingPublishError } from './pricing-publish-lock';
import { isTieredInput, tieredProbeInput } from './pricing-tiered-plan';

import { parseTieredPricingExpression } from './pricing-tiered-expression';
import { buildCacheUniformPublishPlan } from './pricing-uniform-plan';

export function costCapabilities(state: PublishState, source: PublishSource | null): PricingCostCapability[] {
    return state.models.flatMap((model) => {
        if (
            !model.enabled ||
            !model.upstream_map ||
            typeof model.upstream_map !== 'object' ||
            Array.isArray(model.upstream_map)
        )
            return [];
        return Object.keys(model.upstream_map).map((tier): PricingCostCapability => {
            const base: PricingCostCapability = {
                model_id: model.id,
                tier,
                basis: model.modality === 'video' ? 'video' : model.modality === 'image' ? 'image' : 'token',
                resolution: /^gpt-image-2-(1k|2k|4k)$/.exec(model.slug)?.[1] ?? null,
                publishable: false,
                reason: null,
            };
            try {
                const mapping = costMapping(model, tier, state.groups);
                if (base.basis === 'video')
                    throw new PricingPublishError(
                        'pricing_video_unsupported',
                        '可保存规格成本和按秒试算；当前发布器尚不能核验视频实际计费，暂不能发布。',
                    );
                if (!source)
                    throw new PricingPublishError(
                        'pricing_source_unavailable',
                        '暂未读到 new-api 计费配置。成本仍可保存，恢复连接后重新预览。',
                    );
                const probe = {
                    model_id: model.id,
                    tier,
                    input_cny_per_1m: 1,
                    output_cny_per_1m: 1,
                    per_image_cny: null,
                    cost_cny_per_1m: null,
                };
                if (isTieredInput(state, source, probe)) {
                    const probe = tieredProbeInput(state, source, model.id, tier);
                    const expression = dictionary(
                        source.options['billing_setting.billing_expr'],
                        'billing_setting.billing_expr',
                    )[mapping.upstream_model];
                    if (typeof expression !== 'string')
                        throw new PricingPublishError('pricing_tiered_invalid', '未读到模型计费公式。');
                    const required = [
                        ...new Set(
                            parseTieredPricingExpression(expression).tiers.flatMap((row) =>
                                (['cache_read', 'cache_write', 'cache_write_1h'] as const).filter(
                                    (key) => row.rates[key] !== null,
                                ),
                            ),
                        ),
                    ];
                    // This checks capabilities, not an operator quote. Missing first-band
                    // cache categories receive a probe-only zero; real quotes are required by V5.
                    for (const key of required)
                        if (probe[`${key}_cny_per_1m`] === undefined) probe[`${key}_cny_per_1m`] = 0;
                    buildCacheUniformPublishPlan(state, source, [probe], Date.now());
                    return {
                        ...base,
                        publication_mode: 'uniform_token',
                        required_token_rates: required,
                        publishable: true,
                    };
                }
                const group = state.groups.find(
                    (row) => row.tenant_id === model.tenant_id && row.key === tier && row.enabled,
                )!;
                const current = readSyncPrice(
                    {
                        modelRatio: source.options.ModelRatio,
                        completionRatio: source.options.CompletionRatio,
                        modelPrice: source.options.ModelPrice,
                        groupRatio: source.options.GroupRatio,
                    },
                    mapping.upstream_model,
                    group.newapi_group,
                );
                if (!current.price)
                    throw new PricingPublishError(
                        'pricing_source_invalid',
                        current.reason ?? '尚未配置可核验的计费价格。',
                    );
                buildPublishPlan(
                    state,
                    source,
                    {
                        model_id: model.id,
                        tier,
                        ...current.price,
                        cost_cny_per_1m: null,
                        ...(base.resolution ? { pricing_mode: 'fixed_image' as const } : {}),
                    },
                    Date.now(),
                );
                return { ...base, publishable: true };
            } catch (error) {
                return {
                    ...base,
                    reason:
                        error instanceof PricingPublishError
                            ? error.message
                            : '当前配置尚不能通过发布核验，请核对模型与渠道。',
                };
            }
        });
    });
}

export async function listCostCapabilities(admin: AdminPrincipal) {
    const state = await readPublishState(prisma);
    const scopedIds = new Set(
        (await prisma.catalogModel.findMany({ where: tenantScope(admin), select: { id: true } })).map(
            (model) => model.id,
        ),
    );
    let source: PublishSource | null = null;
    try {
        source = await readPublishSource();
    } catch {
        /* Draft editing remains available when upstream cannot be read. */
    }
    return {
        capabilities: costCapabilities(state, source).filter((row) => scopedIds.has(row.model_id)),
        source_error: source ? null : '暂未读到 new-api 的实时计费配置；可保存成本，恢复连接后再预览发布。',
    };
}
