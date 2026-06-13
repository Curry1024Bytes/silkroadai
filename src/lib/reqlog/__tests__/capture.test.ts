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
vi.mock('@/lib/r2/log-store', () => ({
    isLogStoreConfigured: () => logStoreConfigured,
    putLogObject: vi.fn(),
    reqlogInputKey: (id: string) => `reqlog/in/${id}`,
    reqlogOutputKey: (id: string) => `reqlog/out/${id}`,
}));

import { shouldCapture, parseUsage, parseModelAndStream } from '@/lib/reqlog/capture';

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
