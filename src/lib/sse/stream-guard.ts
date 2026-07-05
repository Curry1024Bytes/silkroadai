/**
 * SSE 流式两件套(借鉴 OpenRouter 的流可靠性做法)。
 *
 * 1. keep-alive 注释:上游静默超过 keepaliveMs(默认 15s)就向客户端写一行 SSE 注释
 *    `: keep-alive`。SSE 规范里 `:` 开头的行是注释,合规解析器(openai / anthropic SDK、
 *    EventSource、chat-console 的 drainSse)都会忽略;但字节在流动,Cloudflare 橙云
 *    (~100s 空闲即掐 → 客户拿 524/断流)、中间代理、SDK 空闲读超时就不会把「reasoning
 *    模型思考中 / 长静默」误判成死连接。
 *
 * 2. 流中断错误事件:上游流中途死掉(连接重置 / AbortSignal 超时)时,现状是客户只看到
 *    TCP 层断开 —— SDK 抛网络错,分不清"portal 挂了"还是"上游断了",已收到的部分输出
 *    是否完整也无从判断。改为:追加一个格式内合法的错误事件后【干净收流】:
 *      - openai 形:`finish_reason:"error"` 的 chunk(带 error 对象)+ `data: [DONE]`
 *        (镜像 OpenRouter 的流中错误约定,OpenAI SDK 能照常解析);
 *      - anthropic 形:`event: error` + Anthropic 原生错误 JSON(SDK 解析成 APIError)。
 *
 * shape=null 的路径(未知 SSE 格式,如 /responses 的 Responses 事件流)只做 keep-alive,
 * 上游错误照旧向下传播(不注入未知格式不一定能解析的事件,维持现状语义)。
 *
 * 与 `src/app/v1/[...path]/keepalive.ts` 的 withKeepalive 互补:那个包的是【缓冲式】慢
 * handler(生图)防 CF 首字节超时;这里守的是【已开流】的 SSE 透传管道。
 */

export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

/** 流中断时注入的错误事件格式;null = 只做 keep-alive,错误照旧传播。 */
export type SseErrorShape = 'openai' | 'anthropic' | null;

const MID_STREAM_ERROR_MESSAGE = 'Upstream connection lost mid-stream; partial output may be incomplete. Please retry.';

function errorTail(shape: 'openai' | 'anthropic', model?: string): string {
    if (shape === 'anthropic') {
        const ev = { type: 'error', error: { type: 'api_error', message: MID_STREAM_ERROR_MESSAGE } };
        return `event: error\ndata: ${JSON.stringify(ev)}\n\n`;
    }
    // 带上 id/created/model(能拿到时),让尾帧与流里其他 chunk 形状一致 —— 严格类型化的
    // 客户端(Swift Codable / Java 非可空字段)和按 chunk.model 记账的 wrapper(litellm)不炸。
    const chunk = {
        id: `chatcmpl-interrupted-${crypto.randomUUID()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        ...(model ? { model } : {}),
        choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
        error: {
            message: MID_STREAM_ERROR_MESSAGE,
            type: 'silkroadai_proxy_error',
            code: 'upstream_stream_interrupted',
        },
    };
    return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

export interface SseGuardOpts {
    shape: SseErrorShape;
    /** 日志标签(哪条管道),流中断 warn 带上便于定位。 */
    label: string;
    /** openai 形尾帧带上 model 字段(call site 知道时传)。 */
    model?: string;
    /** 流中断被守卫吞掉(注入尾帧、干净收流)时回调 —— 请求日志(reqlog)靠它保留
     *  incomplete 标记,否则 tee 只看到正常 done,结构化查询里中断流会隐身。 */
    onInterrupted?: (err: unknown) => void;
    /** 测试注入用;<=0 关闭 keep-alive。 */
    keepaliveMs?: number;
}

/**
 * 包住一条 SSE ReadableStream:数据原样过(pull-based,保留背压),静默期注入
 * keep-alive 注释,上游中途报错时按 shape 注入错误事件后干净收流。
 * 客户端断开(cancel)向上游传播,不留悬挂 reader/timer。
 */
export function guardSseStream(upstream: ReadableStream<Uint8Array>, opts: SseGuardOpts): ReadableStream<Uint8Array> {
    const keepaliveMs = opts.keepaliveMs ?? SSE_KEEPALIVE_INTERVAL_MS;
    const enc = new TextEncoder();
    const reader = upstream.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
    // 上游最后转发的字节是否行尾(\n)。注释只能落在行边界上:上游 chunk 可能在
    // TCP 分段处停在半行(`data: {"choi`),此时注入会把注释拼进 data 行,客户端
    // JSON 解析炸 → 静默损坏。半行静默时跳过本轮注入、只重挂(极罕见,且那种连接
    // 多半已死,退化为现状 = 无 keep-alive)。流开头(尚无字节)注入合法。
    let atLineBoundary = true;

    const disarm = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
    };
    /** 静默计时:到点注入 keep-alive 注释并重挂;数据到达/收流时 disarm。 */
    const arm = () => {
        if (keepaliveMs <= 0 || finished) return;
        timer = setTimeout(() => {
            if (finished || !ctl) return;
            if (atLineBoundary) {
                try {
                    ctl.enqueue(enc.encode(': keep-alive\n\n'));
                } catch {
                    finished = true; // 流已收/客户断开 → 不再重挂
                    return;
                }
            }
            arm();
        }, keepaliveMs);
        // 不阻止进程退出:路由测试里未被消费的 guarded body 不该把 vitest worker 钉住;
        // prod server 事件循环恒活,unref 后定时器照常触发。
        (timer as unknown as { unref?: () => void }).unref?.();
    };

    return new ReadableStream<Uint8Array>({
        start(controller) {
            ctl = controller;
            arm();
        },
        async pull(controller) {
            try {
                const { value, done } = await reader.read();
                if (finished) return; // 等待期间客户已 cancel → controller 不能再碰
                if (done) {
                    finished = true;
                    disarm();
                    controller.close();
                    return;
                }
                disarm();
                if (value && value.length > 0) atLineBoundary = value[value.length - 1] === 0x0a;
                controller.enqueue(value);
                arm();
            } catch (err) {
                disarm();
                if (finished) return; // cancel 引发的读中断,不算上游死
                finished = true;
                console.warn('[sse-guard] upstream stream died mid-stream', {
                    label: opts.label,
                    err: err instanceof Error ? err.message : String(err),
                });
                if (opts.shape === null) {
                    controller.error(err); // 未知格式:维持现状(错误向下传播)
                    return;
                }
                opts.onInterrupted?.(err);
                try {
                    // 无条件前置空行:把可能悬着的残行/残事件整个封掉(客户端按坏事件
                    // 跳过,如 drainSse 的 malformed-skip),尾帧独立成帧被解析。落在
                    // 干净事件边界时多出的空行 = 空事件,SSE 解析器不派发,无害。
                    controller.enqueue(enc.encode('\n\n' + errorTail(opts.shape, opts.model)));
                } catch {
                    /* 客户已断开 */
                }
                try {
                    controller.close();
                } catch {
                    /* already closed */
                }
            }
        },
        cancel(reason) {
            finished = true;
            disarm();
            return reader.cancel(reason).catch(() => {});
        },
    });
}

/**
 * 便捷封装:upstream Response 是 2xx 且 content-type 为 text/event-stream 时,
 * 把 body 换成守卫过的流(status/headers 原样);其余(JSON、错误响应、无 body)原样返回。
 */
export function guardSseResponse(upstream: Response, opts: SseGuardOpts): Response {
    if (!upstream.ok || !upstream.body) return upstream;
    const ct = upstream.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) return upstream;
    return new Response(guardSseStream(upstream.body, opts), {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
    });
}
