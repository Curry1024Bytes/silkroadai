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

/** 企业门户任务在 seedance_video_tasks.tier 里的标记(区分 seedance-cn 渠道任务)。 */
export const ENTERPRISE_TIER = 'enterprise-portal';

async function rateOverrideCnyPerM(userId: string, resolution: Resolution, hasVideo: boolean): Promise<number | null> {
    const row = await prisma.enterpriseRateOverride.findUnique({
        where: { user_id_resolution_has_video: { user_id: userId, resolution, has_video: hasVideo } },
        select: { cny_per_m: true },
    });
    return row ? Number(row.cny_per_m) : null;
}

/** 对客 ¥:议价覆盖优先,否则默认挂牌。 */
export async function computeEnterpriseCostCny(
    userId: string,
    tokens: number | bigint,
    resolution: Resolution,
    hasVideo: boolean,
): Promise<number> {
    const override = await rateOverrideCnyPerM(userId, resolution, hasVideo);
    const t = typeof tokens === 'bigint' ? Number(tokens) : tokens;
    if (override != null) return +((t / 1e6) * override).toFixed(6);
    return computeCostCny(t, resolution, hasVideo);
}

/** 提交前成本预估(余额门)。含视频 1.5× 缓冲,同 cn-billing 语义。 */
export async function estimateEnterpriseCostCny(
    userId: string,
    resolution: Resolution,
    duration: number,
    hasVideo: boolean,
): Promise<number> {
    const base = await computeEnterpriseCostCny(userId, estimateTokens(resolution, duration), resolution, hasVideo);
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
