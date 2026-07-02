/**
 * 视频异步任务失败时 new-api 记一条 type=6「task failed」并**退还**预扣 quota(净扣 0)。
 * 但 type=2 的消费记录**不带 task_id**,无法与 type=6 直接关联,所以按
 * (模型名 + quota 相同、且 type=2 时间在失败记录之前)贪心配对:每条失败记录挑一条最接近其之前、
 * 尚未配对的 type=2 消费,判定为「失败·已退款」。
 *
 * 权衡:同模型 + 同 quota(同时长)的多次请求里若成功/失败交织,具体标到哪一条可能有偏差,但
 * **失败条数与净消费金额始终正确**——客户看到的"失败 N 条 / ¥0"在聚合意义上准确(明细表 totals
 * 由 usage-aggregate 单独净退款,不受此影响)。
 */
export interface LogLite {
    id: number;
    model_name: string;
    quota: number;
    created_at: number;
}

export function matchFailedVideoConsumes(consume: LogLite[], taskFailed: LogLite[]): Set<number> {
    const failed = new Set<number>();
    if (!taskFailed.length || !consume.length) return failed;
    const consumeAsc = [...consume].sort((a, b) => a.created_at - b.created_at);
    for (const t6 of [...taskFailed].sort((a, b) => a.created_at - b.created_at)) {
        let best: LogLite | null = null;
        for (const c of consumeAsc) {
            if (failed.has(c.id)) continue;
            if (c.model_name === t6.model_name && c.quota === t6.quota && c.created_at <= t6.created_at) {
                if (!best || c.created_at > best.created_at) best = c; // 取时间最靠近(最晚的、在其之前的)
            }
        }
        if (best) failed.add(best.id);
    }
    return failed;
}
