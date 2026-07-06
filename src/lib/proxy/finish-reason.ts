/**
 * finish_reason 归一(借鉴 OpenRouter 的跨厂商归一化)。
 *
 * new-api 的格式转换大多输出标准值,但逆向/经销商渠道(本身又是别家的代理)会把
 * 上游原生 stop reason 原样漏出来:Anthropic 的 end_turn / stop_sequence、Gemini 的
 * 大写 STOP / MAX_TOKENS / SAFETY / RECITATION、tool_use 等。客户端 SDK 按 OpenAI
 * 标准集 switch-case 时,非标值要么被当 unknown 吞掉(重试逻辑失灵),要么直接炸
 * (强类型枚举)。
 *
 * 只对 OpenAI 兼容面(/v1/chat/completions)归一;native 面(/v1/messages、/v1beta)
 * 一个字节不动 —— native 透传的意义就是原汁原味(对齐 OpenRouter:兼容面归一,
 * native 面直通)。
 *
 * 归一目标集 = OpenAI 标准 + 本代理的流中断约定:
 *   stop / length / tool_calls / function_call / content_filter / error
 * 未知值【保留原样】不销毁信息(宁可客户端见到怪值,不可把语义改错)。
 */

const CANONICAL = new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter', 'error']);

/** 各家漏出来的已知别名(全部小写比较)。 */
const ALIASES: Record<string, string> = {
    // Anthropic
    end_turn: 'stop',
    stop_sequence: 'stop',
    tool_use: 'tool_calls',
    // Gemini(FinishReason 枚举,上游常大写;先 toLowerCase 再查)
    max_tokens: 'length',
    safety: 'content_filter',
    recitation: 'content_filter',
    blocklist: 'content_filter',
    prohibited_content: 'content_filter',
    spii: 'content_filter',
    image_safety: 'content_filter',
    // 杂牌中继见过的口语值
    complete: 'stop',
    completed: 'stop',
    done: 'stop',
    finished: 'stop',
    max_output_tokens: 'length',
};

/** 单值归一:标准值/空值原样;大小写归一;已知别名映射;未知值原样保留。 */
export function normalizeFinishReason(v: unknown): unknown {
    if (typeof v !== 'string' || v === '') return v; // null(流中未结束)/非字符串 → 原样
    if (CANONICAL.has(v)) return v;
    const lower = v.toLowerCase();
    if (CANONICAL.has(lower)) return lower; // STOP → stop
    return ALIASES[lower] ?? v;
}

/** 就地归一 choices[].finish_reason;返回是否有改动。(gpt-4o-image 等自组装分支也用) */
export function normalizeChoices(obj: Record<string, unknown>): boolean {
    const choices = obj.choices;
    if (!Array.isArray(choices)) return false;
    let changed = false;
    for (const c of choices) {
        if (c && typeof c === 'object' && 'finish_reason' in c) {
            const rec = c as Record<string, unknown>;
            const n = normalizeFinishReason(rec.finish_reason);
            if (n !== rec.finish_reason) {
                rec.finish_reason = n;
                changed = true;
            }
        }
    }
    return changed;
}

/** 重写一个完整 SSE 事件(不含结尾空行)。无 finish_reason / 解析失败 → 原样返回。
 *  CRLF 框架的行在 split('\n') 后带尾 \r —— 重写行要把 \r 补回,别混框架。 */
function rewriteEvent(evt: string): string {
    if (!evt.includes('finish_reason')) return evt;
    return evt
        .split('\n')
        .map((line) => {
            if (!line.startsWith('data:')) return line;
            const hadCr = line.endsWith('\r');
            const payload = line.slice(5).trim();
            if (payload === '[DONE]' || !payload.includes('finish_reason')) return line;
            try {
                const j = JSON.parse(payload) as Record<string, unknown>;
                return normalizeChoices(j) ? 'data: ' + JSON.stringify(j) + (hadCr ? '\r' : '') : line;
            } catch {
                return line; // 坏 JSON 原样透传,不试图修
            }
        })
        .join('\n');
}

/** 事件边界:\n\n 或 \r\n\r\n(SSE 规范两种都合法;\r\n\r\n 内不含 \n\n,二者不重叠)。
 *  纯 \r 行结束符(古 Mac)规范也允许,但现实上游不存在,不支持。 */
const EVENT_BOUNDARY = /\r\n\r\n|\n\n/g;

/** SSE 流按事件边界缓冲重组:含 finish_reason 的事件解析重写,其余字节(含各事件
 *  自己的分隔符)原样。上游 read 错误照常向外传播(中断语义由外层 stream-guard 负责)。 */
function normalizeSseStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    const enc = new TextEncoder();
    let buf = '';
    /** 取出 buf 里所有完整事件(带各自原分隔符)重写拼接;残尾留在 buf。 */
    const drain = (): string => {
        let out = '';
        let i = 0;
        for (;;) {
            EVENT_BOUNDARY.lastIndex = i;
            const m = EVENT_BOUNDARY.exec(buf);
            if (!m) break;
            out += rewriteEvent(buf.slice(i, m.index)) + m[0];
            i = m.index + m[0].length;
        }
        buf = buf.slice(i);
        return out;
    };
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            // ⚠️ 必须循环读到「至少 enqueue 一次」才返回:enqueue-less pull 只会被
            // streams 机制自动重拉一次,连续两次空手而归 → 外层流永久挂死(评审实测;
            // 事件跨 ≥3 个 read chunk、或 CRLF 框架配老实现,都会触发)。
            for (;;) {
                const { value, done } = await reader.read();
                if (done) {
                    buf += dec.decode(); // flush 解码器残留的半个多字节字符
                    const out = drain() + (buf ? rewriteEvent(buf) : '');
                    buf = '';
                    if (out) controller.enqueue(enc.encode(out));
                    controller.close();
                    return;
                }
                buf += dec.decode(value, { stream: true });
                const out = drain();
                if (out) {
                    controller.enqueue(enc.encode(out));
                    return;
                }
            }
        },
        cancel(reason) {
            return reader.cancel(reason).catch(() => {});
        },
    });
}

/**
 * OpenAI 兼容响应的 finish_reason 归一入口:
 *  - 2xx + SSE → 按事件重写(流式);
 *  - 2xx + JSON → 整体解析重写(非流式);无改动时原字节返回;
 *  - 其余(错误响应 / 未知 content-type / 无 body)原样。
 */
export async function normalizeOpenAiResponse(upstream: Response): Promise<Response> {
    if (!upstream.ok || !upstream.body) return upstream;
    const ct = upstream.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
        return new Response(normalizeSseStream(upstream.body), {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: upstream.headers,
        });
    }
    if (ct.includes('application/json')) {
        const raw = await upstream.text();
        let out = raw;
        try {
            const j = JSON.parse(raw) as Record<string, unknown>;
            if (normalizeChoices(j)) out = JSON.stringify(j);
        } catch {
            /* 非 JSON 实体,原样 */
        }
        return new Response(out, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: upstream.headers, // content-length 由下游 passthrough/capture 剥掉重算
        });
    }
    return upstream;
}
