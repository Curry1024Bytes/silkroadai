/**
 * /v1/messages 流式「持头转发」(2026-07-29 luwei@hidream.ai 诊断的根治件①)。
 *
 * 问题:纯透传时 new-api 一给 200 我们就把响应头转给客户,之后号池上游中途挂掉
 * (实测形态:只发 ping 30-90s → 一个 error 事件/直接断,从没有 message_start),
 * 客户拿到「假 200 + 无 usage 的空流」,且已无法改状态码、无法重试。
 *
 * 根治:收到上游 200 SSE 后【先不给客户发头】,缓冲并检读事件流:
 *   - 等到第一个实质事件(message_start / 任何非 ping 事件)→ 转发 200 + 回放
 *     缓冲字节 + 继续管道。正常请求几乎零额外延迟:ping-only 阶段本来就没有内容,
 *     客户端此前同样只能干等;
 *   - 等到 error 事件 / 流直接死 → 头还没发!调度精确自动退款(件②,按该次上游
 *     响应的 x-oneapi-request-id 冲账),然后【换一次重试】(重新 POST,new-api
 *     重新选渠道)。重试仍失败 → 返回真实 502(Anthropic error JSON);
 *   - 持头上限 HOLD_CAP_MS(默认 90s,< Cloudflare 100s 首字节超时)→ 到点退化为
 *     今天的行为(转发 200 + 已缓冲的 ping + 继续管道),零新增超时风险;
 *   - 客户在持头期断开 → 取消上游、不重试、不退款(客户主动放弃,new-api 若计
 *     输入费属合理计费,不在件②判据内)。
 *
 * 非流式 /messages 与错误响应走与原透传完全相同的尾部(guard no-op + capture)。
 * 本文件同时接管 /messages POST 的非流式转发 —— 因为要判 stream 标志必须先读体,
 * 读完体就不能再走 forwardToNewApi 的 req.body 直传路径。
 */
import { NextRequest, NextResponse } from 'next/server';
import { forwardHeaders, passthroughResponse, STRIP_RESPONSE_HEADERS } from '@/lib/proxy/forward';
import { guardSseStream } from '@/lib/sse/stream-guard';
import { scheduleStreamFailRefund } from '@/lib/billing/stream-fail-refund';
import {
    type CaptureCtx,
    captureJsonResponse,
    captureResponse,
    parseModelAndStream,
    recordRequestBody,
} from '@/lib/reqlog/capture';

const NEWAPI_BASE_URL = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';

/** 持头上限:观测到的失败流在 32-88s 死;90s 能兜住全部,且 < CF 100s 首字节钟。 */
const HOLD_CAP_MS = parseInt(process.env.PROXY_MESSAGES_HOLD_MS || '90000', 10);
/** 总尝试次数(1 次原始 + 1 次 failover 重试)。 */
const MAX_ATTEMPTS = 2;

type HoldVerdict =
    | { kind: 'started'; buffered: Uint8Array[] } // 见到实质事件(或持头到点)→ 转发
    | { kind: 'failed'; buffered: Uint8Array[]; errorMessage: string } // error 尾/死流,头未发
    | { kind: 'client-abort' };

/** POST /v1/messages 统一入口(流式持头;非流式与原透传等价)。 */
export async function handleAnthropicMessages(
    req: NextRequest,
    path: string,
    search: string,
    cap: CaptureCtx | null,
): Promise<NextResponse> {
    const raw = await req.text();
    const pm = parseModelAndStream(raw);
    if (cap) recordRequestBody(cap, raw, pm.model, pm.streamed);

    const url = `${NEWAPI_BASE_URL}/v1${path}${search}`;
    const doFetch = () =>
        fetch(url, { method: 'POST', headers: forwardHeaders(req), body: raw, duplex: 'half' } as RequestInit & {
            duplex: 'half';
        });

    const rawAuth = req.headers.get('authorization') || req.headers.get('x-api-key');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let upstream: Response;
        try {
            upstream = await doFetch();
        } catch (err) {
            // 连 new-api 都打不通:portal↔new-api 同机,视为硬故障,照原语义抛给框架 500
            throw err;
        }

        const ct = upstream.headers.get('content-type') || '';
        const isSse = upstream.ok && !!upstream.body && ct.includes('text/event-stream');

        // 非流式请求 / 非 2xx / 非 SSE 响应:与原透传尾部等价(真实状态码原样给客户)。
        // 注意:重试后拿到非 2xx 也走这里 —— 那是 new-api 的真实错误码,比我们编一个好。
        if (!pm.streamed || !isSse) {
            return cap ? captureResponse(cap, upstream) : passthroughResponse(upstream);
        }

        // ── 流式 2xx SSE:持头检读(reader 贯穿持头与回放,body 只能 getReader 一次)──
        const requestId = upstream.headers.get('x-oneapi-request-id');
        const reader = upstream.body!.getReader();
        const verdict = await holdUntilFirstEvent(reader, req.signal);

        if (verdict.kind === 'client-abort') {
            await reader.cancel().catch(() => {});
            return new NextResponse(null, { status: 499 });
        }

        if (verdict.kind === 'started') {
            const merged = concatStream(verdict.buffered, reader);
            const guarded = guardSseStream(merged, {
                shape: 'anthropic',
                label: 'proxy/messages-hold',
                model: pm.model ?? undefined,
                onInterrupted: cap
                    ? (err) => {
                          cap.incomplete = true;
                          cap.errorParts.push('upstream-read:' + (err instanceof Error ? err.message : String(err)));
                      }
                    : undefined,
            });
            const headers = new Headers();
            upstream.headers.forEach((v, k) => {
                if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) headers.set(k, v);
            });
            if (attempt > 1) headers.set('X-Silkroadai-Stream-Failover', `attempt=${attempt}`);
            const resp = new Response(guarded, { status: upstream.status, headers });
            return cap ? captureResponse(cap, resp) : passthroughResponse(resp);
        }

        // ── failed:头未发,可以补救 ──
        await reader.cancel().catch(() => {}); // 释放死流连接再重试
        console.warn('[messages-hold] upstream stream failed before first event', {
            model: pm.model,
            attempt,
            requestId,
            err: verdict.errorMessage.slice(0, 200),
        });
        // 件②:这次失败的 attempt 可能已被 new-api 计了输入费,按 request_id 精确冲账
        scheduleStreamFailRefund({
            upstreamRequestId: requestId,
            rawAuth,
            model: pm.model ?? 'unknown',
            label: 'messages-hold',
        });
        // 循环进入下一次 attempt(重新 POST,new-api 重新选渠道)
    }

    // 全部尝试失败 → 真实错误码(Anthropic error 形;stream 请求的错误也是 JSON 响应,SDK 原生支持)
    const errBody = {
        type: 'error',
        error: {
            type: 'api_error',
            message: `上游服务临时不可用,本次调用未产生任何输出、不会计费(自动重试 ${MAX_ATTEMPTS} 次均失败),请稍后重试。`,
        },
    };
    if (cap) captureJsonResponse(cap, 502, errBody);
    const resp = NextResponse.json(errBody, { status: 502 });
    resp.headers.set('X-Silkroadai-Stream-Failover', `exhausted=${MAX_ATTEMPTS}`);
    return resp;
}

/**
 * 检读 SSE 流直到能下判决:
 *  - 任何非 ping 的实质事件(message_start / content_block_* / …)→ started
 *  - error 事件 / 流 done / 读异常 → failed
 *  - 持头到点(HOLD_CAP_MS)→ started(退化为原透传行为)
 *  - 客户断开 → client-abort(取消上游)
 * 返回的 buffered 是已消费的【原始字节】,started 时必须原样回放给客户。
 */
async function holdUntilFirstEvent(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    clientSignal: AbortSignal,
): Promise<HoldVerdict> {
    const decoder = new TextDecoder();
    const buffered: Uint8Array[] = [];
    let text = ''; // 解码累计(仅用于事件判定;回放用 buffered 原始字节)
    let scanned = 0; // text 中已按事件边界消费到的位置

    const onAbort = () => void reader.cancel().catch(() => {});
    clientSignal.addEventListener('abort', onAbort, { once: true });

    const deadline = Date.now() + HOLD_CAP_MS;
    try {
        for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) return { kind: 'started', buffered };

            let timedOut = false;
            const timeout = new Promise<{ done: false; value: undefined; timedOut: true }>((resolve) => {
                const t = setTimeout(() => {
                    timedOut = true;
                    resolve({ done: false, value: undefined, timedOut: true });
                }, remaining);
                (t as unknown as { unref?: () => void }).unref?.();
            });
            const read = await Promise.race([reader.read(), timeout]);
            if (clientSignal.aborted) return { kind: 'client-abort' };
            if (timedOut || (read as { timedOut?: boolean }).timedOut) return { kind: 'started', buffered };

            const { done, value } = read as ReadableStreamReadResult<Uint8Array>;
            if (done) {
                return { kind: 'failed', buffered, errorMessage: 'stream ended before any content event' };
            }
            if (value && value.length > 0) {
                buffered.push(value);
                text += decoder.decode(value, { stream: true });
            }

            // 逐个完整事件判定(事件以空行分隔;留下最后一个不完整片段)
            for (;;) {
                const idx = text.indexOf('\n\n', scanned);
                if (idx === -1) break;
                const evt = text.slice(scanned, idx);
                scanned = idx + 2;
                const cls = classifyEvent(evt);
                if (cls === 'error') {
                    return { kind: 'failed', buffered, errorMessage: extractErrorMessage(evt) };
                }
                if (cls === 'substantive') return { kind: 'started', buffered };
                // ping / 注释 / 空事件 → 继续等
            }
        }
    } catch (err) {
        if (clientSignal.aborted) return { kind: 'client-abort' };
        return {
            kind: 'failed',
            buffered,
            errorMessage: 'stream read error: ' + (err instanceof Error ? err.message : String(err)),
        };
    } finally {
        clientSignal.removeEventListener('abort', onAbort);
    }
}

/** SSE 事件分类:ping/注释 = 无信息;error = 上游失败;其余任何事件 = 实质开始。 */
function classifyEvent(evt: string): 'ping' | 'error' | 'substantive' {
    let eventName = '';
    let dataStr = '';
    for (const line of evt.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
        // `:` 开头的注释行与空行忽略
    }
    if (!eventName && !dataStr) return 'ping'; // 纯注释/空事件
    let dataType = '';
    if (dataStr) {
        try {
            const d = JSON.parse(dataStr) as { type?: unknown };
            if (typeof d.type === 'string') dataType = d.type;
        } catch {
            /* 非 JSON data:当实质事件转发,让客户端自己处理 */
            return 'substantive';
        }
    }
    const t = eventName || dataType;
    if (t === 'ping') return 'ping';
    if (t === 'error' || dataType === 'error') return 'error';
    return 'substantive';
}

function extractErrorMessage(evt: string): string {
    for (const line of evt.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
            const d = JSON.parse(line.slice(5).trim()) as { error?: { message?: unknown } };
            if (d.error && typeof d.error.message === 'string') return d.error.message;
        } catch {
            /* fallthrough */
        }
    }
    return 'upstream error event';
}

/** 已缓冲字节 + 剩余上游流 → 一条连续流(缓冲先回放,再管道;cancel 传播给上游)。 */
function concatStream(
    buffered: Uint8Array[],
    reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (i < buffered.length) {
                controller.enqueue(buffered[i++]);
                return;
            }
            const { done, value } = await reader.read();
            if (done) {
                controller.close();
                return;
            }
            controller.enqueue(value);
        },
        cancel(reason) {
            return reader.cancel(reason).catch(() => {});
        },
    });
}
