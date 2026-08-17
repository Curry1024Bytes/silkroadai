/**
 * /dashboard 明细日志的短 TTL 进程内缓存(2026-08-15)。
 *
 * 背景:dashboard 每次渲染并发打 3 发 `queryLogs`(type=2 消费 / type=5 失败 /
 * type=6 任务失败),而 `usage-aggregate`(5min)、`quota-cache`(60s)、
 * `token-usage`(60s)都有缓存,唯独这三发【一层都没有】—— 切一次 tab、改一次
 * period 就重打一次。每发都会触发 new-api 分页用的
 * `SELECT count(*) FROM logs WHERE username = $1`,在 3600 万行的 logs 表上
 * 是重活(2026-08-15 实测:VACUUM 前 1.7s / 后 0.46s)。
 *
 * 为什么是进程内而不是像邻居那样落 Postgres:
 *  - 明细列表是纯展示数据,30s 陈旧无副作用(隔壁的用量聚合本身就是 5min);
 *  - 免一次 migration,也免掉「为缓存去写库」的反效果;
 *  - dashboard 只由主站单实例(:3002)渲染,/v1 三副本不跑网站页面,
 *    所以没有多实例缓存不一致的问题。
 *
 * ⚠️ 内存上限是硬要求。2026-08-15 刚修完一次 reqlog 无界持有导致的 OOM,
 * 这里不能再种一个:MAX_ENTRIES 封顶 + 每次写入顺手清过期,超限则驱逐最早写入的。
 */
import 'server-only';
import { queryLogs, type NewApiUsageLog } from './client';

/** 缓存存活时间。比邻居的 usage-aggregate(5min)短得多 —— 明细列表是客户
 *  盯着看的东西,宁可短。 */
const TTL_MS = 30_000;

/** 缓存条目上限。每条最多攥 ~200 行日志对象,500 条是个宽松但有界的天花板。 */
const MAX_ENTRIES = 500;

interface Entry {
    at: number;
    value: { items: NewApiUsageLog[]; total: number };
}

const store = new Map<string, Entry>();

/** 稳定的 key:字段顺序固定,undefined 归一成空串。 */
function cacheKey(args: QueryLogsArgs): string {
    return [
        args.username,
        args.type,
        args.start_timestamp ?? '',
        args.end_timestamp ?? '',
        args.page,
        args.page_size,
    ].join('|');
}

/** 清掉过期条目;仍超上限则按插入序驱逐最早的(Map 迭代序 = 插入序)。 */
function evict(now: number): void {
    for (const [k, v] of store) {
        if (now - v.at >= TTL_MS) store.delete(k);
    }
    while (store.size >= MAX_ENTRIES) {
        const oldest = store.keys().next();
        if (oldest.done) break;
        store.delete(oldest.value);
    }
}

/** 直接从 `queryLogs` 的形参推导,避免这里的 `type` 之类联合字面量类型
 *  与上游定义漂移(它是 0|1|2|3|4|5|6,不是任意 number)。这里只把
 *  dashboard 真正用到的几个维度收成必填 —— 它们同时也是缓存 key 的组成。 */
type QueryLogsArgs = Parameters<typeof queryLogs>[0] &
    Required<Pick<Parameters<typeof queryLogs>[0], 'username' | 'type' | 'page' | 'page_size'>>;

/**
 * 带 30s 缓存的 `queryLogs`。命中返缓存,未命中打上游并写回。
 *
 * 上游抛错【不缓存、直接冒泡】—— 调用方(dashboard 的 `Promise.allSettled`)
 * 自己有降级分支,把错误吞进缓存反而会让故障黏住 30s。
 */
export async function queryLogsCached(args: QueryLogsArgs): Promise<{ items: NewApiUsageLog[]; total: number }> {
    const now = Date.now();
    const key = cacheKey(args);

    const hit = store.get(key);
    if (hit && now - hit.at < TTL_MS) return hit.value;

    const value = await queryLogs(args);
    evict(now);
    store.set(key, { at: now, value });
    return value;
}

/** 测试钩子:清空缓存,让用例之间不串味。 */
export function __resetLogsCacheForTest(): void {
    store.clear();
}
