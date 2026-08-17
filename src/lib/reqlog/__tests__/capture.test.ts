/**
 * 数据存储 Phase 1 第②步 — 捕获模块纯函数单测。
 *
 * 覆盖 shouldCapture(开关 / 存储就绪 / 采样语义)、parseUsage(OpenAI 非流式 /
 * OpenAI SSE / Anthropic SSE / responses / 垃圾)、parseModelAndStream。
 * route 级集成(tee / 直捕 / 断开 / best-effort)在 proxy-capture.test.ts。
 *
 * 注:mock @/lib/r2/log-store 的 isLogStoreConfigured(shouldCapture 依赖它)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let logStoreConfigured = true;
// 背压测试要挂起 put:impl 可替换,默认立即 resolve
let putImpl: () => Promise<void> = async () => {};
// 大体上限测试要断言"输入那次 put 根本没发生" → 记下每次 put 的 key
const putKeys: string[] = [];
vi.mock('@/lib/r2/log-store', () => ({
    isLogStoreConfigured: () => logStoreConfigured,
    putLogObject: (key: string) => {
        putKeys.push(key);
        return putImpl();
    },
    reqlogInputKey: (id: string) => `reqlog/in/${id}`,
    reqlogOutputKey: (id: string) => `reqlog/out/${id}`,
}));

// finalizeCapture 懒加载的两个模块(背压测试驱动真 finalize,不能触真 prisma)
// create 的入参留档,供大体上限用例断言落库的元数据。
const prismaCreates: Array<Record<string, unknown>> = [];
vi.mock('@/lib/db', () => ({
    prisma: {
        requestLog: {
            create: async (args: { data: Record<string, unknown> }) => {
                prismaCreates.push(args.data);
                return {};
            },
        },
    },
}));
vi.mock('@/lib/reqlog/identity', () => ({
    resolveLogIdentity: async () => ({
        user_id: null,
        token_id: null,
        tenant_id: null,
        newapi_token_hash: null,
    }),
}));

import { NextRequest } from 'next/server';
import {
    shouldCapture,
    parseUsage,
    parseModelAndStream,
    beginCapture,
    captureJsonResponse,
    recordRequestBody,
    __flushReqlogForTest,
    __resetReqlogBackpressureForTest,
} from '@/lib/reqlog/capture';

beforeEach(() => {
    logStoreConfigured = true;
    delete process.env.REQUEST_LOGGING;
    delete process.env.REQUEST_LOGGING_SAMPLE_RATE;
});
afterEach(() => {
    delete process.env.REQUEST_LOGGING;
    delete process.env.REQUEST_LOGGING_SAMPLE_RATE;
    vi.restoreAllMocks();
});

describe('shouldCapture', () => {
    it('off when REQUEST_LOGGING unset (fail-closed default)', () => {
        expect(shouldCapture()).toBe(false);
    });

    it('off when REQUEST_LOGGING != "on"', () => {
        process.env.REQUEST_LOGGING = 'true'; // 只有恰好 "on" 才开
        expect(shouldCapture()).toBe(false);
    });

    it('on when REQUEST_LOGGING=on + log store configured + default sample 1', () => {
        process.env.REQUEST_LOGGING = 'on';
        expect(shouldCapture()).toBe(true);
    });

    it('off when log store not configured even if REQUEST_LOGGING=on (storage-ready probe)', () => {
        process.env.REQUEST_LOGGING = 'on';
        logStoreConfigured = false;
        expect(shouldCapture()).toBe(false);
    });

    it('off when sample rate 0 (never sampled)', () => {
        process.env.REQUEST_LOGGING = 'on';
        process.env.REQUEST_LOGGING_SAMPLE_RATE = '0';
        // Math.random() ∈ [0,1) 永远不 < 0
        for (let i = 0; i < 20; i++) expect(shouldCapture()).toBe(false);
    });

    it('always on when sample rate 1', () => {
        process.env.REQUEST_LOGGING = 'on';
        process.env.REQUEST_LOGGING_SAMPLE_RATE = '1';
        for (let i = 0; i < 20; i++) expect(shouldCapture()).toBe(true);
    });

    it('respects fractional sample rate via Math.random', () => {
        process.env.REQUEST_LOGGING = 'on';
        process.env.REQUEST_LOGGING_SAMPLE_RATE = '0.5';
        vi.spyOn(Math, 'random').mockReturnValue(0.4);
        expect(shouldCapture()).toBe(true);
        vi.spyOn(Math, 'random').mockReturnValue(0.6);
        expect(shouldCapture()).toBe(false);
    });

    it('garbage sample rate falls back to 1 (capture)', () => {
        process.env.REQUEST_LOGGING = 'on';
        process.env.REQUEST_LOGGING_SAMPLE_RATE = 'abc';
        expect(shouldCapture()).toBe(true);
    });
});

describe('parseModelAndStream', () => {
    it('extracts model + stream flag', () => {
        expect(parseModelAndStream('{"model":"gpt-5.4","stream":true}')).toEqual({ model: 'gpt-5.4', streamed: true });
        expect(parseModelAndStream('{"model":"claude-opus-4-8"}')).toEqual({
            model: 'claude-opus-4-8',
            streamed: false,
        });
    });
    it('garbage → null model, not streamed', () => {
        expect(parseModelAndStream('not json')).toEqual({ model: null, streamed: false });
        expect(parseModelAndStream('{"foo":1}')).toEqual({ model: null, streamed: false });
    });
});

describe('parseUsage', () => {
    it('OpenAI non-streaming JSON usage', () => {
        const body = JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 34 } });
        expect(parseUsage(body, 'application/json')).toEqual({ inputTokens: 12, outputTokens: 34 });
    });

    it('OpenAI SSE final chunk carries usage', () => {
        const sse =
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}}\n\n' +
            'data: [DONE]\n\n';
        expect(parseUsage(sse, 'text/event-stream')).toEqual({ inputTokens: 5, outputTokens: 7 });
    });

    it('OpenAI responses API: usage under .response', () => {
        const sse =
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":20,"output_tokens":9}}}\n\n';
        expect(parseUsage(sse, 'text/event-stream')).toEqual({ inputTokens: 20, outputTokens: 9 });
    });

    it('Anthropic SSE: message_start input + message_delta output (takes max output)', () => {
        const sse =
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n' +
            'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n';
        expect(parseUsage(sse, 'text/event-stream')).toEqual({ inputTokens: 100, outputTokens: 42 });
    });

    it('no usage anywhere → null/null', () => {
        expect(parseUsage('data: {"choices":[{"delta":{}}]}\n\n', 'text/event-stream')).toEqual({
            inputTokens: null,
            outputTokens: null,
        });
    });

    it('non-JSON body (e.g. error html / binary) → null/null, never throws', () => {
        expect(parseUsage('<html>500</html>', 'text/html')).toEqual({ inputTokens: null, outputTokens: null });
        expect(parseUsage('', null)).toEqual({ inputTokens: null, outputTokens: null });
    });
});

describe('backpressure (REQUEST_LOGGING_MAX_PENDING)', () => {
    const makeReq = () =>
        new NextRequest('https://ai.silkroadai.io/v1/messages', {
            method: 'POST',
            headers: { authorization: 'Bearer sk-TESTKEY' },
        });
    // 共享 gate:put 全部挂在同一个 promise 上,openGate() 对已发出和未来的
    // put 一起放行(finalize 到达 putLogObject 的时机晚于测试同步代码,
    // 逐个 resolver 收集会在放行后才出现 → 永远排不干)
    let openGate: () => void;
    let gate: Promise<void>;

    beforeEach(() => {
        process.env.REQUEST_LOGGING = 'on';
        process.env.REQUEST_LOGGING_MAX_PENDING = '3';
        gate = new Promise<void>((r) => {
            openGate = r;
        });
        putImpl = () => gate;
        __resetReqlogBackpressureForTest();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(async () => {
        // 排干挂着的 finalize,不让 pending 泄漏到别的用例
        openGate();
        await __flushReqlogForTest();
        putImpl = async () => {};
        delete process.env.REQUEST_LOGGING_MAX_PENDING;
    });

    it('drops capture when pending finalizes hit the limit, recovers after drain', async () => {
        for (let i = 0; i < 3; i++) {
            const cap = beginCapture(makeReq(), '/messages');
            expect(cap).not.toBeNull();
            captureJsonResponse(cap!, 200, { i });
        }
        // 3 个 finalize 全挂在 R2 put 上 → 第 4 个直接丢(返 null,零 buffer)
        expect(beginCapture(makeReq(), '/messages')).toBeNull();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('backlog full'));
        // 放行 + 排干 → 恢复捕获
        openGate();
        await __flushReqlogForTest();
        expect(beginCapture(makeReq(), '/messages')).not.toBeNull();
    });

    it('garbage / unset limit falls back to default 100 (small backlog never drops)', () => {
        process.env.REQUEST_LOGGING_MAX_PENDING = 'abc';
        const cap = beginCapture(makeReq(), '/messages');
        expect(cap).not.toBeNull();
        captureJsonResponse(cap!, 200, {});
        // 1 pending < 默认 100 → 不丢
        expect(beginCapture(makeReq(), '/messages')).not.toBeNull();
    });

    it('drop warn is rate-limited (first + every 500th), not one per drop', () => {
        for (let i = 0; i < 3; i++) {
            const cap = beginCapture(makeReq(), '/messages');
            captureJsonResponse(cap!, 200, { i });
        }
        for (let i = 0; i < 10; i++) expect(beginCapture(makeReq(), '/messages')).toBeNull();
        expect(vi.mocked(console.warn).mock.calls.filter((c) => String(c[0]).includes('backlog full'))).toHaveLength(1);
    });
});

describe('large request body cap (REQUEST_LOGGING_MAX_INPUT_BYTES)', () => {
    const makeReq = () =>
        new NextRequest('https://ai.silkroadai.io/v1/messages', {
            method: 'POST',
            headers: { authorization: 'Bearer sk-TESTKEY' },
        });
    const newCap = () => {
        const cap = beginCapture(makeReq(), '/messages');
        expect(cap).not.toBeNull();
        return cap!;
    };

    beforeEach(() => {
        process.env.REQUEST_LOGGING = 'on';
        putKeys.length = 0;
        prismaCreates.length = 0;
    });
    afterEach(() => {
        delete process.env.REQUEST_LOGGING_MAX_INPUT_BYTES;
    });

    it('keeps the body when under the limit', () => {
        process.env.REQUEST_LOGGING_MAX_INPUT_BYTES = '100';
        const cap = newCap();
        recordRequestBody(cap, '{"model":"claude-opus-4-8"}', 'claude-opus-4-8', false);
        expect(cap.requestBody).toBe('{"model":"claude-opus-4-8"}');
        expect(cap.inputBytes).toBe(27);
        expect(cap.errorParts).toEqual([]);
    });

    it('drops the body over the limit but keeps true byte count + model + stream flag', () => {
        process.env.REQUEST_LOGGING_MAX_INPUT_BYTES = '10';
        const cap = newCap();
        recordRequestBody(cap, 'x'.repeat(5000), 'claude-opus-4-8', true);
        expect(cap.requestBody).toBeNull(); // 不攥住大字符串 = 背压队列内存有上界
        expect(cap.inputBytes).toBe(5000); // 元数据仍是真实字节数
        expect(cap.model).toBe('claude-opus-4-8');
        expect(cap.streamedRequested).toBe(true);
        expect(cap.errorParts).toEqual(['in-too-large:5000>10']);
    });

    it('multi-byte chars count as bytes, not chars (limit is a memory bound)', () => {
        process.env.REQUEST_LOGGING_MAX_INPUT_BYTES = '10';
        const cap = newCap();
        recordRequestBody(cap, '中'.repeat(5), null, false); // 5 字 = 15 字节 > 10
        expect(cap.inputBytes).toBe(15);
        expect(cap.requestBody).toBeNull();
    });

    it('garbage / unset limit falls back to the 2MB default', () => {
        process.env.REQUEST_LOGGING_MAX_INPUT_BYTES = 'abc';
        const under = newCap();
        recordRequestBody(under, 'x'.repeat(1024 * 1024), null, false); // 1MB < 2MB
        expect(under.requestBody).not.toBeNull();

        delete process.env.REQUEST_LOGGING_MAX_INPUT_BYTES;
        const over = newCap();
        recordRequestBody(over, 'x'.repeat(3 * 1024 * 1024), null, false); // 3MB > 2MB
        expect(over.requestBody).toBeNull();
    });

    it('oversized body → no input R2 put, row still written with input_bytes + error mark', async () => {
        process.env.REQUEST_LOGGING_MAX_INPUT_BYTES = '10';
        const cap = newCap();
        recordRequestBody(cap, 'x'.repeat(5000), 'claude-opus-4-8', false);
        captureJsonResponse(cap, 200, { ok: true });
        await __flushReqlogForTest();

        expect(putKeys.filter((k) => k.startsWith('reqlog/in/'))).toHaveLength(0); // 输入没上传
        expect(putKeys.filter((k) => k.startsWith('reqlog/out/'))).toHaveLength(1); // 输出照常
        expect(prismaCreates).toHaveLength(1);
        const row = prismaCreates[0];
        expect(row.input_r2_key).toBeNull();
        expect(row.input_bytes).toBe(5000);
        expect(row.model).toBe('claude-opus-4-8');
        expect(String(row.error)).toContain('in-too-large');
    });
});
