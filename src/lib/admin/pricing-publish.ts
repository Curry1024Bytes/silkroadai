import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma, PricingPublishJob as StoredJob } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
    getPricingPublishOptions,
    getPricingRuntimeModels,
    listChannelsForCatalogSync,
    putPricingPublishOption,
} from '@/lib/newapi/client';
import { readPersistedPricingOptions, readPersistedTieredPricingOptions } from '@/lib/newapi/persisted-pricing';
import { replacementChannel } from './channel-replacement';
import { CHAT_FX, IMAGE_FX } from '@/lib/newapi/pricing-sync';
import { QUOTA_PER_USD } from '@/lib/newapi/quota-units';
import type { AdminPrincipal } from './auth';
import { tenantScope } from './tenant-scope';
import { assertNoRetirementJob, lockPricingPublisher, PricingPublishError } from './pricing-publish-lock';
import { beginPricingWrite, acknowledgePricingWrite, readUncertainPricingWrites } from './pricing-publish-journal';
import {
    assertEffectiveCompletion,
    assertRecoverableOptions,
    buildPublishPlan,
    fingerprint,
    optionsAtTarget,
    priceOptions,
    sourceGuard,
    type AnyPublishPlan,
    type PublishBatchPlan,
    buildPublishBatchPlan,
    targetDictionaries,
    type PublishSource,
    type PublishState,
    type WritePriceKey,
    type PublicationWriteKey,
} from './pricing-publish-plan';
import {
    buildTieredPublishPlan,
    isTieredInput,
    tieredModelName,
    tieredPriceOptions,
    assertRecoverableTieredOptions,
    EXPRESSION_KEY,
    type TieredPublishPlan,
} from './pricing-tiered-plan';
import {
    buildUniformPublishPlan,
    buildCacheUniformPublishPlan,
    type UniformPublishPlan,
    type CacheUniformPublishPlan,
} from './pricing-uniform-plan';
import {
    buildGroupPublishPlan,
    groupSourceGuard,
    assertRecoverableGroupOptions,
    assertGroupRuntime,
    type GroupPublishPlan,
} from './pricing-group-plan';
import { assertPricingCostContext, type CostBatchContext } from './pricing-cost-publication-guard';
import type {
    PricingPublishInput,
    PricingPublishJob,
    PricingPublishJobStatus,
    PricingPublishPreview,
} from './pricing-publish-types';

const PREVIEW_TTL = 10 * 60_000;
const MAX_ATTEMPTS = 6;
const amount = z
    .number()
    .finite()
    .nonnegative()
    .max(99_999_999.9999)
    .refine((n) => Math.abs(n - Number(n.toFixed(4))) < 1e-9, '最多四位小数');
export const pricingPublishInputSchema = z
    .object({
        model_id: z.string().uuid(),
        tier: z.string().trim().min(1).max(200),
        input_cny_per_1m: amount.nullable().default(null),
        output_cny_per_1m: amount.nullable().default(null),
        per_image_cny: amount.nullable().default(null),
        cost_cny_per_1m: amount.nullable().default(null),
        pricing_mode: z.enum(['standard', 'fixed_image']).optional(),
        cache_read_cny_per_1m: z
            .number()
            .finite()
            .nonnegative()
            .max(99_999_999.9999)
            .refine((n) => n === Number(n.toFixed(12)), '缓存价最多十二位小数')
            .optional(),
        cache_write_cny_per_1m: z
            .number()
            .finite()
            .nonnegative()
            .max(99_999_999.9999)
            .refine((n) => n === Number(n.toFixed(12)), '缓存价最多十二位小数')
            .optional(),
        cache_write_1h_cny_per_1m: z
            .number()
            .finite()
            .nonnegative()
            .max(99_999_999.9999)
            .refine((n) => n === Number(n.toFixed(12)), '缓存价最多十二位小数')
            .optional(),
    })
    .refine(
        (d) =>
            d.per_image_cny !== null
                ? d.input_cny_per_1m === null && d.output_cny_per_1m === null
                : d.input_cny_per_1m !== null && d.input_cny_per_1m > 0 && d.output_cny_per_1m !== null,
        { message: '请填写完整输入、输出价格，或单独填写按次价格；不能混用计费方式。' },
    );

export type PublishDb = Pick<Prisma.TransactionClient, 'catalogModel' | 'catalogPrice' | 'channelGroup'>;

export async function readPublishState(db: PublishDb): Promise<PublishState> {
    const [models, groups, prices] = await Promise.all([
        db.catalogModel.findMany({
            orderBy: { id: 'asc' },
            select: {
                id: true,
                tenant_id: true,
                slug: true,
                display_name: true,
                modality: true,
                enabled: true,
                upstream_map: true,
                updated_at: true,
            },
        }),
        db.channelGroup.findMany({
            orderBy: { id: 'asc' },
            select: {
                id: true,
                tenant_id: true,
                key: true,
                display_name: true,
                newapi_group: true,
                enabled: true,
                is_default: true,
                tier_level: true,
                newapi_channel_ids: true,
                updated_at: true,
            },
        }),
        db.catalogPrice.findMany({
            orderBy: { id: 'asc' },
            select: {
                id: true,
                model_id: true,
                tier: true,
                effective_from: true,
                input_cny_per_1m: true,
                output_cny_per_1m: true,
                per_image_cny: true,
                cost_cny_per_1m: true,
            },
        }),
    ]);
    const n = (v: unknown) => (v === null ? null : Number(v));
    return {
        models: models.map((row) => ({ ...row, updated_at: row.updated_at.toISOString() })),
        groups: groups.map((row) => ({
            ...row,
            newapi_channel_ids: [...row.newapi_channel_ids].sort((a, b) => a - b),
            updated_at: row.updated_at.toISOString(),
        })),
        prices: prices.map((row) => ({
            ...row,
            effective_from: row.effective_from.toISOString(),
            input_cny_per_1m: n(row.input_cny_per_1m),
            output_cny_per_1m: n(row.output_cny_per_1m),
            per_image_cny: n(row.per_image_cny),
            cost_cny_per_1m: n(row.cost_cny_per_1m),
        })),
    };
}

export async function readPublishSource(): Promise<PublishSource> {
    const [options, rawChannels] = await Promise.all([getPricingPublishOptions(), listChannelsForCatalogSync()]);
    const channels = rawChannels
        .map((raw) => {
            if (typeof raw.group !== 'string' || typeof raw.models !== 'string' || !Number.isInteger(raw.status)) {
                throw new PricingPublishError('pricing_channels_invalid', 'new-api 渠道信息不完整，无法核对影响范围。');
            }
            const row = replacementChannel(raw);
            return {
                id: row.id,
                name: row.name,
                status: row.status!,
                groups: [...row.groups].sort(),
                models: [...row.models].sort(),
            };
        })
        .sort((a, b) => a.id - b.id);
    return { options, channels };
}

function signature(admin: AdminPrincipal, plan: AnyPublishPlan, timestamp: number) {
    const secret = process.env.PORTAL_JWT_SECRET;
    if (!secret) throw new PricingPublishError('pricing_not_configured', '发布预览签名尚未配置。', 503);
    return createHmac('sha256', secret)
        .update(
            fingerprint({
                purpose: `pricing-publication-v${plan.version}`,
                actor: admin.user?.id ?? 'break-glass',
                tenant: admin.tenant_id,
                plan,
                timestamp,
            }),
        )
        .digest('hex');
}

function publicPreview(plan: AnyPublishPlan, token: string, timestamp: number): PricingPublishPreview {
    return {
        preview_token: token,
        expires_at: new Date(timestamp + PREVIEW_TTL).toISOString(),
        upstream_model: plan.upstream_model,
        basis: plan.basis,
        rows: plan.rows.map((row) => ({
            model_id: row.model_id,
            model_name: row.model_name,
            tier: row.tier,
            group: row.group,
            before: row.before,
            after: row.after,
            ...(plan.version === 3 || plan.version === 4 || plan.version === 5 || plan.version === 6
                ? { before_details: row.before_details, after_details: row.after_details }
                : {}),
        })),
        warnings: plan.warnings,
        ...(plan.version !== 1
            ? { batch: { count: plan.inputs.length, upstream_models: plan.upstream_models.map((model) => model.name) } }
            : {}),
        ...(plan.version === 3 || plan.version === 4 || plan.version === 5 || plan.version === 6
            ? {
                  publication_mode:
                      plan.version === 6
                          ? ('group' as const)
                          : plan.version !== 3
                            ? ('uniform_token' as const)
                            : ('tiered_token' as const),
                  unchanged: plan.unchanged,
                  customer_overrides: plan.customer_overrides,
                  ...(plan.version === 6 ? { customer_request_overrides: plan.customer_request_overrides } : {}),
              }
            : {}),
    };
}

async function persistedBaseline(source: PublishSource) {
    const persisted = priceOptions(await readPersistedPricingOptions());
    const live = priceOptions(source.options);
    if (fingerprint(live) !== fingerprint(persisted)) {
        throw new PricingPublishError(
            'pricing_persistence_mismatch',
            'new-api 正在使用的价格与已保存价格不一致，请先核对，尚未提交任何修改。',
        );
    }
    return persisted;
}

async function planForInput(db: PublishDb, input: PricingPublishInput, admin: AdminPrincipal) {
    const found = await db.catalogModel.findFirst({
        where: { id: input.model_id, ...tenantScope(admin) },
        select: { id: true },
    });
    if (!found) throw new PricingPublishError('model_not_found', '模型不存在。', 404);
    const [state, source] = await Promise.all([readPublishState(db), readPublishSource()]);
    await persistedBaseline(source);
    return buildPublishPlan(state, source, input, Date.now());
}

export async function previewPricingPublish(input: PricingPublishInput, admin: AdminPrincipal) {
    if (input.pricing_mode === 'fixed_image')
        throw new PricingPublishError('fixed_sku_price', '固定图片规格请通过成本定价向导预览与发布。');
    const active = await prisma.pricingPublishCoordinator.findUnique({ where: { id: 'newapi' } });
    if (active?.active_job_id)
        throw new PricingPublishError('pricing_publish_busy', '已有价格发布任务，请先处理该任务再预览新价格。');
    const plan = await planForInput(prisma, input, admin);
    const timestamp = Date.now();
    return publicPreview(plan, `${timestamp}.${signature(admin, plan, timestamp)}`, timestamp);
}

export const pricingPublishBatchInputSchema = z.array(pricingPublishInputSchema).min(1).max(30);

async function planForBatch(
    db: Prisma.TransactionClient,
    inputs: PricingPublishInput[],
    admin: AdminPrincipal,
    costContext?: CostBatchContext,
) {
    for (const input of inputs) {
        const found = await db.catalogModel.findFirst({
            where: { id: input.model_id, ...tenantScope(admin) },
            select: { id: true },
        });
        if (!found) throw new PricingPublishError('model_not_found', '模型不存在。', 404);
    }
    if (costContext) await assertPricingCostContext(db, inputs, costContext);
    const [state, source] = await Promise.all([readPublishState(db), readPublishSource()]);
    if (costContext?.group_scope) {
        const names = inputs.map((input) => tieredModelName(state, input));
        const runtime = await getPricingRuntimeModels([...new Set(names)]);
        const plan = buildGroupPublishPlan(state, source, inputs, Date.now(), costContext, runtime);
        const persisted = tieredPriceOptions(await readPersistedTieredPricingOptions());
        if (fingerprint(persisted) !== fingerprint(plan.baseline))
            throw new PricingPublishError('pricing_persistence_mismatch', '实际计费配置与已保存配置不一致，请先核对。');
        return plan;
    }
    if (inputs.some((input) => isTieredInput(state, source, input))) {
        if (inputs.some((input) => input.pricing_mode === 'fixed_image'))
            throw new PricingPublishError('pricing_special_rule', '固定图片规格不能同时使用文本计费公式。');
        if (!costContext)
            throw new PricingPublishError('pricing_tiered_cost_required', '请通过成本定价向导预览客户统一售价后发布。');
        const plan = buildCacheUniformPublishPlan(state, source, inputs, Date.now(), costContext);
        const persisted = tieredPriceOptions(await readPersistedTieredPricingOptions());
        if (fingerprint(persisted) !== fingerprint(plan.baseline))
            throw new PricingPublishError('pricing_persistence_mismatch', '实际计费配置与已保存配置不一致，请先核对。');
        await verifyTieredRuntime(plan, false);
        return plan;
    }
    await persistedBaseline(source);
    return buildPublishBatchPlan(state, source, inputs, Date.now(), costContext);
}

export async function previewPricingBatch(
    inputs: PricingPublishInput[],
    admin: AdminPrincipal,
    context?: CostBatchContext,
) {
    const parsed = pricingPublishBatchInputSchema.safeParse(inputs);
    if (!parsed.success)
        throw new PricingPublishError('pricing_batch_invalid', '每批请选择 1 至 30 个模型档次，并填写合法价格。', 400);
    const active = await prisma.pricingPublishCoordinator.findUnique({ where: { id: 'newapi' } });
    if (active?.active_job_id)
        throw new PricingPublishError('pricing_publish_busy', '已有价格发布任务，请先处理该任务再预览新价格。');
    const plan = await planForBatch(prisma, parsed.data, admin, context);
    const timestamp = Date.now();
    return publicPreview(plan, `${timestamp}.${signature(admin, plan, timestamp)}`, timestamp);
}

/** All inputs share one durable intent, coordinator, source snapshot and confirmation. */
export async function enqueuePricingBatch(
    inputs: PricingPublishInput[],
    token: string,
    admin: AdminPrincipal,
    context?: CostBatchContext,
) {
    const parsed = pricingPublishBatchInputSchema.safeParse(inputs);
    if (!parsed.success)
        throw new PricingPublishError('pricing_batch_invalid', '每批请选择 1 至 30 个模型档次，并填写合法价格。', 400);
    inputs = parsed.data;
    const previewHash = fingerprint({
        version: 2,
        token,
        actor: admin.user?.id ?? 'break-glass',
        tenant: admin.tenant_id,
        inputs,
        ...(context ? { context } : {}),
    });
    return prisma.$transaction(
        async (tx) => {
            const coordinator = await lockPricingPublisher(tx);
            await assertNoRetirementJob(tx);
            const repeated = await tx.pricingPublishJob.findUnique({ where: { preview_hash: previewHash } });
            if (repeated) return publicJob(repeated);
            const { timestamp, digest } = previewTimestamp(token);
            if (coordinator.active_job_id)
                throw new PricingPublishError('pricing_publish_busy', '已有价格发布任务，请先完成核验或安全取消。');
            const plan = await planForBatch(tx, inputs, admin, context);
            const expected = signature(admin, plan, timestamp);
            if (!timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(expected, 'hex')))
                throw new PricingPublishError(
                    'pricing_preview_stale',
                    '成本、价格、渠道或目录已变化，请重新预览后确认。',
                );
            previewTimestamp(token);
            const job = await tx.pricingPublishJob.create({
                data: {
                    tenant_id: plan.tenant_id,
                    requested_by: admin.user?.id ?? null,
                    model_id: inputs[0].model_id,
                    upstream_model: plan.upstream_model,
                    preview_hash: previewHash,
                    plan: plan as unknown as Prisma.InputJsonValue,
                    status: 'queued',
                    message: '已保存整批待发布价格，等待写入与持久化核验；目录价格尚未更新。',
                    next_attempt_at: new Date(),
                },
            });
            await tx.pricingPublishCoordinator.update({ where: { id: 'newapi' }, data: { active_job_id: job.id } });
            return publicJob(job);
        },
        { isolationLevel: 'Serializable', timeout: 120_000, maxWait: 5_000 },
    );
}

export function publicJob(job: StoredJob): PricingPublishJob {
    return {
        id: job.id,
        status: job.status as PricingPublishJobStatus,
        message: job.message,
        attempts: job.attempts,
        upstream_model: job.upstream_model,
        created_at: job.created_at.toISOString(),
        updated_at: job.updated_at.toISOString(),
        next_attempt_at: job.next_attempt_at?.toISOString() ?? null,
    };
}

function previewTimestamp(token: string) {
    const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(token);
    if (!match || Number(match[1]) > Date.now() || Date.now() - Number(match[1]) > PREVIEW_TTL) {
        throw new PricingPublishError('pricing_preview_stale', '预览已过期，请重新预览价格。');
    }
    return { timestamp: Number(match[1]), digest: match[2] };
}

/** This commits the complete immutable intent, without a remote write. */
export async function enqueuePricingPublish(input: PricingPublishInput, token: string, admin: AdminPrincipal) {
    if (input.pricing_mode === 'fixed_image')
        throw new PricingPublishError('fixed_sku_price', '固定图片规格请通过成本定价向导预览与发布。');
    const previewHash = fingerprint({ token, actor: admin.user?.id ?? 'break-glass', tenant: admin.tenant_id, input });
    return prisma.$transaction(
        async (tx) => {
            const coordinator = await lockPricingPublisher(tx);
            await assertNoRetirementJob(tx);
            const repeated = await tx.pricingPublishJob.findUnique({ where: { preview_hash: previewHash } });
            if (repeated) return publicJob(repeated);
            const { timestamp, digest } = previewTimestamp(token);
            if (coordinator.active_job_id)
                throw new PricingPublishError('pricing_publish_busy', '已有价格发布任务，请先完成核验或安全取消。');
            const plan = await planForInput(tx, input, admin);
            const expected = signature(admin, plan, timestamp);
            if (!timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(expected, 'hex'))) {
                throw new PricingPublishError('pricing_preview_stale', '价格、渠道或目录已变化，请重新预览后确认。');
            }
            previewTimestamp(token); // Recheck after potentially slow upstream reads.
            const job = await tx.pricingPublishJob.create({
                data: {
                    tenant_id: plan.tenant_id,
                    requested_by: admin.user?.id ?? null,
                    model_id: input.model_id,
                    upstream_model: plan.upstream_model,
                    preview_hash: previewHash,
                    plan: plan as unknown as Prisma.InputJsonValue,
                    status: 'queued',
                    message: '已保存待发布价格，等待写入与持久化核验；目录价格尚未更新。',
                    next_attempt_at: new Date(),
                },
            });
            await tx.pricingPublishCoordinator.update({ where: { id: 'newapi' }, data: { active_job_id: job.id } });
            return publicJob(job);
        },
        { isolationLevel: 'Serializable', timeout: 120_000, maxWait: 5_000 },
    );
}

function storedBatchValid(plan: PublishBatchPlan, job: StoredJob): boolean {
    if (
        !Array.isArray(plan.rows) ||
        !plan.rows.length ||
        !pricingPublishBatchInputSchema.safeParse(plan.inputs).success ||
        plan.inputs[0].model_id !== job.model_id ||
        !Array.isArray(plan.upstream_models) ||
        !plan.upstream_models.length ||
        plan.upstream_models.length > 30 ||
        plan.upstream_models.some(
            (model) =>
                !model ||
                typeof model.name !== 'string' ||
                !model.name.trim() ||
                !['token', 'request'].includes(model.basis),
        ) ||
        new Set(plan.upstream_models.map((model) => model.name)).size !== plan.upstream_models.length ||
        plan.upstream_models.map((model) => model.name).join(', ') !== job.upstream_model ||
        !plan.target ||
        typeof plan.target !== 'object' ||
        Array.isArray(plan.target)
    )
        return false;
    const expected: PublishBatchPlan['target'] = {};
    for (const model of plan.upstream_models) {
        const keys: WritePriceKey[] = model.basis === 'token' ? ['ModelRatio', 'CompletionRatio'] : ['ModelPrice'];
        for (const key of keys) {
            const value = plan.target[key]?.[model.name];
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
            expected[key] = { ...expected[key], [model.name]: value };
        }
    }
    return (
        fingerprint(expected) === fingerprint(plan.target) &&
        new Set(plan.rows?.map((row) => JSON.stringify([row.model_id, row.tier]))).size === plan.rows?.length
    );
}

function storedPlan(job: StoredJob): AnyPublishPlan {
    const plan = job.plan as unknown as AnyPublishPlan;
    if (plan?.version === 6) {
        if (
            plan.strategy !== 'group' ||
            !pricingPublishBatchInputSchema.safeParse(plan.inputs).success ||
            plan.inputs[0].model_id !== job.model_id ||
            plan.upstream_model !== job.upstream_model ||
            !plan.cost_context?.group_scope ||
            !plan.runtime_baseline ||
            !Array.isArray(plan.rows) ||
            !plan.rows.length ||
            fingerprint(plan.units) !==
                fingerprint({ chat_fx: CHAT_FX, image_fx: IMAGE_FX, quota_per_usd: QUOTA_PER_USD })
        )
            throw new PricingPublishError('pricing_plan_invalid', '整组发布记录不完整，已停止发布。');
        tieredPriceOptions(plan.baseline);
        return plan;
    }
    if (plan?.version === 3 || plan?.version === 4 || plan?.version === 5) {
        if (
            (plan.version !== 3 && plan.strategy !== 'uniform_token') ||
            !pricingPublishBatchInputSchema.safeParse(plan.inputs).success ||
            plan.inputs.length !== 1 ||
            plan.inputs[0].model_id !== job.model_id ||
            plan.upstream_model !== job.upstream_model ||
            !plan.cost_context ||
            !plan.target ||
            Object.keys(plan.target).length !== 1 ||
            !plan.target[EXPRESSION_KEY] ||
            Object.keys(plan.target[EXPRESSION_KEY]).length !== 1 ||
            typeof plan.target[EXPRESSION_KEY][plan.upstream_model] !== 'string' ||
            !Array.isArray(plan.rows) ||
            !plan.rows.length ||
            fingerprint(plan.units) !==
                fingerprint({ chat_fx: CHAT_FX, image_fx: IMAGE_FX, quota_per_usd: QUOTA_PER_USD })
        )
            throw new PricingPublishError('pricing_plan_invalid', '价格发布记录不完整或金额换算已变化，已停止发布。');
        tieredPriceOptions(plan.baseline);
        return plan;
    }
    const validKeys = plan?.basis === 'token' ? ['CompletionRatio', 'ModelRatio'] : ['ModelPrice'];
    if (
        !plan ||
        ![1, 2].includes(plan.version) ||
        plan.upstream_model !== job.upstream_model ||
        (plan.version === 1 ? plan.input?.model_id !== job.model_id : !storedBatchValid(plan, job)) ||
        !['token', 'request'].includes(plan.basis) ||
        !plan.target ||
        (plan.version === 1 &&
            (fingerprint(Object.keys(plan.target).sort()) !== fingerprint(validKeys) ||
                Object.values(plan.target).some(
                    (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0,
                ))) ||
        !Array.isArray(plan.rows) ||
        !plan.rows.length ||
        plan.rows.some(
            (row) =>
                !pricingPublishInputSchema.safeParse({
                    model_id: row.model_id,
                    tier: row.tier,
                    ...row.after,
                    cost_cny_per_1m: row.cost_cny_per_1m,
                }).success,
        )
    ) {
        throw new PricingPublishError('pricing_plan_invalid', '发布记录版本不支持，请联系维护人员核对。');
    }
    if (
        fingerprint(plan.units) !== fingerprint({ chat_fx: CHAT_FX, image_fx: IMAGE_FX, quota_per_usd: QUOTA_PER_USD })
    ) {
        throw new PricingPublishError('pricing_units_changed', '金额换算配置已变化，已停止自动发布。');
    }
    return plan;
}

async function checkedRemote(plan: AnyPublishPlan): Promise<{
    source: PublishSource;
    live: Record<string, Record<string, unknown>>;
    persisted: Record<string, Record<string, unknown>>;
}> {
    // Persisted read is mandatory before any PUT; missing verification can never
    // silently downgrade to a best-effort publication.
    const [source, rawPersisted] = await Promise.all([
        readPublishSource(),
        plan.version === 3 || plan.version === 4 || plan.version === 5 || plan.version === 6
            ? readPersistedTieredPricingOptions()
            : readPersistedPricingOptions(),
    ]);
    const guardSource =
        plan.version === 6
            ? { ...source, options: { ...source.options, GroupRatio: plan.baseline.GroupRatio } }
            : source;
    if ((plan.version === 6 ? groupSourceGuard(guardSource) : sourceGuard(guardSource)) !== plan.source_guard)
        throw new PricingPublishError('pricing_source_changed', 'new-api 渠道、分组或计费规则已变化，已停止自动发布。');
    if (plan.version === 6) {
        const live = tieredPriceOptions(source.options),
            persisted = tieredPriceOptions(rawPersisted);
        assertRecoverableGroupOptions(live, plan);
        assertRecoverableGroupOptions(persisted, plan);
        return { source, live, persisted };
    }
    if (plan.version === 3 || plan.version === 4 || plan.version === 5) {
        const live = tieredPriceOptions(source.options),
            persisted = tieredPriceOptions(rawPersisted);
        assertRecoverableTieredOptions(live, plan);
        assertRecoverableTieredOptions(persisted, plan);
        return { source, live, persisted };
    }
    const live = priceOptions(source.options),
        persisted = priceOptions(rawPersisted);
    assertRecoverableOptions(live, plan);
    assertRecoverableOptions(persisted, plan);
    return { source, live, persisted };
}

async function verifyTieredRuntime(
    plan: TieredPublishPlan | UniformPublishPlan | CacheUniformPublishPlan | GroupPublishPlan,
    target: boolean,
) {
    if (plan.version === 6) {
        const runtime = await getPricingRuntimeModels(plan.upstream_models.map((model) => model.name));
        assertGroupRuntime(runtime, plan, target);
        return;
    }
    const runtime = await getPricingRuntimeModels([plan.upstream_model]);
    const model = runtime.models[0];
    const expression = target
        ? plan.target[EXPRESSION_KEY][plan.upstream_model]
        : plan.baseline[EXPRESSION_KEY][plan.upstream_model];
    if (
        model.billing_mode !== 'tiered_expr' ||
        model.billing_expr !== expression ||
        model.quota_type !== 0 ||
        plan.rows.some(
            (row) =>
                !model.enable_groups.includes(row.group) ||
                runtime.group_ratio[row.group] !== plan.baseline.GroupRatio[row.group],
        )
    ) {
        // Runtime cache propagation is a retryable verification, never a reason
        // to repeat an acknowledged write or prematurely activate catalog prices.
        throw new Error('Tiered runtime pricing has not converged');
    }
}

async function assertNoUncertainWrites(jobId: string) {
    if ((await readUncertainPricingWrites(jobId)).length) {
        throw new PricingPublishError(
            'pricing_write_uncertain',
            '上次改价请求的结束状态尚未确认，已暂停补写与取消。请维护人员确认旧请求结束并完成审计解封后，再继续核验。',
        );
    }
}

function failureUpdate(error: unknown, attempts: number) {
    if (error instanceof PricingPublishError)
        return { status: 'conflict', message: error.message, next_attempt_at: null };
    if (attempts >= MAX_ATTEMPTS)
        return {
            status: 'failed',
            message: '多次核验未完成，已暂停自动重试。部分价格可能已写入；请检查连接后点击继续核验。',
            next_attempt_at: null,
        };
    return {
        status: 'retry_wait',
        message: '连接或写入结果尚未确认，目录价格未更新；稍后先读取两端状态，再决定是否需要补写。',
        next_attempt_at: new Date(Date.now() + Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 300_000)),
    };
}

/** No TTL lease or overlapping workers: database row lock spans the attempt.
 * A crash can roll back this transaction after a remote write; the previously
 * committed intent lets the next process read both sides and resume safely. */
export async function runPricingPublisherOnce(): Promise<PricingPublishJob | null> {
    let attemptedJobId: string | null = null;
    try {
        return await prisma.$transaction(
            async (tx) => {
                const coordinator = await lockPricingPublisher(tx);
                await assertNoRetirementJob(tx);
                const writeDeadline = Date.now() + 90_000;
                if (!coordinator.active_job_id) return null;
                const job = await tx.pricingPublishJob.findUnique({ where: { id: coordinator.active_job_id } });
                if (
                    !job ||
                    !['queued', 'retry_wait'].includes(job.status) ||
                    (job.next_attempt_at && job.next_attempt_at > new Date())
                )
                    return null;
                attemptedJobId = job.id;
                const attempts = job.attempts + 1;
                let plan: AnyPublishPlan;
                try {
                    await assertNoUncertainWrites(job.id);
                    plan = storedPlan(job);
                    const state = await readPublishState(tx);
                    if (fingerprint(state) !== plan.catalog_guard)
                        throw new PricingPublishError(
                            'pricing_catalog_changed',
                            '目录或成本已变化，已停止自动发布，请核对本次影响范围。',
                        );
                    if (plan.version === 3 || plan.version === 4 || plan.version === 5 || plan.version === 6) {
                        const remote = await checkedRemote(plan);
                        const originalSource = {
                            ...remote.source,
                            options: { ...remote.source.options, ...plan.baseline },
                        };
                        const rebuild =
                            plan.version === 5 || plan.version === 6
                                ? buildCacheUniformPublishPlan
                                : plan.version === 4
                                  ? buildUniformPublishPlan
                                  : buildTieredPublishPlan;
                        const rebuilt =
                            plan.version === 6
                                ? buildGroupPublishPlan(
                                      state,
                                      originalSource,
                                      plan.inputs,
                                      Date.now(),
                                      plan.cost_context,
                                      plan.runtime_baseline,
                                  )
                                : rebuild(state, originalSource, plan.inputs, Date.now(), plan.cost_context);
                        if (fingerprint(rebuilt) !== fingerprint(plan))
                            throw new PricingPublishError(
                                'pricing_plan_invalid',
                                '价格发布目标或预览记录不完整，已停止写入。',
                            );
                    }
                    const targets = targetDictionaries(plan);
                    for (const key of Object.keys(targets) as PublicationWriteKey[]) {
                        if (plan.version !== 1 && plan.cost_context)
                            await assertPricingCostContext(tx, plan.inputs, plan.cost_context);
                        const remote = await checkedRemote(plan);
                        if (
                            Object.entries(targets[key]!).every(
                                ([model, value]) =>
                                    remote.live[key][model] === value && remote.persisted[key][model] === value,
                            )
                        )
                            continue;
                        if (plan.version === 6) {
                            const runtime = await getPricingRuntimeModels(
                                plan.upstream_models.map((model) => model.name),
                            );
                            for (const model of runtime.models) {
                                const before = plan.runtime_baseline.models.find(
                                    (item) => item.model_name === model.model_name,
                                );
                                if (
                                    !before ||
                                    model.cache_ratio !== before.cache_ratio ||
                                    model.create_cache_ratio !== before.create_cache_ratio
                                )
                                    throw new PricingPublishError(
                                        'pricing_cache_changed',
                                        '模型缓存倍率已变化，请重新核对整组价格。',
                                    );
                            }
                        }
                        const next = { ...remote.live[key], ...targets[key] };
                        // A transaction may have expired while network reads were slow.
                        // Confirm the lock is still held and leave at least 30s for the
                        // bounded 10s PUT; never continue remote writes after expiry.
                        await tx.pricingPublishCoordinator.update({
                            where: { id: 'newapi', active_job_id: job.id },
                            data: { revision: { increment: 1 } },
                        });
                        if (plan.version !== 1 && plan.cost_context)
                            await assertPricingCostContext(tx, plan.inputs, plan.cost_context);
                        if (Date.now() > writeDeadline) throw new Error('Publication write deadline exceeded');
                        const writeId = await beginPricingWrite(job.id, key, fingerprint(next));
                        await tx.pricingPublishCoordinator.update({
                            where: { id: 'newapi', active_job_id: job.id },
                            data: { revision: { increment: 1 } },
                        });
                        if (Date.now() > writeDeadline)
                            throw new Error('Publication write deadline exceeded after journaling');
                        try {
                            await putPricingPublishOption(key, JSON.stringify(next));
                            await acknowledgePricingWrite(writeId);
                        } catch {
                            throw new PricingPublishError(
                                'pricing_write_uncertain',
                                '改价响应未确认，已暂停自动补写，目录尚未更新。请维护人员确认该请求已经结束后，再继续核验。',
                            );
                        }
                        // An uncertain PUT aborts this attempt. The next attempt reads
                        // first; it never blindly replays a stale full dictionary.
                    }
                    const verified = await checkedRemote(plan);
                    if (!optionsAtTarget(verified.live, plan) || !optionsAtTarget(verified.persisted, plan)) {
                        throw new Error('Publication not yet verified');
                    }
                    assertEffectiveCompletion(verified.source, plan);
                    if (plan.version === 3 || plan.version === 4 || plan.version === 5 || plan.version === 6)
                        await verifyTieredRuntime(plan, true);
                    if (plan.version !== 1 && plan.cost_context)
                        await assertPricingCostContext(tx, plan.inputs, plan.cost_context);
                } catch (error) {
                    // Database errors must roll back *all* catalog rows and the status.
                    // Retrying the durable intent is safe even if upstream already changed.
                    if (
                        error &&
                        typeof error === 'object' &&
                        'code' in error &&
                        typeof error.code === 'string' &&
                        /^P\d{4}$/.test(error.code)
                    )
                        throw error;
                    return publicJob(
                        await tx.pricingPublishJob.update({
                            where: { id: job.id },
                            data: { attempts, ...failureUpdate(error, attempts) },
                        }),
                    );
                }
                // Local publication is deliberately outside the remote-error catch.
                // Any failure here (including unknown driver errors) rolls back every
                // new CatalogPrice row, status, and lock release as one transaction.
                const now = new Date();
                for (const row of plan.rows) {
                    await tx.catalogPrice.create({
                        data: {
                            model_id: row.model_id,
                            tier: row.tier,
                            ...row.after,
                            ...(plan.version === 3 || plan.version === 4 || plan.version === 5 || plan.version === 6
                                ? row.after_details
                                    ? { billing_details: row.after_details as unknown as Prisma.InputJsonValue }
                                    : {}
                                : {}),
                            cost_cny_per_1m: row.cost_cny_per_1m,
                            effective_from: now,
                            created_by: job.requested_by,
                        },
                    });
                }
                const updated = await tx.pricingPublishJob.update({
                    where: { id: job.id },
                    data: {
                        status: 'succeeded',
                        attempts,
                        applied_at: now,
                        next_attempt_at: null,
                        message:
                            plan.version === 3 || plan.version === 4 || plan.version === 5 || plan.version === 6
                                ? plan.version === 6
                                    ? '已生效：所选档次全部模型的实际计费与目录价格已核验，其他分组价格未改动。'
                                    : plan.version !== 3
                                      ? '已生效：客户统一单价、缓存价格与 new-api 实际计费已核验一致，价格不随上下文长度变化。'
                                      : '已生效：new-api 持久配置、运行阶梯公式、缓存价格与 Portal 全部档位已核验一致。'
                                : '已核对 new-api 运行价格、已保存价格及相关分组，所有受影响目录价格已生效。',
                    },
                });
                await tx.pricingPublishCoordinator.update({
                    where: { id: 'newapi' },
                    data: {
                        active_job_id: null,
                        ...(plan.version === 3 || plan.version === 4 || plan.version === 5 || plan.version === 6
                            ? { revision: { increment: 1 } }
                            : {}),
                    },
                });
                return publicJob(updated);
            },
            { isolationLevel: 'Serializable', timeout: 120_000, maxWait: 1_000 },
        );
    } catch (error) {
        if (!attemptedJobId) throw error;
        // The failed catalog transaction is already rolled back. Record a
        // bounded retry in a fresh transaction rather than leaving the UI
        // indefinitely queued; never release the active publication here.
        return prisma.$transaction(
            async (tx) => {
                const coordinator = await lockPricingPublisher(tx);
                await assertNoRetirementJob(tx);
                if (coordinator.active_job_id !== attemptedJobId) return null;
                const job = await tx.pricingPublishJob.findUnique({ where: { id: attemptedJobId! } });
                if (!job || !['queued', 'retry_wait'].includes(job.status)) return job ? publicJob(job) : null;
                const attempts = job.attempts + 1;
                return publicJob(
                    await tx.pricingPublishJob.update({
                        where: { id: job.id },
                        data: {
                            attempts,
                            ...failureUpdate(error, attempts),
                            message:
                                attempts >= MAX_ATTEMPTS
                                    ? '目录保存多次未完成，已暂停自动处理；发布记录与改价日志已保留，请维护人员检查数据库后继续核验。'
                                    : '目录保存未完成，本次目录改动已回滚；将读取持久改价日志和 new-api 状态后恢复核验。',
                        },
                    }),
                );
            },
            { isolationLevel: 'Serializable', timeout: 15_000, maxWait: 1_000 },
        );
    }
}

export async function changePricingJob(id: string, action: 'retry' | 'cancel', admin: AdminPrincipal) {
    return prisma.$transaction(
        async (tx) => {
            const coordinator = await lockPricingPublisher(tx);
            await assertNoRetirementJob(tx);
            const job = await tx.pricingPublishJob.findFirst({ where: { id, ...tenantScope(admin) } });
            if (!job) throw new PricingPublishError('pricing_job_not_found', '发布任务不存在。', 404);
            if (['succeeded', 'cancelled'].includes(job.status)) return publicJob(job);
            if (coordinator.active_job_id !== job.id)
                throw new PricingPublishError('pricing_job_conflict', '该任务未持有发布锁，请联系维护人员。');
            if (action === 'retry') {
                // Respect ambiguity backoff even when the button is clicked twice.
                const nextAttempt =
                    job.next_attempt_at && job.next_attempt_at > new Date() ? job.next_attempt_at : new Date();
                return publicJob(
                    await tx.pricingPublishJob.update({
                        where: { id },
                        data: {
                            status: 'queued',
                            attempts: 0,
                            next_attempt_at: nextAttempt,
                            message: '已安排继续核验，将先读取当前价格，确认后才补写未完成的部分。',
                        },
                    }),
                );
            }
            await assertNoUncertainWrites(job.id);
            const plan = storedPlan(job);
            // Cancellation makes no remote write. Channel/routing drift must not
            // trap an untouched intent forever behind the publication lock.
            const [source, persisted] = await Promise.all([
                readPublishSource(),
                plan.version === 3 || plan.version === 4 || plan.version === 5 || plan.version === 6
                    ? readPersistedTieredPricingOptions()
                    : readPersistedPricingOptions(),
            ]);
            const live: Record<string, Record<string, unknown>> = plan.version === 3 ||
            plan.version === 4 ||
            plan.version === 5 ||
            plan.version === 6
                ? tieredPriceOptions(source.options)
                : priceOptions(source.options);
            const saved: Record<string, Record<string, unknown>> = plan.version === 3 ||
            plan.version === 4 ||
            plan.version === 5 ||
            plan.version === 6
                ? tieredPriceOptions(persisted)
                : priceOptions(persisted);
            if (plan.version === 2) {
                assertRecoverableOptions(priceOptions(live), plan);
                assertRecoverableOptions(priceOptions(saved), plan);
            }
            for (const [key, values] of Object.entries(targetDictionaries(plan))) {
                if (
                    Object.keys(values).some(
                        (model) =>
                            live[key][model] !==
                                (plan.baseline as Record<string, Record<string, unknown>>)[key][model] ||
                            saved[key][model] !==
                                (plan.baseline as Record<string, Record<string, unknown>>)[key][model],
                    )
                ) {
                    throw new PricingPublishError(
                        'pricing_cancel_unsafe',
                        '部分价格已经变化，不能直接取消。请继续核验；如存在其他改价，请先由维护人员核对并恢复原值后再取消。',
                    );
                }
            }
            const updated = await tx.pricingPublishJob.update({
                where: { id },
                data: {
                    status: 'cancelled',
                    message: '已确认 new-api 仍为原价，本次待发布价格已取消。',
                    next_attempt_at: null,
                },
            });
            await tx.pricingPublishCoordinator.update({ where: { id: 'newapi' }, data: { active_job_id: null } });
            return publicJob(updated);
        },
        { isolationLevel: 'Serializable', timeout: 120_000, maxWait: 5_000 },
    );
}

export async function listPricingJobs(admin: AdminPrincipal) {
    const jobs = await prisma.pricingPublishJob.findMany({
        where: tenantScope(admin),
        orderBy: { created_at: 'desc' },
        take: 30,
    });
    return jobs.map(publicJob);
}

export function pricingPublishErrorResponse(error: unknown): {
    body: { error: string; message: string };
    status: number;
} {
    if (error instanceof PricingPublishError)
        return { body: { error: error.code, message: error.message }, status: error.status };
    if (error && typeof error === 'object' && 'code' in error && ['P2028', 'P2034'].includes(String(error.code))) {
        return {
            body: { error: 'pricing_publish_busy', message: '价格发布或目录更新正在处理中，请稍后刷新任务状态。' },
            status: 409,
        };
    }
    if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string' &&
        error.code.startsWith('persisted_pricing_')
    ) {
        return {
            body: {
                error: error.code,
                message: '尚不能核对 new-api 已保存的价格。请让维护人员配置并检查价格只读核验连接；当前未发布修改。',
            },
            status: 503,
        };
    }
    return {
        body: {
            error: 'pricing_publish_unavailable',
            message: '价格核验暂不可用，请稍后重试；未确认生效前请查看发布任务状态。',
        },
        status: 503,
    };
}
