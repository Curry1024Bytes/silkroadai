/**
 * 企业任务对账器(2026-07-24)—— 修「排队中卡死 + 漏收」。
 *
 * 背景:计费在客户轮询经过我们时触发(handlePoll)。客户提交后不再轮询,任务行就永远
 * 停在 queued/in_progress 且【不扣费】(实测两条上游已 completed 245,025 token 的任务
 * 漏收 ~¥26)。企业实例不跑定时任务(instrumentation 门),所以做成【页面加载时按需对账】:
 * 客户打开「调用日志/计费流水」或 admin 打开客户详情时,服务端主动向上游轮询该客户的
 * 非终态任务,补写 tokens/status/fail_reason 并走幂等扣费(chargeEnterpriseVideoTask
 * CAS + (charge,ref) 双幂等,重复对账零风险)。
 *
 * 过期终态:上游任务结果只保留 ~48h(execution_expires_after=172800)。超过 48h 仍
 * 非终态、或上游已查不到的老任务 → 标 failed + fail_reason「已过期」,不计费(宁少收
 * 不误收:拿不到权威 usage 就不扣)。
 */
import 'server-only';
import { prisma } from '@/lib/db';
import { pollVideoWithKey, regionForModel } from '@/lib/seedance/cn-adapter';
import { isTerminalTaskFailure, type UpstreamErrorCategory } from '@/lib/seedance/upstream-error';
import { getUpstreamKeyForUser } from './keys';
import { ENTERPRISE_TIER, chargeEnterpriseVideoTask } from './billing';

const STALE_AFTER_MS = 90 * 1000; // 提交 90s 内的任务不管(客户大概率还在正常轮询)
const EXPIRE_AFTER_MS = 48 * 60 * 60 * 1000; // 上游结果保留期
const BATCH_LIMIT = 20; // 单次页面加载最多对账 20 条,防慢页

const EXPIRED_REASON = '任务已过期(上游不再保留结果),未计费';

/** 对账单个客户的滞留任务。best-effort:任何单条失败不影响其余,也不抛给页面。 */
export async function reconcileStaleTasks(userId: string): Promise<void> {
    let stale: Array<{ id: string; model: string; created_at: Date }>;
    try {
        stale = await prisma.seedanceVideoTask.findMany({
            where: {
                user_id: userId,
                tier: ENTERPRISE_TIER,
                status: { in: ['queued', 'in_progress'] },
                created_at: { lt: new Date(Date.now() - STALE_AFTER_MS) },
            },
            orderBy: { created_at: 'asc' },
            take: BATCH_LIMIT,
            select: { id: true, model: true, created_at: true },
        });
    } catch (e) {
        console.warn('[enterprise-reconcile] query failed', e);
        return;
    }
    if (stale.length === 0) return;

    // 上游 key 按 region 缓存(同客户同版本一把)
    const keyCache = new Map<string, string | null>();
    for (const task of stale) {
        try {
            const expired = Date.now() - task.created_at.getTime() > EXPIRE_AFTER_MS;
            const region = regionForModel(task.model);
            let upstreamKey = keyCache.get(region);
            if (upstreamKey === undefined) {
                upstreamKey = await getUpstreamKeyForUser(userId, region);
                keyCache.set(region, upstreamKey);
            }
            if (!upstreamKey) {
                // 该版本上游 key 已被移除:老任务无法回查。超保留期的直接过期终态。
                if (expired) await markExpired(task.id);
                continue;
            }

            const res = await pollVideoWithKey(task.id, `Bearer ${upstreamKey}`, region);
            const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
            if (!res.ok || !j) {
                // 上游用 4xx 表达【任务已废】(TaskTypeConstraint / 内容审核 / 参数不合法)→ 直接终态化。
                // 以前这里只在超 48h 保留期时才终态化,所以这类任务能在 queued 卡满两天,
                // 客户脚本一直重试(2026-08-18:一条卡了 22 小时、被轮询 8925 次)。
                // 5xx / 429 等瞬时错仍然只是「这次没查到」,留给下次对账。
                const e = (j as { error?: { category?: string; message?: string } } | null)?.error;
                if (isTerminalTaskFailure((e?.category ?? '') as UpstreamErrorCategory, res.status)) {
                    await prisma.seedanceVideoTask.updateMany({
                        where: { id: task.id },
                        data: { status: 'failed', fail_reason: (e?.message || '上游判定任务失败').slice(0, 500) },
                    });
                    console.log('[enterprise-reconcile] terminalized', { id: task.id, category: e?.category });
                } else if (expired) {
                    await markExpired(task.id);
                }
                continue;
            }
            const status = String(j.status || '');
            if (status === 'completed') {
                const usage = j.usage as { completion_tokens?: number; total_tokens?: number } | undefined;
                const tokens = usage?.completion_tokens ?? usage?.total_tokens;
                if (tokens && tokens > 0) {
                    await prisma.seedanceVideoTask.updateMany({
                        where: { id: task.id, tokens: null },
                        data: { tokens: BigInt(tokens), status: 'completed' },
                    });
                    const r = await chargeEnterpriseVideoTask(task.id);
                    if (r.outcome === 'charged') {
                        console.log('[enterprise-reconcile] back-charged', { id: task.id, cost: r.costCny });
                    }
                }
            } else if (status === 'failed') {
                await prisma.seedanceVideoTask.updateMany({
                    where: { id: task.id },
                    data: {
                        status: 'failed',
                        fail_reason: typeof j.fail_reason === 'string' ? j.fail_reason.slice(0, 500) : null,
                    },
                });
            } else if (expired) {
                await markExpired(task.id);
            }
            // 仍在跑且未超保留期 → 留给下次
        } catch (e) {
            console.warn('[enterprise-reconcile] task failed', { id: task.id, err: String(e) });
        }
    }
}

async function markExpired(id: string): Promise<void> {
    await prisma.seedanceVideoTask.updateMany({
        where: { id, billed: false },
        data: { status: 'failed', fail_reason: EXPIRED_REASON },
    });
}
