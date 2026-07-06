/**
 * SSE 流式两件套单元测试(stream-guard.ts)。
 * 用可控上游流 + 真实(小间隔)定时器,不 mock Web Streams。
 */
import { describe, expect, it, vi } from 'vitest';
import { guardSseResponse, guardSseStream } from '../stream-guard';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 手控上游:测试里随时 enqueue / close / error。 */
function controlledUpstream() {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled: unknown = null;
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            ctl = c;
        },
        cancel(reason) {
            cancelled = reason ?? 'cancelled';
        },
    });
    return {
        stream,
        push: (s: string) => ctl.enqueue(enc.encode(s)),
        close: () => ctl.close(),
        error: (e: unknown) => ctl.error(e),
        wasCancelled: () => cancelled,
    };
}

/** 读到 done,返回拼接文本。上游 error 且 shape=null 时会 throw。 */
async function readAll(rs: ReadableStream<Uint8Array>): Promise<string> {
    const reader = rs.getReader();
    let out = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) return out;
        out += dec.decode(value, { stream: true });
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('guardSseStream — 数据透传', () => {
    it('数据原样过 + 上游正常收流 → 干净 close,无注入', async () => {
        const up = controlledUpstream();
        const guarded = guardSseStream(up.stream, { shape: 'openai', label: 't', keepaliveMs: 0 });
        const p = readAll(guarded);
        up.push('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
        up.push('data: [DONE]\n\n');
        up.close();
        const text = await p;
        expect(text).toBe('data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\n');
        expect(text).not.toContain('keep-alive');
    });

    it('客户端 cancel → 传播到上游(不留悬挂 reader)', async () => {
        const up = controlledUpstream();
        const guarded = guardSseStream(up.stream, { shape: 'openai', label: 't', keepaliveMs: 0 });
        const reader = guarded.getReader();
        up.push('data: x\n\n');
        await reader.read();
        await reader.cancel('client gone');
        // reader.cancel 会走 guard 的 cancel → 上游 reader.cancel
        await sleep(10);
        expect(up.wasCancelled()).not.toBeNull();
    });
});

describe('guardSseStream — keep-alive 注释', () => {
    it('上游静默超过 keepaliveMs → 注入 ": keep-alive" 注释(可重复)', async () => {
        const up = controlledUpstream();
        const guarded = guardSseStream(up.stream, { shape: 'openai', label: 't', keepaliveMs: 20 });
        const reader = guarded.getReader();
        up.push('data: first\n\n');
        expect(dec.decode((await reader.read()).value)).toContain('first');
        // 静默 >2 个间隔 → 至少 2 条注释
        const c1 = dec.decode((await reader.read()).value);
        const c2 = dec.decode((await reader.read()).value);
        expect(c1).toBe(': keep-alive\n\n');
        expect(c2).toBe(': keep-alive\n\n');
        // 数据恢复后照常透传
        up.push('data: second\n\n');
        expect(dec.decode((await reader.read()).value)).toContain('second');
        up.close();
        expect((await reader.read()).done).toBe(true);
    });

    it('数据持续流动(间隔 < keepaliveMs)→ 不注入注释', async () => {
        const up = controlledUpstream();
        const guarded = guardSseStream(up.stream, { shape: 'openai', label: 't', keepaliveMs: 500 });
        const p = readAll(guarded);
        for (let i = 0; i < 3; i++) {
            up.push(`data: ${i}\n\n`);
            await sleep(5);
        }
        up.close();
        const text = await p;
        expect(text).not.toContain('keep-alive');
    });

    it('收流后定时器已清(vi.getTimerCount()===0,不泄漏、不钉住进程)', async () => {
        vi.useFakeTimers();
        try {
            const up = controlledUpstream();
            const guarded = guardSseStream(up.stream, { shape: 'openai', label: 't', keepaliveMs: 1000 });
            const p = readAll(guarded);
            up.push('data: x\n\n');
            up.close();
            await p;
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('上游停在半行(TCP 分段)→ 本轮跳过注入,不把注释拼进 data 行', async () => {
        const up = controlledUpstream();
        const guarded = guardSseStream(up.stream, { shape: 'openai', label: 't', keepaliveMs: 15 });
        const p = readAll(guarded);
        up.push('data: {"choi'); // 半行停住
        await sleep(50); // 跨过 ≥2 个 keepalive 间隔
        up.push('ces":[]}\n\n'); // 补齐
        up.close();
        const text = await p;
        expect(text).not.toContain('keep-alive'); // 半行期间一律不注入
        expect(text).toContain('data: {"choices":[]}\n\n'); // data 行完好
    });

    it('中断发生在半行 → 尾帧前置空行封掉残事件,尾帧独立成帧', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const up = controlledUpstream();
        const guarded = guardSseStream(up.stream, { shape: 'openai', label: 't', keepaliveMs: 0 });
        const p = readAll(guarded);
        up.push('data: {"choi'); // 半行
        await sleep(1); // 让 pull 先消费掉已入队字节(error() 会丢弃未读队列)
        up.error(new Error('boom'));
        const text = await p;
        // 残行被空行封口,尾帧另起一帧(drainSse 等解析器把残帧当 malformed 跳过)
        expect(text).toContain('data: {"choi\n\ndata: {');
        expect(text).toContain('"finish_reason":"error"');
        warn.mockRestore();
    });
});

describe('guardSseStream — 流中断错误事件', () => {
    it('openai 形:已发 chunk + 上游中途死 → 追加 finish_reason:"error" 尾帧 + [DONE],干净收流', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const up = controlledUpstream();
        const guarded = guardSseStream(up.stream, { shape: 'openai', label: 'test-pipe', keepaliveMs: 0 });
        const p = readAll(guarded);
        up.push('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        await sleep(1); // 让 pull 先消费掉已入队字节(error() 会丢弃未读队列)
        up.error(new Error('ECONNRESET'));
        const text = await p; // 不 throw = 干净收流
        expect(text).toContain('partial');
        expect(text).toContain('"finish_reason":"error"');
        expect(text).toContain('"upstream_stream_interrupted"');
        expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
        // 尾帧本身是合法 JSON(客户端 SDK 能解析):取 [DONE] 前最后一条 data 行
        const dataLines = text
            .trim()
            .split('\n')
            .filter((l) => l.startsWith('data:'));
        const tailLine = dataLines[dataLines.length - 2].replace(/^data:\s*/, '');
        const parsed = JSON.parse(tailLine);
        expect(parsed.choices[0].finish_reason).toBe('error');
        expect(parsed.id).toMatch(/^chatcmpl-interrupted-/);
        expect(typeof parsed.created).toBe('number');
        expect(warn).toHaveBeenCalledWith(
            '[sse-guard] upstream stream died mid-stream',
            expect.objectContaining({ label: 'test-pipe' }),
        );
        warn.mockRestore();
    });

    it('anthropic 形:上游中途死 → 追加 event: error(Anthropic 原生错误 JSON)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const up = controlledUpstream();
        const guarded = guardSseStream(up.stream, { shape: 'anthropic', label: 't', keepaliveMs: 0 });
        const p = readAll(guarded);
        up.push('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n');
        await sleep(1); // 让 pull 先消费掉已入队字节(error() 会丢弃未读队列)
        up.error(new Error('boom'));
        const text = await p;
        expect(text).toContain('event: error\n');
        expect(text).toContain('"type":"api_error"');
        expect(text).not.toContain('[DONE]'); // Anthropic 流没有 [DONE] 约定
        warn.mockRestore();
    });

    it('shape=null(未知 SSE 格式)→ 错误照旧向下传播,不注入', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const up = controlledUpstream();
        const guarded = guardSseStream(up.stream, { shape: null, label: 't', keepaliveMs: 0 });
        const p = readAll(guarded);
        up.push('event: response.output_text.delta\ndata: {}\n\n');
        await sleep(1); // 让 pull 先消费掉已入队字节(error() 会丢弃未读队列)
        up.error(new Error('boom'));
        await expect(p).rejects.toThrow('boom');
        warn.mockRestore();
    });
});

describe('guardSseResponse — 便捷封装', () => {
    it('2xx + text/event-stream → body 被守卫(中断注入生效),status/headers 原样', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const up = controlledUpstream();
        const upstream = new Response(up.stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'x-custom': 'kept' },
        });
        const guarded = guardSseResponse(upstream, { shape: 'openai', label: 't', keepaliveMs: 0 });
        expect(guarded.status).toBe(200);
        expect(guarded.headers.get('x-custom')).toBe('kept');
        const p = guarded.text();
        up.push('data: x\n\n');
        await sleep(1); // 让 pull 先消费掉已入队字节(error() 会丢弃未读队列)
        up.error(new Error('boom'));
        expect(await p).toContain('"finish_reason":"error"');
        warn.mockRestore();
    });

    it('JSON 响应(非 SSE)→ 原样返回同一个对象,不包', () => {
        const upstream = new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
        expect(guardSseResponse(upstream, { shape: 'openai', label: 't' })).toBe(upstream);
    });

    it('非 2xx(即使 content-type 是 SSE)→ 原样返回,不包', () => {
        const upstream = new Response('data: err\n\n', {
            status: 502,
            headers: { 'content-type': 'text/event-stream' },
        });
        expect(guardSseResponse(upstream, { shape: 'openai', label: 't' })).toBe(upstream);
    });
});
