/**
 * 轮询结果短 TTL 缓存 + 同任务并发合流(2026-08-19)。
 *
 * 为什么要:客户的轮询频率会 **1:1 传导**到上游。实测 liyan2 曾同时有 29 个任务在途,
 * 按每 5 秒轮一次就是 ~350 次/分钟打到上游,上游 nginx 直接限流(2026-08-18 峰值
 * 129 次 429/分钟)。而视频出片要几分钟 —— 秒级轮询拿到的答案跟 8 秒前一模一样,
 * 纯粹是自我限流。
 *
 * 做两件事,都不改变对客语义:
 *  ① **短 TTL 缓存**:同一 task 在 TTL 内只打一次上游,其余复用结果;
 *  ② **并发合流(single-flight)**:同一 task 的并发轮询共用一次在途请求,
 *    避免「TTL 刚过 + 客户并发」瞬间打出一堆重复请求。
 *
 * 缓存的是 **(HTTP 状态码, 响应体文本)** 这对原始结果,不是 Response 对象 ——
 * 调用方拿到后照常跑完整的下游逻辑(落 tokens / 幂等扣费 / 客户 OSS 转存 / 序列化),
 * 所以**所有副作用一个不少**,缓存对语义完全透明。扣费本身是 CAS + (kind,ref) 双幂等,
 * 重复执行零风险。
 *
 * TTL 分两档:
 *  - 非终态(queued / running / 上游报错):`ENTERPRISE_POLL_CACHE_MS`,缺省 8000ms;
 *  - 已完成:60s —— 结果不会再变,而客户完成后往往还会重复拉几次取成片 URL。
 * 置 `ENTERPRISE_POLL_CACHE_MS=0` 整体关闭(出问题时的逃生阀)。
 *
 * ⚠️ 进程内缓存:企业实例有 3 个副本,各存各的 → 上游实际 QPS 上限是
 * 3 × (1/TTL) per task,不是 1 × 。要再降只能上共享缓存(目前没有 Redis)。
 * ⚠️ 只在【对客轮询】路径用;对账器要的是权威状态,不走缓存。
 */
import 'server-only';

export interface UpstreamPollResult {
    /** 上游 HTTP 状态码。 */
    status: number;
    /** 上游响应体原文(未解析)。 */
    text: string;
}

/** 已完成的任务结果不会再变,缓存久一点 —— 客户完成后常会重复拉取成片 URL。 */
const COMPLETED_TTL_MS = 60_000;
const DEFAULT_TTL_MS = 8_000;
/** 兜底上限,防异常情况下无限增长(单条 entry 很小,5000 条约几 MB)。 */
const MAX_ENTRIES = 5_000;

interface Entry {
    result: UpstreamPollResult;
    expiresAt: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<UpstreamPollResult>>();

/** 运行时读 env(不缓存),便于改配置不重启 + 可测。0 或非法值 = 关闭缓存。 */
function ttlMsFor(result: UpstreamPollResult): number {
    const raw = Number(process.env.ENTERPRISE_POLL_CACHE_MS ?? DEFAULT_TTL_MS);
    const base = Number.isFinite(raw) && raw > 0 ? raw : 0;
    if (base === 0) return 0;
    // 只有 2xx 且明确 completed 才用长 TTL;其余(排队中/上游报错)用短 TTL。
    const done = result.status < 400 && /"status"\s*:\s*"completed"/.test(result.text);
    return done ? Math.max(base, COMPLETED_TTL_MS) : base;
}

function prune(now: number): void {
    for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
    if (cache.size <= MAX_ENTRIES) return;
    // 仍超限:按插入序丢最旧的(Map 保序)
    const excess = cache.size - MAX_ENTRIES;
    let i = 0;
    for (const k of cache.keys()) {
        if (i++ >= excess) break;
        cache.delete(k);
    }
}

/**
 * 取轮询结果:命中未过期缓存直接返;否则打上游(同 task 并发只打一次)。
 * `cached` 供调用方落日志/加响应头,不影响业务。
 */
export async function pollWithCache(
    taskId: string,
    fetcher: () => Promise<UpstreamPollResult>,
): Promise<{ result: UpstreamPollResult; cached: boolean }> {
    const now = Date.now();
    const hit = cache.get(taskId);
    if (hit && hit.expiresAt > now) return { result: hit.result, cached: true };

    // 并发合流:同一 task 已有在途请求就搭车,不重复打上游
    const running = inflight.get(taskId);
    if (running) return { result: await running, cached: true };

    const p = (async () => {
        try {
            const result = await fetcher();
            const ttl = ttlMsFor(result);
            if (ttl > 0) {
                cache.set(taskId, { result, expiresAt: Date.now() + ttl });
                prune(Date.now());
            }
            return result;
        } finally {
            inflight.delete(taskId);
        }
    })();
    inflight.set(taskId, p);
    return { result: await p, cached: false };
}

/** 任务已终态化(落库 failed)后主动清缓存,免得短时间内还拿旧的排队态。 */
export function invalidatePollCache(taskId: string): void {
    cache.delete(taskId);
}

/** 仅测试用:清空缓存与在途表。 */
export function __resetPollCache(): void {
    cache.clear();
    inflight.clear();
}
