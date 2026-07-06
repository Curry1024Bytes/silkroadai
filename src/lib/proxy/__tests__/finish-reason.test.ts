/**
 * finish_reason 归一单测(lib/proxy/finish-reason.ts)。
 * 契约:标准值/未知值/空值原样;已知别名(含大小写)映射;无改动时字节级不变。
 */
import { describe, expect, it } from 'vitest';
import { normalizeFinishReason, normalizeOpenAiResponse } from '../finish-reason';

describe('normalizeFinishReason — 单值映射', () => {
    it.each([
        // 标准值原样
        ['stop', 'stop'],
        ['length', 'length'],
        ['tool_calls', 'tool_calls'],
        ['content_filter', 'content_filter'],
        ['error', 'error'], // 本代理流中断约定,不能被映射掉
        // 大小写归一
        ['STOP', 'stop'],
        ['LENGTH', 'length'],
        // Anthropic 漏出
        ['end_turn', 'stop'],
        ['stop_sequence', 'stop'],
        ['tool_use', 'tool_calls'],
        // Gemini 漏出(枚举常大写)
        ['MAX_TOKENS', 'length'],
        ['max_tokens', 'length'],
        ['SAFETY', 'content_filter'],
        ['RECITATION', 'content_filter'],
        ['PROHIBITED_CONTENT', 'content_filter'],
        ['IMAGE_SAFETY', 'content_filter'],
        // 杂牌中继口语值
        ['completed', 'stop'],
        ['done', 'stop'],
    ])('%s → %s', (input, expected) => {
        expect(normalizeFinishReason(input)).toBe(expected);
    });

    it('null / 空串 / 非字符串 → 原样(流中 null 合法)', () => {
        expect(normalizeFinishReason(null)).toBeNull();
        expect(normalizeFinishReason(undefined)).toBeUndefined();
        expect(normalizeFinishReason('')).toBe('');
        expect(normalizeFinishReason(42)).toBe(42);
    });

    it('未知值保留原样(不销毁信息)', () => {
        expect(normalizeFinishReason('weird_vendor_reason')).toBe('weird_vendor_reason');
    });
});

function sseResponse(body: string | ReadableStream<Uint8Array>): Response {
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function jsonResponse(body: string, status = 200): Response {
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

describe('normalizeOpenAiResponse — 非流式 JSON', () => {
    it('end_turn → stop(多 choice 各自归一)', async () => {
        const raw = JSON.stringify({
            id: 'chatcmpl-1',
            choices: [
                { index: 0, message: { content: 'a' }, finish_reason: 'end_turn' },
                { index: 1, message: { content: 'b' }, finish_reason: 'MAX_TOKENS' },
            ],
        });
        const res = await normalizeOpenAiResponse(jsonResponse(raw));
        const j = (await res.json()) as { choices: Array<{ finish_reason: string }> };
        expect(j.choices[0].finish_reason).toBe('stop');
        expect(j.choices[1].finish_reason).toBe('length');
    });

    it('标准值 → 字节级不变(不重排 JSON key)', async () => {
        const raw = '{"choices":[{"finish_reason":"stop","index":0}],"zzz":1,"aaa":2}';
        const res = await normalizeOpenAiResponse(jsonResponse(raw));
        expect(await res.text()).toBe(raw);
    });

    it('非 JSON 实体 / 无 choices → 原样;非 2xx → 原对象不碰', async () => {
        const bad = jsonResponse('not-json{', 200);
        expect(await (await normalizeOpenAiResponse(bad)).text()).toBe('not-json{');
        const err = jsonResponse('{"error":{}}', 502);
        expect(await normalizeOpenAiResponse(err)).toBe(err); // 同一个对象
    });
});

async function readAll(rs: ReadableStream<Uint8Array>): Promise<string> {
    const reader = rs.getReader();
    const dec = new TextDecoder();
    let out = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) return out;
        out += dec.decode(value, { stream: true });
    }
}

describe('normalizeOpenAiResponse — SSE 流式', () => {
    it('chunk 里的 STOP → stop;标准 chunk 与 [DONE] 字节不变', async () => {
        const sse =
            'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"STOP"}]}\n\n' +
            'data: [DONE]\n\n';
        const res = await normalizeOpenAiResponse(sseResponse(sse));
        const text = await readAll(res.body!);
        expect(text).toContain('"finish_reason":"stop"');
        expect(text).not.toContain('STOP');
        // 无 finish_reason 改动的行原样
        expect(text).toContain('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}');
        expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    });

    it('全标准流 → 整体字节级不变', async () => {
        const sse =
            'data: {"choices":[{"delta":{"content":"a"},"finish_reason":null}]}\n\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
        const res = await normalizeOpenAiResponse(sseResponse(sse));
        expect(await readAll(res.body!)).toBe(sse);
    });

    it('事件跨 chunk 切断 → 重组后仍正确重写', async () => {
        const enc = new TextEncoder();
        const parts = ['data: {"choices":[{"delta":{},"finish_re', 'ason":"end_turn"}]}\n\ndata: [DONE]\n\n'];
        const stream = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(enc.encode(parts[0]));
                c.enqueue(enc.encode(parts[1]));
                c.close();
            },
        });
        const text = await readAll((await normalizeOpenAiResponse(sseResponse(stream))).body!);
        expect(text).toContain('"finish_reason":"stop"');
        expect(text).not.toContain('end_turn');
    });

    it('坏 JSON data 行(含 finish_reason 字样)→ 原样透传不试图修', async () => {
        const sse = 'data: {"finish_reason": broken\n\ndata: [DONE]\n\n';
        const text = await readAll((await normalizeOpenAiResponse(sseResponse(sse))).body!);
        expect(text).toBe(sse);
    });

    it('结尾无空行封口的残事件 → flush 时也重写', async () => {
        const sse = 'data: {"choices":[{"delta":{},"finish_reason":"end_turn"}]}';
        const text = await readAll((await normalizeOpenAiResponse(sseResponse(sse))).body!);
        expect(text).toContain('"finish_reason":"stop"');
    });

    it('CRLF 框架(\\r\\n\\r\\n 事件边界)→ 照常按事件流出 + 重写,分隔符原样保留', async () => {
        const sse =
            'data: {"choices":[{"delta":{"content":"a"},"finish_reason":null}]}\r\n\r\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"MAX_TOKENS"}]}\r\n\r\n' +
            'data: [DONE]\r\n\r\n';
        const res = await normalizeOpenAiResponse(sseResponse(sse));
        const text = await readAll(res.body!);
        expect(text).toContain('"finish_reason":"length"');
        expect(text).not.toContain('MAX_TOKENS');
        // 未改写事件 + 分隔符字节原样;改写行补回 \r 不混框架
        expect(text).toContain('data: {"choices":[{"delta":{"content":"a"},"finish_reason":null}]}\r\n\r\n');
        expect(text).toContain('"finish_reason":"length"}]}\r\n\r\n');
        expect(text.endsWith('data: [DONE]\r\n\r\n')).toBe(true);
    });

    it('事件跨 ≥3 个 chunk / 上游不关流 → 事件一凑齐立刻流出,不死锁不等收流', async () => {
        const enc = new TextEncoder();
        let push!: (s: string) => void;
        const stream = new ReadableStream<Uint8Array>({
            start(c) {
                push = (s: string) => c.enqueue(enc.encode(s));
            },
        });
        const res = await normalizeOpenAiResponse(sseResponse(stream));
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        // 一个事件切成 3 片(前两次 read 攒不出完整事件 —— 老实现 pull 空手而归两次
        // 就永久挂死),上游【不】close
        push('data: {"choices":[{"delta":{},"finish_re');
        push('ason":"end_turn"');
        push('}]}\n\n');
        const { value } = await reader.read(); // 死锁回归时这里挂死 → 测试超时红
        expect(dec.decode(value)).toContain('"finish_reason":"stop"');
        await reader.cancel();
    });

    it('上游 read 错误照常向外传播(中断语义留给 stream-guard)', async () => {
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
                setTimeout(() => c.error(new Error('boom')), 0);
            },
        });
        const res = await normalizeOpenAiResponse(sseResponse(stream));
        await expect(readAll(res.body!)).rejects.toThrow('boom');
    });
});
