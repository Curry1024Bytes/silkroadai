/**
 * 独立门户视频计费(P1)—— 纯 portal ¥账本,镜像 cn-billing 的幂等结构但砍掉 newapi 分支:
 * 企业客户没有 new-api 账户(newapi_user_id=null),没有 syncNewapiGate(余额门就在提交时,
 * 见 enterprise/proxy),扣费只有一条路:applyLedgerEntry(charge, ref=taskId) 二级幂等。
 *
 * 费率:默认 = cn-billing 挂牌(决策 Q4);大客户议价走 enterprise_rate_overrides
 * per-(user, resolution, has_video) 覆盖(元/1M token)。
 */
import 'server-only';
import { prisma } from '@/lib/db';
import { applyLedgerEntry } from '@/lib/billing/ledger';
import { officialCostCny, estimateTokens, type ChargeResult, type Resolution } from '@/lib/seedance/cn-billing';
import { variantForModel, regionForModel, type SeedanceVariant, type SeedanceRegion } from '@/lib/seedance/cn-adapter';

/** 企业门户任务在 seedance_video_tasks.tier 里的标记(区分 seedance-cn 渠道任务)。 */
export const ENTERPRISE_TIER = 'enterprise-portal';

/** 客户 per-模型议价折扣(enterprise_model_discounts,按 客户×渠道×模型档)。【优先级最高】。
 *  返回折扣率;无行 / 非法值 → null(回落全局折扣 / 客户整体折扣)。 */
async function modelDiscountFor(
    userId: string,
    variant: SeedanceVariant,
    region: SeedanceRegion,
): Promise<number | null> {
    const row = await prisma.enterpriseModelDiscount.findUnique({
        where: { user_id_region_variant: { user_id: userId, region, variant } },
        select: { discount: true },
    });
    if (!row) return null;
    const d = Number(row.discount);
    return Number.isFinite(d) && d > 0 ? d : null;
}

/** 客户级折扣率(enterprise_upstream_keys.discount,每版本一行 → 国内/海外独立)。
 *  【口径 2026-08-07 重锚】相对【官方挂牌价】:0.85 = 标准零售(默认),0.9 = 官方价九折,
 *  1 = 按官方原价。查失败回 1(宁多收不漏收)。 */
async function customerDiscount(userId: string, region: SeedanceRegion): Promise<number> {
    const row = await prisma.enterpriseUpstreamKey.findUnique({
        where: { user_id_region: { user_id: userId, region } },
        select: { discount: true },
    });
    const d = row ? Number(row.discount) : 1;
    return Number.isFinite(d) && d > 0 ? d : 1;
}

/** 全局折扣(enterprise_global_discounts,按 渠道×模型 的临时促销)。
 *  返回有效折扣率;无行 / 已过期(读时判定)/ 非法值 → null(回落客户折扣)。 */
async function globalDiscountFor(region: SeedanceRegion, variant: SeedanceVariant): Promise<number | null> {
    const row = await prisma.enterpriseGlobalDiscount.findUnique({
        where: { region_variant: { region, variant } },
        select: { discount: true, expires_at: true },
    });
    if (!row) return null;
    if (row.expires_at && row.expires_at.getTime() <= Date.now()) return null; // 到期自动失效
    const d = Number(row.discount);
    return Number.isFinite(d) && d > 0 ? d : null;
}

/** 对客 ¥ 计价优先级(2026-08-11 起,全折扣制三层,取第一个命中):
 *   1. per-模型议价折扣(enterprise_model_discounts 按 客户×渠道×模型)—— 【最高】,客户协议价;
 *   2. 全局折扣(enterprise_global_discounts 按 渠道×模型)—— 促销,覆盖客户整体折扣,按模型隔离;
 *   3. 客户整体折扣(enterprise_upstream_keys.discount)—— 缺省。
 *  实付 = 官方挂牌价 × 生效折扣。三层都按 (渠道×模型) 隔离,不影响其它模型。海外挂牌价 = 国内(operator 拍板)。 */
export async function computeEnterpriseCostCny(
    userId: string,
    tokens: number | bigint,
    resolution: Resolution,
    hasVideo: boolean,
    variant: SeedanceVariant = 'pro',
    region: SeedanceRegion = 'cn',
): Promise<number> {
    const [modelDisc, globalDisc, customerDisc] = await Promise.all([
        modelDiscountFor(userId, variant, region),
        globalDiscountFor(region, variant),
        customerDiscount(userId, region),
    ]);
    const t = typeof tokens === 'bigint' ? Number(tokens) : tokens;
    // per-模型议价 > 全局折扣 > 客户整体折扣(取第一个非空)
    const discount = modelDisc ?? globalDisc ?? customerDisc;
    return +(officialCostCny(t, resolution, hasVideo, variant) * discount).toFixed(6);
}

/** 提交前成本预估(余额门)。含视频 1.5× 缓冲,同 cn-billing 语义。 */
export async function estimateEnterpriseCostCny(
    userId: string,
    resolution: Resolution,
    duration: number,
    hasVideo: boolean,
    variant: SeedanceVariant = 'pro',
    region: SeedanceRegion = 'cn',
): Promise<number> {
    const base = await computeEnterpriseCostCny(
        userId,
        estimateTokens(resolution, duration),
        resolution,
        hasVideo,
        variant,
        region,
    );
    return hasVideo ? +(base * 1.5).toFixed(6) : base;
}

/**
 * 轮询完成时扣费 —— 幂等:①CAS 抢占 billed=false→true(并发轮询只有一个能扣);
 * ②applyLedgerEntry(charge, ref=taskId)((kind,ref) unique 二级幂等)。
 * 扣款失败 billed 保持 true(极少见漏收人工对账,保守语义与 cn-billing 一致,少一条特例)。
 */
export async function chargeEnterpriseVideoTask(taskId: string): Promise<ChargeResult> {
    const task = await prisma.seedanceVideoTask.findUnique({ where: { id: taskId } });
    if (!task) return { outcome: 'skipped' };
    if (task.billed) return { outcome: 'already_billed' };
    if (task.tokens == null || Number(task.tokens) <= 0) return { outcome: 'skipped' };

    const costCny = await computeEnterpriseCostCny(
        task.user_id,
        task.tokens,
        task.resolution as Resolution,
        task.has_video,
        variantForModel(task.model),
        regionForModel(task.model),
    );

    const claim = await prisma.seedanceVideoTask.updateMany({
        where: { id: taskId, billed: false },
        data: { billed: true, cost_cny: costCny, billed_at: new Date() },
    });
    if (claim.count === 0) return { outcome: 'already_billed' };

    try {
        await applyLedgerEntry(task.user_id, {
            kind: 'charge',
            amount_cny: -costCny,
            ref: taskId,
            note: `${task.model}`,
            tenantId: task.tenant_id,
        });
        return { outcome: 'charged', costCny };
    } catch (e) {
        console.error('[enterprise-billing] deduct FAILED (billed 已置 true,漏收待人工对账)', {
            taskId,
            costCny,
            err: e instanceof Error ? e.message : String(e),
        });
        return { outcome: 'deduct_failed', costCny };
    }
}
