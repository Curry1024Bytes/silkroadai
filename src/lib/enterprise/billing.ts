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
import { computeCostCny, estimateTokens, type ChargeResult, type Resolution } from '@/lib/seedance/cn-billing';
import { variantForModel, type SeedanceVariant } from '@/lib/seedance/cn-adapter';

/** 企业门户任务在 seedance_video_tasks.tier 里的标记(区分 seedance-cn 渠道任务)。 */
export const ENTERPRISE_TIER = 'enterprise-portal';

async function rateOverrideCnyPerM(
    userId: string,
    variant: SeedanceVariant,
    resolution: Resolution,
    hasVideo: boolean,
): Promise<number | null> {
    const row = await prisma.enterpriseRateOverride.findUnique({
        where: {
            user_id_variant_resolution_has_video: {
                user_id: userId,
                variant,
                resolution,
                has_video: hasVideo,
            },
        },
        select: { cny_per_m: true },
    });
    return row ? Number(row.cny_per_m) : null;
}

/** 客户级整体折扣率(enterprise_upstream_keys.discount,1 = 无折扣)。查失败回 1(宁多收不漏收)。 */
async function customerDiscount(userId: string): Promise<number> {
    const row = await prisma.enterpriseUpstreamKey.findUnique({
        where: { user_id: userId },
        select: { discount: true },
    });
    const d = row ? Number(row.discount) : 1;
    return Number.isFinite(d) && d > 0 ? d : 1;
}

/** 对客 ¥:议价覆盖(按 变体×分辨率×含视频,绝对单价不再乘折扣)优先;
 *  否则挂牌 × 客户折扣率(默认 1)。 */
export async function computeEnterpriseCostCny(
    userId: string,
    tokens: number | bigint,
    resolution: Resolution,
    hasVideo: boolean,
    variant: SeedanceVariant = 'pro',
): Promise<number> {
    const [override, discount] = await Promise.all([
        rateOverrideCnyPerM(userId, variant, resolution, hasVideo),
        customerDiscount(userId),
    ]);
    const t = typeof tokens === 'bigint' ? Number(tokens) : tokens;
    if (override != null) return +((t / 1e6) * override).toFixed(6);
    return +(computeCostCny(t, resolution, hasVideo, variant) * discount).toFixed(6);
}

/** 提交前成本预估(余额门)。含视频 1.5× 缓冲,同 cn-billing 语义。 */
export async function estimateEnterpriseCostCny(
    userId: string,
    resolution: Resolution,
    duration: number,
    hasVideo: boolean,
    variant: SeedanceVariant = 'pro',
): Promise<number> {
    const base = await computeEnterpriseCostCny(
        userId,
        estimateTokens(resolution, duration),
        resolution,
        hasVideo,
        variant,
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
