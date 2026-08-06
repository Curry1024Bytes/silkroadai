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
 * 实际 token 数 = 上游 usage.completion_tokens(权威);成本 = token/1e6 × 费率。
 */
import { prisma } from '@/lib/db';
import { applyLedgerEntry } from '@/lib/billing/ledger';
import { syncNewapiGate } from '@/lib/billing/newapi-gate';
import { getUser, addQuota } from '@/lib/newapi/client';
import { cnyToQuota } from '@/lib/newapi/quota-units';

export type Resolution = '480p' | '720p' | '1080p' | '4k';
export type { SeedanceVariant } from './cn-adapter';
import { variantForModel, type SeedanceVariant } from './cn-adapter';

/** 【火山官方挂牌价】(元/1M token):[变体][分辨率][是否含视频输入]。上游给我们 0.75。
 *  2026-07-19 加 fast/mini;2026-08-03 全变体加 480p(上游挂牌 480p 与 720p 统一价,
 *  见 artsdance/dreamina 定价页 —— token 量 ∝ 像素,480p 整条约为 720p 的一半价)。
 *  ⚠️ 此表【不含任何折扣】;零售/客户折扣由调用方显式乘(见文件头口径说明)。 */
const OFFICIAL_CNY_PER_M: Record<
    SeedanceVariant,
    Partial<Record<Resolution, { noVideo: number; withVideo: number }>>
> = {
    pro: {
        '480p': { noVideo: 46, withVideo: 28 }, // 官方挂牌(与 720p 同费率)
        '720p': { noVideo: 46, withVideo: 28 }, // 官方挂牌
        '1080p': { noVideo: 51, withVideo: 31 }, // 官方挂牌
        '4k': { noVideo: 26, withVideo: 16 }, // 官方挂牌
    },
    fast: {
        '480p': { noVideo: 37, withVideo: 22 }, // 官方挂牌(与 720p 同费率)
        '720p': { noVideo: 37, withVideo: 22 }, // 官方挂牌
        '1080p': { noVideo: 37, withVideo: 22 }, // 官方挂牌
    },
    mini: {
        '480p': { noVideo: 23, withVideo: 14 }, // 官方挂牌(与 720p 同费率)
        '720p': { noVideo: 23, withVideo: 14 }, // 官方挂牌
        '1080p': { noVideo: 23, withVideo: 14 }, // 官方挂牌
    },
    // 海外版proMax(2026-07-23,dreamina 系):dreamina 官方挂牌(上游对我们 9 折)。
    promax: {
        '480p': { noVideo: 68, withVideo: 40.8 }, // 官方挂牌(与 720p 同费率)
        '720p': { noVideo: 68, withVideo: 40.8 }, // 官方挂牌
        '1080p': { noVideo: 73.44, withVideo: 44.88 }, // 官方挂牌
        '4k': { noVideo: 38.08, withVideo: 23.12 }, // 官方挂牌
    },
    'promax-fast': {
        '480p': { noVideo: 54.4, withVideo: 32.896 }, // 官方挂牌(与 720p 同费率)
        '720p': { noVideo: 54.4, withVideo: 32.896 }, // 官方挂牌
    },
    'promax-mini': {
        '480p': { noVideo: 34, withVideo: 20.4 }, // 官方挂牌(与 720p 同费率)
        '720p': { noVideo: 34, withVideo: 20.4 }, // 官方挂牌
    },
};

/** 标准零售折扣率:seedance-cn 渠道对客价 = 官方挂牌 × 本比例(operator 定 85 折)。
 *  企业门户【不】用它 —— 那边按客户 discount 显式乘(见 enterprise/billing)。 */
export const RETAIL_RATIO = 0.85;

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

    const costCny = computeCostCny(
        task.tokens,
        task.resolution as Resolution,
        task.has_video,
        variantForModel(task.model),
    );

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
