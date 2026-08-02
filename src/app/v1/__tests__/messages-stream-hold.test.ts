/**
 * /v1/messages 流式持头转发(根治件①)+ 失败流自动退款调度(件②接线)测试。
 *
 * Mock:global.fetch(上游 new-api)+ stream-fail-refund(只验调度参数,退款主流程
 * 在 stream-fail-refund.test.ts 单测)。经 route.ts 的 POST dispatch 全链路驱动。
 * 断言:正常流零损转发、ping→error 假 200 被翻成重试→真 502、重试成功透明、
 * 持头超时退化、非流式/非 2xx 原样、退款调度带对 request_id。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// route.ts 的重依赖 mock(与 proxy.test.ts 同套,精简到本文件触发的路径)
vi.mock('@/lib/r2/client', () => ({ uploadImage: vi.fn() }));
vi.mock('@/lib/oss/store', () => ({
    resolveUserIdFromAuthHeader: vi.fn(async () => null),
    getOssConfig: vi.fn(async () => null),
}));
vi.mock('@/lib/oss/client', () => ({
    uploadToCustomerOss: vi.fn(),
    objectExistsInOss: vi.fn(),
    ossPublicUrl: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        newApiToken: { findUnique: vi.fn() },
        catalogModel: { findMany: vi.fn(async () => []) },
        imageTask: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(async () => null) },
        seedanceVideoTask: { findUnique: async () => null },
    },
}));
vi.mock('@/lib/billing/customer-balance', () => ({ getCustomerBalance: vi.fn() }));
vi.mock('@/lib/channel-group', () => ({
    listEnabledChannelGroups: vi.fn(async () => []),
    restrictGroupsForUser: <T>(g: T[]) => g,
}));
vi.mock('@/lib/newapi/token-usage', () => ({ getTokenUsageWithCache: vi.fn() }));
vi.mock('@/lib/newapi/client', () => ({ queryLogs: vi.fn() }));

const mockScheduleRefund = vi.fn();
vi.mock('@/lib/billing/stream-fail-refund', () => ({
    scheduleStreamFailRefund: (...a: unknown[]) => mockScheduleRefund(...a),
}));

import { POST } from '../[...path]/route';

function sseResponse(events: string[], headers: Record<string, string> = {}): Response {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const e of events) controller.enqueue(enc.encode(e));
            controller.close();
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-oneapi-request-id': 'RID-TEST', ...headers },
    });
}

/** 永不主动结束的 SSE 流(测持头期间行为);返回可控 controller。 */
function hangingSse(initialEvents: string[]): Response {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const e of initialEvents) controller.enqueue(enc.encode(e));
            // 不 close —— 挂着
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-oneapi-request-id': 'RID-HANG' },
    });
}

const PING = 'event: ping\ndata: {"type": "ping"}\n\n';
const MESSAGE_START =
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10}}}\n\n';
const CONTENT = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n';
const STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const ERROR_EVT = 'data: {"error":{"type":"upstream_error","message":"Upstream request failed"},"type":"error"}\n\n';

function makeReq(body: unknown): NextRequest {
    return new NextRequest('https://ai.silkroadai.io/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-cust' },
        body: JSON.stringify(body),
    });
}
const ctx = { params: Promise.resolve({ path: ['messages'] }) };
const STREAM_BODY = { model: 'claude-opus-4-8', stream: true, max_tokens: 100, messages: [] };

const mockFetch = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch as typeof fetch;
});

async function readAll(res: Response): Promise<string> {
    return await new Response(res.body).text();
}

describe('/v1/messages 持头转发 — 正常流', () => {
    it('message_start 立即到 → 200 转发,字节零损(含前置 ping),不调度退款', async () => {
        mockFetch.mockResolvedValueOnce(sseResponse([PING, MESSAGE_START, CONTENT, STOP]));
        const res = await POST(makeReq(STREAM_BODY), ctx);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        const text = await readAll(res);
        expect(text).toContain('message_start');
        expect(text).toContain('content_block_delta');
        expect(text.indexOf('ping')).toBeLessThan(text.indexOf('message_start')); // 缓冲原样回放
        expect(mockScheduleRefund).not.toHaveBeenCalled();
        expect(res.headers.get('X-Silkroadai-Stream-Failover')).toBeNull();
    });

    it('非流式请求 → 原样透传(JSON 直返)', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ id: 'msg_1', usage: { input_tokens: 1, output_tokens: 2 } }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const res = await POST(makeReq({ ...STREAM_BODY, stream: false }), ctx);
        expect(res.status).toBe(200);
        const j = (await res.json()) as { id: string };
        expect(j.id).toBe('msg_1');
        expect(mockScheduleRefund).not.toHaveBeenCalled();
    });

    it('上游非 2xx → 真实状态码原样透传,不持头不重试', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit', message: 'slow down' } }), {
                status: 429,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const res = await POST(makeReq(STREAM_BODY), ctx);
        expect(res.status).toBe(429);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

describe('/v1/messages 持头转发 — 失败流补救', () => {
    it('ping→error(假 200)→ 调度退款 + 重试;重试成功 → 客户拿到干净 200 流 + failover 头', async () => {
        mockFetch
            .mockResolvedValueOnce(sseResponse([PING, PING, ERROR_EVT]))
            .mockResolvedValueOnce(sseResponse([MESSAGE_START, CONTENT, STOP], { 'x-oneapi-request-id': 'RID-2' }));
        const res = await POST(makeReq(STREAM_BODY), ctx);
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Silkroadai-Stream-Failover')).toBe('attempt=2');
        const text = await readAll(res);
        expect(text).toContain('message_start');
        expect(text).not.toContain('upstream_error'); // 失败首次尝试的字节不进客户流
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockScheduleRefund).toHaveBeenCalledTimes(1);
        expect(mockScheduleRefund).toHaveBeenCalledWith(
            expect.objectContaining({
                upstreamRequestId: 'RID-TEST',
                rawAuth: 'sk-cust',
                model: 'claude-opus-4-8',
            }),
        );
    });

    it('两次都失败 → 真 502 Anthropic error JSON + 两次退款调度,绝不返回假 200', async () => {
        mockFetch
            .mockResolvedValueOnce(sseResponse([PING, ERROR_EVT]))
            .mockResolvedValueOnce(sseResponse([PING, ERROR_EVT], { 'x-oneapi-request-id': 'RID-B' }));
        const res = await POST(makeReq(STREAM_BODY), ctx);
        expect(res.status).toBe(502);
        expect(res.headers.get('X-Silkroadai-Stream-Failover')).toBe('exhausted=2');
        const j = (await res.json()) as { type: string; error: { type: string } };
        expect(j.type).toBe('error');
        expect(mockScheduleRefund).toHaveBeenCalledTimes(2);
        expect(mockScheduleRefund).toHaveBeenNthCalledWith(2, expect.objectContaining({ upstreamRequestId: 'RID-B' }));
    });

    it('流无 error 事件直接 done(死流)→ 同样按失败补救', async () => {
        mockFetch
            .mockResolvedValueOnce(sseResponse([PING])) // close 而无实质事件
            .mockResolvedValueOnce(sseResponse([MESSAGE_START, STOP]));
        const res = await POST(makeReq(STREAM_BODY), ctx);
        expect(res.status).toBe(200);
        expect(mockScheduleRefund).toHaveBeenCalledTimes(1);
    });

    it('重试拿到非 2xx → 该真实错误码原样给客户(不再编 502)', async () => {
        mockFetch.mockResolvedValueOnce(sseResponse([ERROR_EVT])).mockResolvedValueOnce(
            new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded', message: 'busy' } }), {
                status: 529,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const res = await POST(makeReq(STREAM_BODY), ctx);
        expect(res.status).toBe(529);
        expect(mockScheduleRefund).toHaveBeenCalledTimes(1);
    });
});

describe('/v1/messages 持头转发 — 持头上限退化', () => {
    it('持头超时(用 env 缩短)→ 退化转发 200 + 已缓冲 ping,不退款不重试', async () => {
        vi.stubEnv('PROXY_MESSAGES_HOLD_MS', '80');
        vi.resetModules();
        // 重新加载模块使 env 生效(HOLD_CAP_MS 是模块常量)
        const { POST: POST2 } = await import('../[...path]/route');
        mockFetch.mockResolvedValueOnce(hangingSse([PING]));
        const res = await POST2(makeReq(STREAM_BODY), ctx);
        expect(res.status).toBe(200);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockScheduleRefund).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
        vi.resetModules();
    });
});
