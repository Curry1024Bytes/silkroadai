/**
 * Kling 视频【时长计费】—— 价表 + 成本计算 + 幂等双账本扣费(钱敏感,镜像 seedance/cn-billing)。
 *
 * 费率口径(2026-08-10 operator 拍板):**对客价 = 上游官方原价(划线价)**,我们拿 7.5 折
 * 成本价,毛利 25%。价表按 模型 × 分辨率档 × 有声/无声 × 是否含参考视频 定 ¥/秒,
 * 总价 = 单价 × duration(秒),提交时即算定落库(上游时长计费无事后 usage 修正)。
 *
 * 上游价表(token.xinhankr.com 定价页截图,2026-08-10)映射说明:
 *  - 「标准」= 720p,「专业」= 1080p(kling 官方档位命名)
 *  - kling-3.0-turbo 无 有声/含视频 差价(上游未列 → 对上游也不加价,收同价安全)
 *  - kling-v3 无 2k 档(上游未挂牌)→ 该组合直接 400,不猜价
 *  - kling-v3-omni 4k 有声挂牌(¥2/¥2.4)低于同档无声(¥3),疑上游标价笔误 →
 *    取 max(有声, 无声) 防倒挂漏收(宁可多收有声档,不冒成本倒挂风险)
 */
import { prisma } from '@/lib/db';
import { applyLedgerEntry } from '@/lib/billing/ledger';
import { syncNewapiGate } from '@/lib/billing/newapi-gate';
import { getUser, addQuota } from '@/lib/newapi/client';
import { cnyToQuota } from '@/lib/newapi/quota-units';

export type KlingResolution = '720p' | '1080p' | '2k' | '4k';

/** 每秒 ¥(官方原价):[无视频无声, 无视频有声, 含视频无声, 含视频有声]。 */
type RateRow = readonly [number, number, number, number];

const RATE_TABLE: Record<string, Partial<Record<KlingResolution, RateRow>>> = {
    'kling-3.0-turbo': {
        // 上游只按分辨率挂牌(720p ¥0.8 / 1080p ¥1 / 2K ¥1.2 / 4K ¥1.44),无声/视频差价
        '720p': [0.8, 0.8, 0.8, 0.8],
        '1080p': [1, 1, 1, 1],
        '2k': [1.2, 1.2, 1.2, 1.2],
        '4k': [1.44, 1.44, 1.44, 1.44],
    },
    'kling-v3': {
        // 挂牌:标准 ¥0.6/有声 ¥0.9;专业 ¥0.8/¥1.2;4k ¥3(有声同价)。无 2k 档、无含视频档(收同价)
        '720p': [0.6, 0.9, 0.6, 0.9],
        '1080p': [0.8, 1.2, 0.8, 1.2],
        '4k': [3, 3, 3, 3],
    },
    'kling-video-o1': {
        // 挂牌只分 含视频/无视频(无有声差价):标准 ¥0.6/¥0.9;专业 ¥0.8/¥1.2;2k ¥1.2/¥1.8;4k ¥1.8/¥2.7
        '720p': [0.6, 0.6, 0.9, 0.9],
        '1080p': [0.8, 0.8, 1.2, 1.2],
        '2k': [1.2, 1.2, 1.8, 1.8],
        '4k': [1.8, 1.8, 2.7, 2.7],
    },
    'kling-v3-omni': {
        // 全维度挂牌;4k 有声取 max 防倒挂(见文件头)
        '720p': [0.6, 0.9, 0.8, 1.1],
        '1080p': [0.8, 1.2, 1, 1.4],
        '2k': [1, 1.5, 1.2, 1.8],
        '4k': [3, 3, 3, 3],
    },
};

/** 是否 kling 视频模型(proxy 分流用)。 */
export function isKlingVideoModel(model: string): boolean {
    return model in RATE_TABLE;
}

/** 归一分辨率:标准/专业别名 + 大小写;未知返 null(fail closed,由调用方 400)。 */
export function normalizeKlingResolution(raw: unknown): KlingResolution | null {
    const s = String(raw ?? '720p')
        .trim()
        .toLowerCase();
    if (s === '' || s === '720p' || s === 'std' || s === 'standard') return '720p';
    if (s === '1080p' || s === 'pro' || s === 'professional') return '1080p';
    if (s === '2k') return '2k';
    if (s === '4k') return '4k';
    return null;
}

/** 每秒单价 ¥;该模型没有此分辨率档(如 kling-v3 2k)→ null(fail closed)。 */
export function klingRatePerSecond(
    model: string,
    resolution: KlingResolution,
    generateAudio: boolean,
    hasVideo: boolean,
): number | null {
    const row = RATE_TABLE[model]?.[resolution];
    if (!row) return null;
    const idx = (hasVideo ? 2 : 0) + (generateAudio ? 1 : 0);
    return row[idx];
}

/** 总价 ¥ = 单价 × 秒数(提交时算定,即最终扣费额)。 */
export function computeKlingCostCny(
    model: string,
    resolution: KlingResolution,
    generateAudio: boolean,
    hasVideo: boolean,
    duration: number,
): number | null {
    const rate = klingRatePerSecond(model, resolution, generateAudio, hasVideo);
    if (rate == null) return null;
    return +(rate * duration).toFixed(6);
}

export interface KlingChargeResult {
    outcome: 'charged' | 'already_billed' | 'skipped' | 'deduct_failed';
    costCny?: number;
}

/**
 * 轮询完成时扣费 —— 幂等、双账本安全(与 chargeSeedanceVideoTask 同构):
 *  1. 原子 CAS 抢占 billed=false → true,并发轮询只有一个能扣;
 *  2. 按 billing_mode 扣款(portal:applyLedgerEntry charge,ref=taskId 二级幂等 + syncNewapiGate;
 *     newapi:读当前 quota → override 到 max(0,current-Δ) + 清缓存)。
 *  ⚠️ 第 2 步失败:billed 保持 true(极少见漏收,人工对账),【绝不回滚重扣】——
 *     newapi override 非幂等,重扣会双倍。安全优先于漏收。
 * 扣费额 = 提交时落库的 cost_cny(价表调整不影响在途任务)。
 */
export async function chargeKlingVideoTask(taskId: string): Promise<KlingChargeResult> {
    const task = await prisma.klingVideoTask.findUnique({ where: { id: taskId } });
    if (!task) return { outcome: 'skipped' };
    if (task.billed) return { outcome: 'already_billed' };
    if (task.cost_cny == null) return { outcome: 'skipped' };
    const costCny = Number(task.cost_cny);
    if (!(costCny > 0)) return { outcome: 'skipped' };

    // 1) 原子抢占:并发轮询只有一个 count=1
    const claim = await prisma.klingVideoTask.updateMany({
        where: { id: taskId, billed: false },
        data: { billed: true, billed_at: new Date() },
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
                console.warn('[kling-billing] syncNewapiGate failed', e);
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
        console.error('[kling-billing] deduct FAILED (billed 已置 true,漏收待人工对账)', {
            taskId,
            costCny,
            err: e instanceof Error ? e.message : String(e),
        });
        return { outcome: 'deduct_failed', costCny };
    }
}
