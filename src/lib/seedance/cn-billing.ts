/**
 * seedance-cn 视频【按 token 量端到端自扣】计费。
 *
 * 背景:new-api 对视频任务不读上游 usage、且换 task-id / 不给适配器客户身份,所以精确按 token
 * (含参考视频输入视频时长)只能由 /v1 代理绕过 new-api 直连上游、自己扣费。本文件是钱敏感核心:
 * 费率表 + 成本计算 + 幂等双账本扣费(portal ¥ 账本 / newapi quota override)。
 *
 * 费率(元/1M token,= 火山官方挂牌 × 0.85 零售;上游给我们 0.75 → ~13.3% 毛利):
 *   无视频输入(文生/图生/首尾帧/多图):720p ¥46 / 1080p ¥51 / 4k ¥26  ×0.85
 *   含视频输入(参考视频,输入视频时长也计 token → 上游更便宜档):720p ¥28 / 1080p ¥31 / 4k ¥16 ×0.85
 * 实际 token 数 = 上游 usage.completion_tokens(权威);成本 = token/1e6 × 费率。
 */
import { prisma } from '@/lib/db';
import { applyLedgerEntry } from '@/lib/billing/ledger';
import { syncNewapiGate } from '@/lib/billing/newapi-gate';
import { getUser, addQuota } from '@/lib/newapi/client';
import { cnyToQuota } from '@/lib/newapi/quota-units';

export type Resolution = '720p' | '1080p' | '4k';

/** 零售单价(元/1M token):[分辨率][是否含视频输入]。 */
const RETAIL_CNY_PER_M: Record<Resolution, { noVideo: number; withVideo: number }> = {
    '720p': { noVideo: 46 * 0.85, withVideo: 28 * 0.85 }, // 39.1 / 23.8
    '1080p': { noVideo: 51 * 0.85, withVideo: 31 * 0.85 }, // 43.35 / 26.35
    '4k': { noVideo: 26 * 0.85, withVideo: 16 * 0.85 }, // 22.1 / 13.6
};

/** 对客 ¥ = 实际 token / 1e6 × 费率(分辨率 × 是否含视频)。 */
export function computeCostCny(tokens: number | bigint, resolution: Resolution, hasVideo: boolean): number {
    const rate = RETAIL_CNY_PER_M[resolution][hasVideo ? 'withVideo' : 'noVideo'];
    const t = typeof tokens === 'bigint' ? Number(tokens) : tokens;
    return +((t / 1e6) * rate).toFixed(6);
}

/** 每秒 token(公式实测锚点:720p 5s=108872 → 21774/秒,∝像素)。仅用于【提交时余额预估】,
 *  实际扣费用轮询回来的真 usage.completion_tokens。 */
const TOK_PER_SEC: Record<Resolution, number> = { '720p': 21774, '1080p': 48992, '4k': 195970 };

/** 提交前的成本预估(用于余额门)。参考视频还会加输入视频 token,故预估偏低 —— 加 1.5× 缓冲。 */
export function estimateCostCny(resolution: Resolution, duration: number, hasVideo: boolean): number {
    const tokens = TOK_PER_SEC[resolution] * Math.max(1, duration || 5);
    const base = computeCostCny(tokens, resolution, hasVideo);
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

    const costCny = computeCostCny(task.tokens, task.resolution as Resolution, task.has_video);

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
