import { NextResponse } from 'next/server';

/**
 * 慢生图 keepalive(防 Cloudflare 橙云 ~100s 回源超时 → 客户拿 524 而 new-api 已出图并计费)。
 * 把慢 image handler 包一层,和 ~85s 定时器赛跑:
 *  - handler 在 afterMs 内完成(绝大多数请求,含快速 4xx 安全拦截)→ 原样返回其响应(状态码/body/头
 *    全不变,零回归)。
 *  - 超过 afterMs 仍未完成 → 立即回 200 并每 trickleMs 涓流一个 keepalive 字节,骗过 CF 的首字节计时器;
 *    handler 真正完成后把真实 body 追加发出、关闭流。代价:只有「>afterMs 才失败」的请求会变成
 *    200 + 错误 body(而不是原状态码)—— 但那本来就会撞 CF 超时变 524,不算回归。
 * sse=true 用 SSE 注释 `: keepalive` 做涓流(SSE 解析器忽略注释行);否则用空格(JSON 前导空白合法,
 * `JSON.parse('   {...}')` 正常)。afterMs/trickleMs 可注入(默认读 KEEPALIVE_AFTER_MS/KEEPALIVE_TRICKLE_MS
 * env,再退默认 85s/20s),测试用小值跑真实定时器。
 */
/** Slow SSE has already committed 200: failures must be parseable events, never bare JSON. */
function sseErrorFrame(body: string, status: number): string {
    let error: unknown;
    try {
        const parsed: unknown = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && 'error' in parsed) error = parsed.error;
    } catch {
        // Do not echo an HTML upstream error page into the customer protocol.
    }
    if (!error || typeof error !== 'object' || Array.isArray(error)) {
        error = {
            message: typeof error === 'string' ? error : `image request failed with status ${status}`,
            type: 'server_error',
            code: 'upstream_error',
        };
    }
    return `data: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`;
}

export async function withKeepalive(
    work: Promise<NextResponse>,
    opts: { sse?: boolean; afterMs?: number; trickleMs?: number } = {},
): Promise<NextResponse> {
    const afterMs = opts.afterMs ?? (Number(process.env.KEEPALIVE_AFTER_MS) || 85_000);
    const trickleMs = opts.trickleMs ?? (Number(process.env.KEEPALIVE_TRICKLE_MS) || 20_000);
    let raceTimer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
        work.then(
            (res) => ({ res }),
            (err) => ({ err }),
        ),
        new Promise<'timeout'>((resolve) => {
            raceTimer = setTimeout(() => resolve('timeout'), afterMs);
        }),
    ]);
    if (raceTimer) clearTimeout(raceTimer); // work 先完成时清掉 85s 定时器,避免悬挂 handle
    if (settled !== 'timeout') {
        if ('res' in settled) return settled.res; // afterMs 内完成 → 原样返回,零回归
        throw settled.err; // handler 在 afterMs 内 reject(罕见)→ 交上层
    }
    // 慢路径:已过 afterMs,handler 还在跑 → 200 + keepalive 涓流,真实 body 稍后追加
    const enc = new TextEncoder();
    const pad = enc.encode(opts.sse ? ': keepalive\n\n' : ' ');
    let closed = false;
    let keep: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const emit = (bytes: Uint8Array) => {
                if (closed) return;
                try {
                    controller.enqueue(bytes);
                } catch {
                    closed = true;
                    if (keep) clearInterval(keep);
                }
            };
            // Send the first byte at the timeout, not another trickle interval later.
            emit(pad);
            keep = setInterval(() => emit(pad), trickleMs);
            let bodyText: string;
            try {
                const response = await work;
                bodyText = await response.text();
                if (
                    opts.sse &&
                    (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream'))
                ) {
                    bodyText = sseErrorFrame(bodyText, response.status);
                }
            } catch (err) {
                bodyText = JSON.stringify({
                    error: {
                        message: `upstream request failed: ${err instanceof Error ? err.message : String(err)}`,
                        type: 'proxy_error',
                    },
                });
                if (opts.sse) bodyText = sseErrorFrame(bodyText, 502);
            }
            if (keep) clearInterval(keep);
            emit(enc.encode(bodyText));
            if (!closed) {
                closed = true;
                try {
                    controller.close();
                } catch {
                    /* The customer may have disconnected. */
                }
            }
        },
        cancel() {
            // The generation continues to its terminal state; only stop writing keepalive bytes.
            closed = true;
            if (keep) clearInterval(keep);
        },
    });
    return new NextResponse(stream, {
        status: 200,
        headers: {
            'content-type': opts.sse ? 'text/event-stream' : 'application/json',
            'X-Silkroadai-Keepalive': 'trickle',
        },
    });
}
