/**
 * /v1beta/* native 透传路由测试。
 * 契约:一个字节不改写(native 面原汁原味)、头转发与 /v1 同款、上游不可达 → 502
 * Gemini 形错误、OPTIONS(CORS 预检)转发给 new-api 应答。keep-alive 注入的行为
 * 契约在 stream-guard 单测,这里只测接线不改字节。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// reqlog capture mock:默认关(beginCapture → null,与 prod 开关 off 一致);
// 捕获接线用例里单独开。captureResponse 简化成 body 直传。
const mockBeginCapture = vi.fn((..._a: unknown[]) => null as unknown);
const mockRecordRequestBody = vi.fn((..._a: unknown[]) => undefined);
const mockIsMediaCaptureSkipped = vi.fn(() => false);
vi.mock('@/lib/reqlog/capture', () => ({
    beginCapture: (...a: unknown[]) => mockBeginCapture(...a),
    recordRequestBody: (...a: unknown[]) => mockRecordRequestBody(...a),
    isMediaCaptureSkipped: () => mockIsMediaCaptureSkipped(),
    captureResponse: (_cap: unknown, upstream: Response) =>
        new Response(upstream.body, { status: upstream.status, headers: upstream.headers }),
    captureJsonResponse: vi.fn(),
}));

import { GET, POST, OPTIONS } from '../[...path]/route';

const NEWAPI_BASE = 'http://localhost:3000';

const mockFetch = vi.fn();
beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch as typeof fetch;
});

function makeReq(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string>; search?: string } = {},
): NextRequest {
    const { method = 'POST', body, headers = {}, search = '' } = init;
    return new NextRequest(`https://ai.silkroadai.io/v1beta${path}${search}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test', ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
}

function ctx(...segments: string[]) {
    return { params: Promise.resolve({ path: segments }) };
}

describe('/v1beta native 透传', () => {
    it('POST generateContent:URL/鉴权头/body 原样转发,响应原样返回', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response('{"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}', {
                status: 200,
                headers: { 'content-type': 'application/json', 'x-oneapi-request-id': 'req-1' },
            }),
        );
        const body = { contents: [{ parts: [{ text: 'hello' }] }] };
        const res = await POST(
            makeReq('/models/gemini-3-pro-image-preview:generateContent', { body }),
            ctx('models', 'gemini-3-pro-image-preview:generateContent'),
        );
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${NEWAPI_BASE}/v1beta/models/gemini-3-pro-image-preview:generateContent`);
        expect((init.headers as Headers).get('authorization')).toBe('Bearer sk-test');
        expect(res.status).toBe(200);
        // native 面一个字节不改写:Gemini 的 finishReason "STOP" 原样保留(不做 OpenAI 归一)
        expect(await res.text()).toBe('{"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}');
        expect(res.headers.get('x-oneapi-request-id')).toBe('req-1');
    });

    it('GET /models + query 原样转发', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response('{"models":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
        );
        const res = await GET(makeReq('/models', { method: 'GET', search: '?pageSize=5' }), ctx('models'));
        const [url] = mockFetch.mock.calls[0] as [string];
        expect(url).toBe(`${NEWAPI_BASE}/v1beta/models?pageSize=5`);
        expect(res.status).toBe(200);
    });

    it('streamGenerateContent SSE:完整流字节级透传(含 native 事件格式)', async () => {
        const sse =
            'data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}]}\r\n\r\n' +
            'data: {"candidates":[{"content":{"parts":[{"text":"b"}]},"finishReason":"STOP"}]}\r\n\r\n';
        mockFetch.mockResolvedValueOnce(
            new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
        const res = await POST(
            makeReq('/models/gemini-3-pro:streamGenerateContent', { body: {}, search: '?alt=sse' }),
            ctx('models', 'gemini-3-pro:streamGenerateContent'),
        );
        const [url] = mockFetch.mock.calls[0] as [string];
        expect(url).toBe(`${NEWAPI_BASE}/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(sse);
    });

    it('上游非 2xx 原样透传(status + body)', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response('{"error":{"code":429,"message":"quota","status":"RESOURCE_EXHAUSTED"}}', { status: 429 }),
        );
        const res = await POST(
            makeReq('/models/gemini-3-pro:generateContent', { body: {} }),
            ctx('models', 'gemini-3-pro:generateContent'),
        );
        expect(res.status).toBe(429);
        expect(await res.text()).toContain('RESOURCE_EXHAUSTED');
    });

    it('上游不可达(fetch throw)→ 502 Gemini 形错误', async () => {
        mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        const res = await POST(
            makeReq('/models/gemini-3-pro:generateContent', { body: {} }),
            ctx('models', 'gemini-3-pro:generateContent'),
        );
        expect(res.status).toBe(502);
        const j = (await res.json()) as { error: { code: number; status: string; message: string } };
        expect(j.error.status).toBe('UNAVAILABLE');
        expect(j.error.message).toContain('ECONNREFUSED');
    });

    it('host / content-length 等 hop-by-hop 头不外泄给上游', async () => {
        mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
        await POST(
            makeReq('/models/gemini-3-pro:generateContent', { body: {} }),
            ctx('models', 'gemini-3-pro:generateContent'),
        );
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const h = init.headers as Headers;
        expect(h.get('host')).toBeNull();
        expect(h.get('content-length')).toBeNull();
    });

    it('OPTIONS(CORS 预检)转发给 new-api,其 Access-Control-* 应答头原样返回', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(null, {
                status: 204,
                headers: {
                    'access-control-allow-origin': '*',
                    'access-control-allow-headers': '*',
                    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
                },
            }),
        );
        const res = await OPTIONS(
            makeReq('/models/gemini-3-pro:generateContent', {
                method: 'OPTIONS',
                headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' },
            }),
            ctx('models', 'gemini-3-pro:generateContent'),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        // 预检不记请求日志
        expect(mockBeginCapture).not.toHaveBeenCalled();
    });
});

describe('/v1beta reqlog 捕获接线', () => {
    it('capture 开:model/streamed 从 URL 解析入档,x-goog-api-key 合成 Bearer 归因', async () => {
        const fakeCap: Record<string, unknown> = { authHeader: null };
        mockBeginCapture.mockReturnValueOnce(fakeCap);
        mockFetch.mockResolvedValueOnce(
            new Response('data: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
        await POST(
            makeReq('/models/gemini-3-pro:streamGenerateContent', {
                body: { contents: [] },
                search: '?alt=sse',
                headers: { authorization: '', 'x-goog-api-key': 'AIza-test-key' },
            }),
            ctx('models', 'gemini-3-pro:streamGenerateContent'),
        );
        expect(mockBeginCapture).toHaveBeenCalledWith(
            expect.anything(),
            '/v1beta/models/gemini-3-pro:streamGenerateContent',
        );
        expect(mockRecordRequestBody).toHaveBeenCalledWith(fakeCap, '{"contents":[]}', 'gemini-3-pro', true);
        expect(fakeCap.authHeader).toBe('Bearer AIza-test-key');
    });

    it('?key= query 鉴权同样归因(Gemini SDK 默认形态)', async () => {
        const fakeCap: Record<string, unknown> = { authHeader: null };
        mockBeginCapture.mockReturnValueOnce(fakeCap);
        mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
        await POST(
            makeReq('/models/gemini-3-pro:generateContent', {
                body: {},
                search: '?key=AIza-query-key',
                headers: { authorization: '' },
            }),
            ctx('models', 'gemini-3-pro:generateContent'),
        );
        expect(fakeCap.authHeader).toBe('Bearer AIza-query-key');
    });

    it('REQUEST_LOGGING_SKIP_MEDIA + image SKU → 整个跳过捕获(大图不进内存不进 R2 log)', async () => {
        mockIsMediaCaptureSkipped.mockReturnValueOnce(true);
        mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
        await POST(
            makeReq('/models/gemini-3-pro-image-preview:generateContent', { body: {} }),
            ctx('models', 'gemini-3-pro-image-preview:generateContent'),
        );
        expect(mockBeginCapture).not.toHaveBeenCalled();
        expect(mockRecordRequestBody).not.toHaveBeenCalled();
    });
});
