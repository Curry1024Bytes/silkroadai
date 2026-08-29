/**
 * Batch 执行 worker(挂 src/instrumentation.ts,仅主站单实例跑 — 与其他调度器同门)。
 *
 * 每 tick(默认 5s,重入守卫):
 *   1. 超窗批次(创建 >24h 未终态)→ 按已有结果 finalize 成 expired
 *   2. validating 批次 → 解析 + 校验 JSONL → in_progress / failed
 *   3. 领最老的 in_progress/cancelling 批次:
 *      - cancelling → 立即按已有结果 finalize 成 cancelled
 *      - in_progress → 取一小片未执行行(LINES_PER_SWEEP),小并发逐行【self-fetch
 *        重放】到本实例 /v1/images/* 同步管线 —— 计费 / 渠道 failover / 错误归一 /
 *        图床落 URL 全部走客户同步调用的同一条路,worker 零计费逻辑。
 *        全部行有结果 → 组装 output/error JSONL 文件 → completed。
 *
 * 崩溃/重启安全:逐行结果落 batch_request_results(唯一键幂等),重启后从缺的行续跑;
 * 计数器只在首次落行时 increment。最坏情况 = 崩溃时在途的那几行客户侧已扣费但结果丢失
 * → 重启后该行重放(重新计费一次)。生图单价低 + 崩溃罕见,接受;不接受时再上两阶段标记。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import * as Sentry from '@sentry/nextjs';
import {
    claimValidating,
    createFile,
    finalizeBatch,
    getFileInternal,
    listExpiredBatches,
    listLineResults,
    markInProgress,
    markValidationFailed,
    nextRunnableBatch,
    refreshBatch,
    saveLineResult,
    type BatchLineResultRow,
    type BatchRow,
} from './store';
import { validateBatchInput, type ParsedBatchLine } from './validate';

const SWEEP_INTERVAL_MS = 5_000;
/** 单行上游上限,对齐 undici headersTimeout / Caddy 600s(instrumentation.ts Part 1)。 */
const LINE_TIMEOUT_MS = 600_000;
/** 每 tick 最多推进的行数(片间回到 sweep 循环,让取消/过期/新批次校验不被长批饿死)。 */
const LINES_PER_SWEEP = 10;

function lineConcurrency(): number {
    const n = Number(process.env.BATCH_LINE_CONCURRENCY || '2');
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 8) : 2;
}

/** 重放目标 = 本实例自己(容器内 Next 监听 APP_PORT,prod 3002)。走完整 HTTP 一圈
 *  而不是进程内调 handler:route.ts 不导出 handler(Next route 文件只许导出 HTTP 方法),
 *  且 HTTP 形让 batch 行与客户直调字节级同路径(capture / keepalive / 头处理全一致)。 */
function selfBaseUrl(): string {
    return process.env.BATCH_SELF_BASE_URL || `http://127.0.0.1:${process.env.APP_PORT || '3002'}`;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export interface BatchSweepResult {
    expired: number;
    validated: number;
    linesRun: number;
    finalized: number;
    errors: number;
}

async function executeLine(batch: BatchRow, line: ParsedBatchLine): Promise<BatchLineResultRow> {
    let statusCode: number;
    let body: unknown;
    try {
        const resp = await fetch(`${selfBaseUrl()}${batch.endpoint}`, {
            method: 'POST',
            headers: {
                authorization: batch.auth_header,
                'content-type': 'application/json',
                accept: 'application/json',
            },
            body: JSON.stringify(line.body),
            signal: AbortSignal.timeout(LINE_TIMEOUT_MS),
        });
        statusCode = resp.status;
        const text = await resp.text();
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = { raw: text.slice(0, 2000) };
        }
    } catch (e) {
        statusCode = 500;
        body = {
            error: {
                message: `batch line execution failed: ${e instanceof Error ? e.message : String(e)}`,
                type: 'api_error',
            },
        };
    }
    const ok = statusCode >= 200 && statusCode < 300;
    return {
        batch_id: batch.id,
        line_no: line.lineNo,
        custom_id: line.customId,
        status_code: statusCode,
        response_json: ok ? body : null,
        error_json: ok ? null : body,
    };
}

/** 结果行 → OpenAI 输出/错误文件的一行。 */
function outputLine(r: BatchLineResultRow): string {
    const ok = r.status_code >= 200 && r.status_code < 300;
    const body = ok ? r.response_json : r.error_json;
    const errObj = !ok
        ? {
              code: 'request_failed',
              message:
                  ((body as Record<string, unknown> | null)?.error as Record<string, unknown> | undefined)?.message ??
                  `request failed with status ${r.status_code}`,
          }
        : null;
    return JSON.stringify({
        id: `batch_req_${r.batch_id.slice('batch_'.length)}_${r.line_no}`,
        custom_id: r.custom_id,
        response: { status_code: r.status_code, request_id: null, body },
        error: errObj,
    });
}

async function finalizeWithFiles(batch: BatchRow, status: 'completed' | 'expired' | 'cancelled'): Promise<void> {
    const results = await listLineResults(batch.id);
    const okLines = results.filter((r) => r.status_code >= 200 && r.status_code < 300);
    const errLines = results.filter((r) => r.status_code < 200 || r.status_code >= 300);
    let outputFileId: string | null = null;
    let errorFileId: string | null = null;
    if (okLines.length > 0) {
        const buf = Buffer.from(okLines.map(outputLine).join('\n') + '\n', 'utf8');
        const f = await createFile(batch.user_id, 'batch_output', `${batch.id}_output.jsonl`, buf);
        outputFileId = f.id;
    }
    if (errLines.length > 0) {
        const buf = Buffer.from(errLines.map(outputLine).join('\n') + '\n', 'utf8');
        const f = await createFile(batch.user_id, 'batch_error', `${batch.id}_errors.jsonl`, buf);
        errorFileId = f.id;
    }
    await finalizeBatch(batch.id, status, outputFileId, errorFileId);
}

/** 单次扫描。导出给测试直接驱动(不经 setInterval)。 */
export async function sweepBatches(now: Date = new Date()): Promise<BatchSweepResult> {
    const result: BatchSweepResult = { expired: 0, validated: 0, linesRun: 0, finalized: 0, errors: 0 };

    // 1. 超窗 → expired(带上已完成的部分结果)
    for (const b of await listExpiredBatches(now)) {
        try {
            await finalizeWithFiles(b, 'expired');
            result.expired++;
        } catch (e) {
            result.errors++;
            console.error('[batch-worker] expire failed', b.id, e);
        }
    }

    // 2. validating → in_progress / failed(每 tick 清空队列;校验是纯 CPU + 一次文件读,快)
    for (;;) {
        const b = await claimValidating();
        if (!b) break;
        try {
            const file = await getFileInternal(b.input_file_id);
            if (!file) {
                await markValidationFailed(b.id, {
                    object: 'list',
                    data: [{ code: 'file_not_found', message: 'input file was deleted', line: 1, param: null }],
                });
            } else {
                const v = validateBatchInput(file.content, b.endpoint);
                if (v.ok) await markInProgress(b.id, v.lines.length);
                else await markValidationFailed(b.id, v.errors);
            }
            result.validated++;
        } catch (e) {
            result.errors++;
            console.error('[batch-worker] validate failed', b.id, e);
            break; // DB 抖动时别死循环
        }
    }

    // 3. 推进一个批次
    const batch = await nextRunnableBatch();
    if (!batch) return result;

    if (batch.status === 'cancelling' || batch.cancel_requested) {
        await finalizeWithFiles(batch, 'cancelled');
        result.finalized++;
        return result;
    }

    const file = await getFileInternal(batch.input_file_id);
    const v = file ? validateBatchInput(file.content, batch.endpoint) : null;
    if (!v || !v.ok) {
        // in_progress 后输入文件被删/不可再解析(理论不可达 —— 文件表无删级联):按已有结果收尾
        console.error('[batch-worker] input unreadable after validation', batch.id);
        await finalizeWithFiles(batch, 'completed');
        result.finalized++;
        return result;
    }

    const done = new Set((await listLineResults(batch.id)).map((r) => r.line_no));
    const pending = v.lines.filter((l) => !done.has(l.lineNo)).slice(0, LINES_PER_SWEEP);

    if (pending.length === 0) {
        await finalizeWithFiles(batch, 'completed');
        result.finalized++;
        return result;
    }

    // 小并发池推进本片
    const queue = [...pending];
    const workers = Array.from({ length: Math.min(lineConcurrency(), queue.length) }, async () => {
        for (;;) {
            const line = queue.shift();
            if (!line) return;
            // 片内也响应取消:每行开跑前查一次标志(refresh 便宜,行执行贵)
            const fresh = await refreshBatch(batch.id).catch(() => null);
            if (fresh?.cancel_requested) return;
            const r = await executeLine(batch, line);
            await saveLineResult(r);
            result.linesRun++;
        }
    });
    await Promise.all(workers);

    // 本片跑完就全 done → 立即 finalize,不等下一 tick
    const after = await refreshBatch(batch.id);
    if (after && after.status === 'in_progress' && !after.cancel_requested) {
        const doneAfter = new Set((await listLineResults(batch.id)).map((r) => r.line_no));
        if (v.lines.every((l) => doneAfter.has(l.lineNo))) {
            await finalizeWithFiles(after, 'completed');
            result.finalized++;
        }
    }
    return result;
}

export function startBatchScheduler(): void {
    if (timer) return;
    const tick = (): void => {
        if (running) return; // 上一轮(可能在跑慢行)未结束 → 跳过
        running = true;
        sweepBatches()
            .catch((err) => {
                console.error('[batch-worker] sweep failed:', err);
                Sentry.captureException(err, { tags: { area: 'batch-worker' } });
            })
            .finally(() => {
                running = false;
            });
    };
    // 首跑延后 10s:等 Next 完全就绪再 self-fetch(boot 即打自己会 ECONNREFUSED 白错一轮)
    void sleep(10_000).then(() => {
        tick();
        timer = setInterval(tick, SWEEP_INTERVAL_MS);
    });
    console.log('Batch scheduler started');
}

export function stopBatchScheduler(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
