/**
 * seedance-cn 视频【按 token 量端到端自扣】计费。
 *
 * 背景:new-api 对视频任务不读上游 usage、且换 task-id / 不给适配器客户身份,所以精确按 token
 * (含参考视频输入视频时长)只能由 /v1 代理绕过 new-api 直连上游、自己扣费。本文件是钱敏感核心:
 * 费率表 + 成本计算 + 幂等双账本扣费(portal ¥ 账本 / newapi quota override)。
 *
 * 费率口径(2026-08-07 重锚,operator 拍板方案 B):**表里存火山官方挂牌价**,
 * 折扣显式外乘,不再烘焙进表 —— 此前表存零售价(挂牌×0.85),企业门户又乘一次
 * 客户 discount,导致「后台设 0.9」实为 0.765 的折上折。现在:
 *   - seedance-cn 渠道(chargeSeedanceVideoTask):官方价 × RETAIL_RATIO(0.85)= 零售,价格不变
 *   - 企业门户(enterprise/billing):官方价 × 客户 discount(discount 即「相对官方价」的折扣率,
 *     标准零售 = 0.85,迁移已把原 discount=1 的行改写为 0.85 → 实付不变)
 * 官方挂牌(元/1M token):无视频 720p ¥46 / 1080p ¥51 / 4k ¥26;含视频 ¥28 / ¥31 / ¥16。
 *   seedance 2.5(国内版新代):720p 无视频 ¥70/含视频 ¥42;1080p ¥77/¥46(2026-09-07 调价,原 90/54)。
 * 实际 token 数 = 上游 usage.completion_tokens(权威);成本 = token/1e6 × 费率。
 */
import { prisma } from '@/lib/db';
import { applyLedgerEntry } from '@/lib/billing/ledger';
import { syncNewapiGate } from '@/lib/billing/newapi-gate';
import { getOption, getUser, addQuota } from '@/lib/newapi/client';
import { cnyToQuota } from '@/lib/newapi/quota-units';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { loadChannelGroupTopology } from '@/lib/channel-group-topology';
import type { Prisma } from '@prisma/client';
import { lockPricingPublisherReadOnly } from '@/lib/admin/pricing-publish-lock';
import { parseCatalogBillingDetails } from '@/lib/models/catalog-pricing-details';
import { scalePricingAmount } from '@/lib/models/tiered-pricing-details';
import { VIDEO_TOKEN_COMBOS, videoTokenKey } from '@/lib/admin/pricing-video-token-expression';

export type { Resolution } from './official-rates';
export type { SeedanceVariant } from './cn-adapter';
import { variantForModel, type SeedanceVariant } from './cn-adapter';
import { OFFICIAL_CNY_PER_M, type Resolution } from './official-rates';

/** 标准零售折扣率:seedance-cn 渠道对客价 = 官方挂牌 × 本比例(operator 定 85 折)。
 *  企业门户【不】用它 —— 那边按客户 discount 显式乘(见 enterprise/billing)。 */
export const RETAIL_RATIO = 0.85;

export type SeedancePricingSnapshot = {
    rate: number;
    discount: number;
    source: 'model';
    timezone: string;
    rule: Prisma.InputJsonValue;
};

function parseGroupRatios(raw: string | null): Record<string, number> {
    if (!raw) throw new Error('GroupRatio unavailable');
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error('GroupRatio is invalid JSON');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GroupRatio is invalid');
    const result: Record<string, number> = {};
    for (const [key, ratio] of Object.entries(value as Record<string, unknown>)) {
        if (typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0) result[key] = ratio;
    }
    return result;
}

/** Resolve the live Portal video-token quote used by new Seedance-cn tasks. */
export async function getSeedancePricingSnapshot(
    model: string,
    tier: string,
    resolution: Resolution,
    hasVideo: boolean,
    tenantId: string | null = null,
    userId: string | null = null,
): Promise<SeedancePricingSnapshot> {
    const resolvedTenant = tenantId ?? PLATFORM_TENANT_ID;
    return prisma.$transaction(
        async (tx) => {
            await lockPricingPublisherReadOnly(tx);
            const [models, topology] = await Promise.all([
                tx.catalogModel.findMany({
                    where: { tenant_id: resolvedTenant, slug: model, enabled: true, modality: 'video' },
                    select: { id: true, slug: true, upstream_map: true },
                }),
                loadChannelGroupTopology(resolvedTenant, tx),
            ]);
            if (models.length !== 1) throw new Error(`Seedance pricing model mapping is ambiguous: ${model}`);
            const group = topology.byTier.get(tier);
            if (!group) throw new Error(`Seedance pricing tier is unavailable: ${tier}`);
            const modelRow = models[0];
            const map = modelRow.upstream_map;
            if (!map || typeof map !== 'object' || Array.isArray(map))
                throw new Error('Seedance upstream mapping is invalid');
            const mapping = (map as Record<string, unknown>)[tier];
            if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping))
                throw new Error(`Seedance upstream mapping missing tier: ${tier}`);
            const channelId = Number((mapping as Record<string, unknown>).channel_id);
            const upstreamModel = String((mapping as Record<string, unknown>).upstream_model || '');
            if (!Number.isInteger(channelId) || !upstreamModel) throw new Error('Seedance upstream mapping is invalid');
            const topologyIssues = topology.validateUpstreamMap({
                [tier]: { channel_id: channelId, upstream_model: upstreamModel },
            });
            if (topologyIssues.length > 0)
                throw new Error(`Seedance upstream mapping is invalid: ${JSON.stringify(topologyIssues)}`);
            const price = await tx.catalogPrice.findFirst({
                where: { model_id: modelRow.id, tier, effective_from: { lte: new Date() } },
                orderBy: { effective_from: 'desc' },
                select: { id: true, effective_from: true, billing_details: true },
            });
            if (!price) throw new Error(`Seedance catalog price unavailable: ${model}/${tier}`);
            const details = parseCatalogBillingDetails(price.billing_details);
            if (
                !details ||
                details.mode !== 'video_token' ||
                details.scheduled_discount ||
                details.cells.length !== VIDEO_TOKEN_COMBOS.length ||
                details.cells.map(videoTokenKey).join('\u0000') !== VIDEO_TOKEN_COMBOS.map(videoTokenKey).join('\u0000')
            )
                throw new Error(
                    'Seedance video-token catalog price is incomplete or uses unsupported scheduled pricing',
                );
            const cell = details.cells.find(
                (entry) => entry.resolution === resolution && entry.video_input === (hasVideo ? 'video' : 'none'),
            );
            if (!cell || !(cell.price > 0) || !Number.isFinite(cell.price))
                throw new Error('Seedance video-token catalog price cell is invalid');

            let customerScale = 1;
            let customerMultiplier: number | null = null;
            let publicGroupRatio: number | null = null;
            if (userId) {
                const overrides = await tx.userTierMultiplier.findMany({
                    where: { user_id: userId, tier_key: tier, enabled: true },
                    select: { newapi_billing_group: true, multiplier: true },
                });
                if (overrides.length > 1) throw new Error(`Seedance customer pricing is ambiguous: ${model}/${tier}`);
                if (overrides.length === 1) {
                    const override = overrides[0];
                    if (override.newapi_billing_group !== group.newapi_group)
                        throw new Error('Seedance customer pricing group no longer matches the active tier');
                    const rawRatios = await getOption('GroupRatio', true);
                    const ratios = parseGroupRatios(rawRatios);
                    publicGroupRatio = ratios[group.newapi_group] ?? null;
                    customerMultiplier = Number(override.multiplier);
                    if (
                        publicGroupRatio === null ||
                        !(publicGroupRatio > 0) ||
                        !Number.isFinite(customerMultiplier) ||
                        customerMultiplier < 0
                    )
                        throw new Error('Seedance customer pricing multiplier is invalid');
                    customerScale = customerMultiplier / publicGroupRatio;
                    scalePricingAmount(0, customerScale);
                }
            }
            const actualRate = scalePricingAmount(cell.price, customerScale);
            if (!(actualRate > 0) || !Number.isFinite(actualRate)) throw new Error('Seedance catalog price is invalid');
            const timezone = 'Asia/Shanghai';
            const evaluatedAt = new Date().toISOString();
            return {
                // CatalogPrice is already the public customer quote. Apply a dedicated customer
                // multiplier only as a ratio against the public GroupRatio, exactly as the model
                // browser does; settlement must never apply a second discount.
                rate: actualRate,
                discount: 1,
                source: 'model',
                timezone,
                rule: {
                    type: 'model',
                    source: 'model',
                    timezone,
                    identity: { model, tier, resolution, hasVideo },
                    basis: { currency: 'CNY', unit: 'token', unitQuantity: 1_000_000, rate: actualRate },
                    catalog_price_id: price.id,
                    catalog_price_effective_from: price.effective_from.toISOString(),
                    public_rate: cell.price,
                    customer_multiplier: customerMultiplier,
                    public_group_ratio: publicGroupRatio,
                    customer_scale: customerScale,
                    evaluatedAt,
                },
            };
        },
        { timeout: 30_000, maxWait: 5_000 },
    );
}

export function snapshotCostCny(tokens: number | bigint, snapshot: SeedancePricingSnapshot): number {
    const value = typeof tokens === 'bigint' ? Number(tokens) : tokens;
    return +((value / 1_000_000) * snapshot.rate * snapshot.discount).toFixed(6);
}

/** 提交余额门使用已冻结的 live 价格，保留含参考视频的 1.5× 安全缓冲。 */
export function estimateCostCnyFromSnapshot(
    snapshot: SeedancePricingSnapshot,
    resolution: Resolution,
    duration: number,
    hasVideo: boolean,
): number {
    const base = snapshotCostCny(estimateTokens(resolution, duration), snapshot);
    return hasVideo ? +(base * 1.5).toFixed(6) : base;
}

function snapshotFromTask(task: {
    model: string;
    tier: string;
    resolution: string;
    has_video: boolean;
    pricing_discount: unknown;
    pricing_source: unknown;
    pricing_rule: unknown;
    pricing_timezone: unknown;
}): SeedancePricingSnapshot | null {
    const fields = [task.pricing_discount, task.pricing_source, task.pricing_rule, task.pricing_timezone];
    if (fields.every((value) => value == null)) return null;
    if (fields.some((value) => value == null)) throw new Error('Incomplete Seedance pricing snapshot');
    const rule = task.pricing_rule;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule))
        throw new Error('Invalid Seedance pricing snapshot rule');
    const basis = (rule as Record<string, unknown>).basis;
    const rate =
        basis && typeof basis === 'object' && !Array.isArray(basis)
            ? Number((basis as Record<string, unknown>).rate)
            : Number.NaN;
    const discount = Number(task.pricing_discount);
    if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(discount) || discount <= 0 || discount > 2)
        throw new Error('Invalid Seedance pricing snapshot amount');
    if (task.pricing_source !== 'model' || typeof task.pricing_timezone !== 'string' || !task.pricing_timezone)
        throw new Error('Invalid Seedance pricing snapshot metadata');
    const identity = (rule as Record<string, unknown>).identity;
    if (!identity || typeof identity !== 'object' || Array.isArray(identity))
        throw new Error('Missing Seedance pricing snapshot identity');
    const expected = { model: task.model, tier: task.tier, resolution: task.resolution, hasVideo: task.has_video };
    if (
        (identity as Record<string, unknown>).model !== expected.model ||
        (identity as Record<string, unknown>).tier !== expected.tier ||
        (identity as Record<string, unknown>).resolution !== expected.resolution ||
        (identity as Record<string, unknown>).hasVideo !== expected.hasVideo
    )
        throw new Error('Seedance pricing snapshot identity mismatch');
    return {
        rate,
        discount,
        source: 'model',
        timezone: task.pricing_timezone,
        rule: rule as Prisma.InputJsonValue,
    };
}

/** 官方挂牌价成本 ¥ = token / 1e6 × 官方单价(变体 × 分辨率 × 是否含视频)。
 *  是计费与展示的单一基准:seedance-cn 再乘 RETAIL_RATIO,企业门户再乘客户 discount。
 *  variant 缺省 pro(兼容存量调用/历史任务行);该变体没有的分辨率档回落 pro 档(防漏收)。 */
export function officialCostCny(
    tokens: number | bigint,
    resolution: Resolution,
    hasVideo: boolean,
    variant: SeedanceVariant = 'pro',
): number {
    const rate = (OFFICIAL_CNY_PER_M[variant][resolution] ?? OFFICIAL_CNY_PER_M.pro[resolution]!)[
        hasVideo ? 'withVideo' : 'noVideo'
    ];
    const t = typeof tokens === 'bigint' ? Number(tokens) : tokens;
    return +((t / 1e6) * rate).toFixed(6);
}

/** seedance-cn 渠道对客 ¥ = 官方价 × 标准零售折扣(0.85)。企业门户不走这里。 */
export function computeCostCny(
    tokens: number | bigint,
    resolution: Resolution,
    hasVideo: boolean,
    variant: SeedanceVariant = 'pro',
): number {
    return +(officialCostCny(tokens, resolution, hasVideo, variant) * RETAIL_RATIO).toFixed(6);
}

/** 每秒 token(公式实测锚点:720p 5s=108872 → 21774/秒,480p 5s=50638 → 10128/秒,∝像素)。仅用于【提交时余额预估】,
 *  实际扣费用轮询回来的真 usage.completion_tokens。 */
const TOK_PER_SEC: Record<Resolution, number> = { '480p': 10128, '720p': 21774, '1080p': 48992, '4k': 195970 };

/** 估算 token 数(预估用;独立门户 enterprise/billing 也复用同一锚点)。 */
export function estimateTokens(resolution: Resolution, duration: number): number {
    return TOK_PER_SEC[resolution] * Math.max(1, duration || 5);
}

/** 提交前的成本预估(用于余额门)。参考视频还会加输入视频 token,故预估偏低 —— 加 1.5× 缓冲。 */
export function estimateCostCny(
    resolution: Resolution,
    duration: number,
    hasVideo: boolean,
    variant: SeedanceVariant = 'pro',
): number {
    const base = computeCostCny(estimateTokens(resolution, duration), resolution, hasVideo, variant);
    return hasVideo ? +(base * 1.5).toFixed(6) : base;
}

export interface ChargeResult {
    outcome: 'charged' | 'already_billed' | 'skipped' | 'deduct_failed';
    costCny?: number;
}

/**
 * 轮询完成时对该视频任务扣费 —— 幂等、双账本安全。
 *  1. 先原子 CAS 抢占 billed=false → true(+ 记 cost_cny),并发轮询只有一个能扣;
 *  2. 再按 billing_mode 扣款(portal:applyLedgerEntry charge,ref=taskId 二级幂等 + syncNewapiGate;
 *     newapi:读当前 quota → override 到 max(0,current-Δ) + 清缓存)。
 *  ⚠️ 若第 2 步失败:billed 保持 true(极少见的漏收,可人工对账),【绝不回滚重扣】——
 *     因为 newapi override 非幂等,重扣会双倍。安全优先于漏收。
 * tokens 必须已写入任务(轮询完成时由调用方先写)。
 */
export async function chargeSeedanceVideoTask(taskId: string): Promise<ChargeResult> {
    const task = await prisma.seedanceVideoTask.findUnique({ where: { id: taskId } });
    if (!task) return { outcome: 'skipped' };
    if (task.billed) return { outcome: 'already_billed' };
    if (task.tokens == null || Number(task.tokens) <= 0) return { outcome: 'skipped' };

    const frozen = snapshotFromTask(task);
    const costCny = frozen
        ? snapshotCostCny(task.tokens, frozen)
        : computeCostCny(task.tokens, task.resolution as Resolution, task.has_video, variantForModel(task.model));

    // 1) 原子抢占:并发轮询只有一个 count=1
    const claim = await prisma.seedanceVideoTask.updateMany({
        where: { id: taskId, billed: false },
        data: { billed: true, cost_cny: costCny, billed_at: new Date() },
    });
    if (claim.count === 0) return { outcome: 'already_billed' };

    // 2) 扣款(抢占后;失败不回滚 billed,防 newapi override 双扣)
    try {
        const user = await prisma.user.findUnique({
            where: { id: task.user_id },
            select: { id: true, tenant_id: true, billing_mode: true, newapi_user_id: true },
        });
        if (!user) throw new Error(`user ${task.user_id} not found`);

        if (user.billing_mode === 'portal') {
            await applyLedgerEntry(user.id, {
                kind: 'charge',
                amount_cny: -costCny, // 负数 = 扣;(kind,ref) 幂等
                ref: taskId,
                note: `${task.model}`,
                tenantId: user.tenant_id,
            });
            try {
                await syncNewapiGate(user.id); // 余额可能跨 0 → 哑门开/关
            } catch (e) {
                console.warn('[seedance-cn-billing] syncNewapiGate failed', e);
            }
        } else {
            // newapi 账本:override 到 max(0, current - Δ)(add 不收负;override 才能减)
            if (user.newapi_user_id == null) throw new Error(`user ${task.user_id} has no newapi_user_id`);
            const current = (await getUser(user.newapi_user_id)).quota;
            const next = Math.max(0, current - cnyToQuota(costCny));
            await addQuota({ userId: user.newapi_user_id, quotaDelta: next, mode: 'override' });
            // 清 quota 缓存(否则 /dashboard 余额 ≤60s 陈旧)
            await prisma.user.update({
                where: { id: user.id },
                data: { newapi_quota_cache: null, newapi_used_quota_cache: null, newapi_cached_at: null },
            });
        }
        return { outcome: 'charged', costCny };
    } catch (e) {
        console.error('[seedance-cn-billing] deduct FAILED (billed 已置 true,漏收待人工对账)', {
            taskId,
            costCny,
            err: e instanceof Error ? e.message : String(e),
        });
        return { outcome: 'deduct_failed', costCny };
    }
}
