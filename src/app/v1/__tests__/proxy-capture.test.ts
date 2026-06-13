/**
 * 数据存储 Phase 1 第②步 — proxy 捕获 route 级集成测试(brief §13 验收)。
 *
 * 覆盖:
 *  - 开关 off:不生成 request_id / 不身份解析 / 不 tee(putLogObject + create 零调用)+ 响应字节不变
 *  - 非流式 chat 直捕:in.json = 客户原始 body(非 clamped)、out.json = 完整响应
 *  - Claude clamp:in.json 存未钳的原始(8192),上游收到钳后的(4096)
 *  - 流式 SSE tee:转发字节逐字不变 + out.json = 重组完整体 + 末尾 usage 解析 + streamed=true
 *  - 客户端断开:incomplete=true + 存已收到部分
 *  - 写存失败(putLogObject reject / create reject)→ 客户响应仍成功(best-effort)
 *  - fail-closed:REQUEST_LOGGING=on 但 log store 未配 → 不捕获、零 SDK 调用
 *  - 采样率 0 → 完全不捕获
 *  - 出口 B(/messages):请求体 buffer + 捕获 + 转发字节不变
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// after() 同步跑回调(单测无请求上下文);保留真 NextRequest/NextResponse
vi.mock('next/server', async (importOriginal) => {
    const actual = await importOriginal<typeof import('next/server')>();
    return { ...actual, after: (fn: () => unknown) => void fn() };
});

// log store:isLogStoreConfigured 可变;putLogObject mock;键用真实纯函数
let logStoreConfigured = true;
const mockPutLogObject = vi.fn(async (_key: string, _body: Buffer | string, _ct?: string) => {});
vi.mock('@/lib/r2/log-store', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/r2/log-store')>();
    return {
        ...actual,
        isLogStoreConfigured: () => logStoreConfigured,
        putLogObject: (k: string, b: Buffer | string, ct?: string) => mockPutLogObject(k, b, ct),
    };
});

// prisma RequestLog.create
const mockCreate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({}));
vi.mock('@/lib/db', () => ({
    prisma: { requestLog: { create: (a: { data: Record<string, unknown> }) => mockCreate(a) } },
}));

// identity:固定返回(身份解析本身在 identity.test 测;这里只验贯穿)
const mockResolveLogIdentity = vi.fn(async (_auth: string | null) => ({
    user_id: 'user-1',
    token_id: 'token-1',
    tenant_id: 'tenant-1',
    newapi_token_hash: 'hash-1',
}));
vi.mock('@/lib/reqlog/identity', () => ({
    resolveLogIdentity: (a: string | null) => mockResolveLogIdentity(a),
    hashToken: (s: string) => `hash(${s})`,
}));

// route 顶层 import 的图像/OSS 依赖(本套测试用不到出图,给空实现避免触真 prisma/S3)
vi.mock('@/lib/r2/client', () => ({
    uploadImage: vi.fn(async (key: string) => `https://images.silkroadai.io/${key}`),
}));
vi.mock('@/lib/oss/store', () => ({
    resolveUserIdFromAuthHeader: vi.fn(async () => null),
    getOssConfig: vi.fn(async () => null),
}));
vi.mock('@/lib/oss/client', () => ({ uploadToCustomerOss: vi.fn(async () => 'https://cdn/x') }));

import { GET, POST } from '../[...path]/route';
import { __flushReqlogForTest } from '@/lib/reqlog/capture';

const NEWAPI_BASE = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';
const mockFetch = vi.fn();

function makeReq(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): NextRequest {
    const { method = 'POST', body, headers = {} } = init;
    return new NextRequest(`https://ai.silkroadai.io/v1${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-TESTKEY', ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
}
function ctx(...segments: string[]) {
    return { params: Promise.resolve({ path: segments }) };
}
function jsonUpstream(obj: unknown, status = 200): Response {
    return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
function sseUpstream(chunks: string[]): Response {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            for (const ch of chunks) c.enqueue(enc.encode(ch));
            c.close();
        },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
/** create 调用的 data payload(便捷取） */
function lastCreateData(): Record<string, unknown> {
    return mockCreate.mock.calls.at(-1)![0].data;
}
/** 找到写 in.json / out.json 的 putLogObject 调用(真实键形如 reqlog/yyyy/mm/dd/{id}.in.json） */
function findPut(kind: 'in' | 'out'): [string, Buffer | string, (string | undefined)?] | undefined {
    return mockPutLogObject.mock.calls.find((c) => String(c[0]).endsWith(`.${kind}.json`)) as
        | [string, Buffer | string, (string | undefined)?]
        | undefined;
}

beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch as typeof fetch;
    logStoreConfigured = true;
    process.env.REQUEST_LOGGING = 'on';
    delete process.env.REQUEST_LOGGING_SAMPLE_RATE;
});
afterEach(() => {
    delete process.env.REQUEST_LOGGING;
    delete process.env.REQUEST_LOGGING_SAMPLE_RATE;
});

describe('开关 off — 字节级零变化 + 零捕获', () => {
    it('REQUEST_LOGGING unset → 不调 putLogObject / create / identity,响应透传不变', async () => {
        delete process.env.REQUEST_LOGGING;
        mockFetch.mockResolvedValueOnce(jsonUpstream({ ok: true, usage: { prompt_tokens: 1, completion_tokens: 2 } }));
        const res = await POST(
            makeReq('/chat/completions', { body: { model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }] } }),
            ctx('chat', 'completions'),
        );
        await __flushReqlogForTest();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, usage: { prompt_tokens: 1, completion_tokens: 2 } });
        expect(mockPutLogObject).not.toHaveBeenCalled();
        expect(mockCreate).not.toHaveBeenCalled();
        expect(mockResolveLogIdentity).not.toHaveBeenCalled();
    });
});

describe('fail-closed + 采样', () => {
    it('REQUEST_LOGGING=on 但 log store 未配 → 不捕获、零 putLogObject、客户照常', async () => {
        logStoreConfigured = false;
        mockFetch.mockResolvedValueOnce(jsonUpstream({ ok: 1 }));
        const res = await POST(
            makeReq('/chat/completions', { body: { model: 'gpt-5.4', messages: [] } }),
            ctx('chat', 'completions'),
        );
        await __flushReqlogForTest();
        expect(res.status).toBe(200);
        expect(mockPutLogObject).not.toHaveBeenCalled();
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('采样率 0 → 完全不捕获', async () => {
        process.env.REQUEST_LOGGING_SAMPLE_RATE = '0';
        mockFetch.mockResolvedValueOnce(jsonUpstream({ ok: 1 }));
        await POST(
            makeReq('/chat/completions', { body: { model: 'gpt-5.4', messages: [] } }),
            ctx('chat', 'completions'),
        );
        await __flushReqlogForTest();
        expect(mockPutLogObject).not.toHaveBeenCalled();
        expect(mockCreate).not.toHaveBeenCalled();
    });
});

describe('非流式 chat 直捕', () => {
    it('in.json = 客户原始 body,out.json = 完整响应,元数据正确', async () => {
        const reqBody = { model: 'gpt-5.4', messages: [{ role: 'user', content: 'hello' }] };
        const respBody = { id: 'x', usage: { prompt_tokens: 11, completion_tokens: 22 } };
        mockFetch.mockResolvedValueOnce(jsonUpstream(respBody));

        const res = await POST(makeReq('/chat/completions', { body: reqBody }), ctx('chat', 'completions'));
        const forwarded = await res.text();
        await __flushReqlogForTest();

        expect(res.status).toBe(200);
        expect(forwarded).toBe(JSON.stringify(respBody)); // 客户拿到完整响应

        // R2:in.json + out.json
        expect(JSON.parse(String(findPut('in')![1]))).toEqual(reqBody);
        expect(String(findPut('out')![1])).toBe(JSON.stringify(respBody));

        // PG row
        const d = lastCreateData();
        expect(d.path).toBe('/chat/completions');
        expect(d.method).toBe('POST');
        expect(d.model).toBe('gpt-5.4');
        expect(d.status_code).toBe(200);
        expect(d.success).toBe(true);
        expect(d.streamed).toBe(false);
        expect(d.incomplete).toBe(false);
        expect(d.input_tokens).toBe(11);
        expect(d.output_tokens).toBe(22);
        expect(d.user_id).toBe('user-1');
        expect(d.capture_version).toBe(1);
        expect(d.retention_expires_at).toBeNull();
        expect(d.input_image_r2_keys).toEqual([]);
    });
});

describe('Claude clamp — 捕获原始未钳 body', () => {
    it('in.json 存 max_tokens=8192(原始),上游收到 4096(钳后)', async () => {
        mockFetch.mockResolvedValueOnce(jsonUpstream({ ok: 1 }));
        const res = await POST(
            makeReq('/chat/completions', {
                body: { model: 'claude-opus-4-8', max_tokens: 8192, messages: [{ role: 'user', content: 'hi' }] },
            }),
            ctx('chat', 'completions'),
        );
        await res.text();
        await __flushReqlogForTest();

        // 上游收到钳后的 4096
        const upstreamBody = JSON.parse(String((mockFetch.mock.calls[0][1] as RequestInit).body));
        expect(upstreamBody.max_tokens).toBe(4096);
        // 捕获的 in.json 是原始 8192
        expect(JSON.parse(String(findPut('in')![1])).max_tokens).toBe(8192);
        expect(res.headers.get('X-Silkroadai-Clamped')).toContain('4096');
    });
});

describe('流式 SSE tee', () => {
    it('转发字节逐字不变 + out.json 重组完整 + usage 解析 + streamed=true', async () => {
        const chunks = [
            'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":8}}\n\n',
            'data: [DONE]\n\n',
        ];
        mockFetch.mockResolvedValueOnce(sseUpstream(chunks));

        const res = await POST(
            makeReq('/chat/completions', {
                body: { model: 'gpt-5.4', stream: true, messages: [{ role: 'user', content: 'hi' }] },
            }),
            ctx('chat', 'completions'),
        );
        const forwarded = await res.text();
        await __flushReqlogForTest();

        expect(forwarded).toBe(chunks.join('')); // tee 不改流,逐字一致
        expect(String(findPut('out')![1])).toBe(chunks.join('')); // 重组完整体

        const d = lastCreateData();
        expect(d.streamed).toBe(true);
        expect(d.incomplete).toBe(false);
        expect(d.success).toBe(true);
        expect(d.input_tokens).toBe(3);
        expect(d.output_tokens).toBe(8);
    });

    it('客户端断开 → incomplete=true + 存已收到部分', async () => {
        const chunks = ['data: a\n\n', 'data: b\n\n', 'data: c\n\n'];
        mockFetch.mockResolvedValueOnce(sseUpstream(chunks));
        const res = await POST(
            makeReq('/chat/completions', {
                body: { model: 'gpt-5.4', stream: true, messages: [{ role: 'user', content: 'hi' }] },
            }),
            ctx('chat', 'completions'),
        );
        const reader = res.body!.getReader();
        await reader.read(); // 收第一块
        await reader.cancel(); // 客户端断开
        await __flushReqlogForTest();

        const d = lastCreateData();
        expect(d.incomplete).toBe(true);
        expect(d.success).toBe(false); // incomplete → 不算成功
        // out.json 至少存了已收到的部分(第一块)
        const outPut = findPut('out');
        expect(outPut).toBeTruthy();
        expect(String(outPut![1])).toContain('data: a');
    });
});

describe('best-effort:写存失败客户照常', () => {
    it('putLogObject reject → 客户响应仍 200 + 完整,create 仍写(keys null + error)', async () => {
        mockPutLogObject.mockRejectedValue(new Error('R2 down'));
        const respBody = { ok: 'yes' };
        mockFetch.mockResolvedValueOnce(jsonUpstream(respBody));
        const res = await POST(
            makeReq('/chat/completions', { body: { model: 'gpt-5.4', messages: [] } }),
            ctx('chat', 'completions'),
        );
        const forwarded = await res.text();
        await __flushReqlogForTest();

        expect(res.status).toBe(200);
        expect(forwarded).toBe(JSON.stringify(respBody)); // 客户不受影响
        const d = lastCreateData();
        expect(d.input_r2_key).toBeNull();
        expect(d.output_r2_key).toBeNull();
        expect(String(d.error)).toMatch(/r2-(in|out)/);
    });

    it('prisma create reject → 客户响应仍 200 + 完整(finalize 吞错)', async () => {
        mockCreate.mockRejectedValue(new Error('db down'));
        const respBody = { ok: 'still' };
        mockFetch.mockResolvedValueOnce(jsonUpstream(respBody));
        const res = await POST(
            makeReq('/chat/completions', { body: { model: 'gpt-5.4', messages: [] } }),
            ctx('chat', 'completions'),
        );
        const forwarded = await res.text();
        await __flushReqlogForTest();
        expect(res.status).toBe(200);
        expect(forwarded).toBe(JSON.stringify(respBody));
    });
});

describe('出口 B — /messages 请求体 buffer + 捕获', () => {
    it('buffer 请求体记 in.json + 转发字节不变 + path 正确', async () => {
        const reqBody = { model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 };
        mockFetch.mockResolvedValueOnce(jsonUpstream({ ok: 1 }));
        const res = await POST(makeReq('/messages', { body: reqBody }), ctx('messages'));
        await res.text();
        await __flushReqlogForTest();

        // 转发给上游的 body 与客户原始一致
        expect(String((mockFetch.mock.calls[0][1] as RequestInit).body)).toBe(JSON.stringify(reqBody));
        expect(JSON.parse(String(findPut('in')![1]))).toEqual(reqBody);
        const d = lastCreateData();
        expect(d.path).toBe('/messages');
        expect(d.model).toBe('claude-opus-4-8');
    });

    it('GET /models(无 body)→ 捕获元数据,不写 in.json', async () => {
        mockFetch.mockResolvedValueOnce(jsonUpstream({ data: [] }));
        const res = await GET(makeReq('/models', { method: 'GET', body: undefined }), ctx('models'));
        await res.text(); // 消费响应驱动 tee 收尾(否则 done 不 resolve)
        await __flushReqlogForTest();
        expect(findPut('in')).toBeUndefined(); // 无请求体 → 不写 in.json
        const d = lastCreateData();
        expect(d.method).toBe('GET');
        expect(d.input_r2_key).toBeNull();
    });
});
