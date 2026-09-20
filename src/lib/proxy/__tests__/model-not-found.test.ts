/**
 * 未知模型 503 → 404 重映射单测(@/lib/proxy/model-not-found)。
 * 端到端接线在 proxy.test.ts(/chat/completions)与 messages-stream-hold.test.ts(/messages)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { detectModelNotFound, modelNotFoundBody, remapModelNotFound } from '@/lib/proxy/model-not-found';

const NEWAPI_MSG = '分组 ccmax 下模型 nonexistent-model-xyz 无可用渠道（distributor） (request id: 2026091806)';
const NEWAPI_503 = JSON.stringify({ error: { code: 'model_not_found', message: NEWAPI_MSG, type: 'new_api_error' } });

function upstream503(body = NEWAPI_503): Response {
    return new Response(body, {
        status: 503,
        headers: { 'content-type': 'application/json', 'x-oneapi-request-id': 'RID-503' },
    });
}
function modelsList(ids: string[]): Response {
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id, object: 'model' })) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}
const req = new NextRequest('https://ai.silkroadai.io/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 'sk-cust', 'content-type': 'application/json' },
    body: '{}',
});

const mockFetch = vi.fn();
beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch as typeof fetch;
});

describe('detectModelNotFound', () => {
    it('new-api 原文 → 命中并提取模型名', () => {
        expect(detectModelNotFound(NEWAPI_503)).toEqual({ modelFromText: 'nonexistent-model-xyz' });
    });
    it('英文变体 no available channel for model X under group → 命中', () => {
        const t = JSON.stringify({ error: { message: 'no available channel for model foo-1 under group default' } });
        expect(detectModelNotFound(t)).toEqual({ modelFromText: 'foo-1' });
    });
    it('其它 503 文案 / 非 JSON → null', () => {
        expect(detectModelNotFound(JSON.stringify({ error: { message: 'memory overloaded' } }))).toBeNull();
        expect(detectModelNotFound('<html>502</html>')).toBeNull();
    });
});

describe('modelNotFoundBody', () => {
    it('anthropic 形:type=error + not_found_error + `model: X`', () => {
        const b = modelNotFoundBody('anthropic', 'x-1') as { type: string; error: { type: string; message: string } };
        expect(b.type).toBe('error');
        expect(b.error.type).toBe('not_found_error');
        expect(b.error.message.startsWith('model: x-1')).toBe(true);
    });
    it('openai 形:invalid_request_error + code model_not_found + param model', () => {
        const b = modelNotFoundBody('openai', 'x-1') as { error: Record<string, string> };
        expect(b.error.code).toBe('model_not_found');
        expect(b.error.param).toBe('model');
        expect(b.error.type).toBe('invalid_request_error');
        expect(b.error.message).toContain('`x-1`');
    });
});

describe('remapModelNotFound', () => {
    it('非 503 → 原对象直返,零 fetch', async () => {
        const u = new Response('{}', { status: 429 });
        expect(await remapModelNotFound(u, req, 'openai', 'm')).toBe(u);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('503 model_not_found + 模型不在 /v1/models 清单 → 404,按 key 同头查清单,保留 request-id 头', async () => {
        mockFetch.mockResolvedValueOnce(modelsList(['claude-opus-4-8']));
        const r = await remapModelNotFound(upstream503(), req, 'anthropic', 'nonexistent-model-xyz');
        expect(r.status).toBe(404);
        expect(r.headers.get('x-silkroadai-error-remap')).toBe('model_not_found');
        expect(r.headers.get('x-oneapi-request-id')).toBe('RID-503');
        const j = (await r.json()) as { error: { type: string; message: string } };
        expect(j.error.type).toBe('not_found_error');
        expect(j.error.message).not.toContain('ccmax'); // 内部分组名不泄
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toMatch(/\/v1\/models$/);
        expect((init.headers as Headers).get('x-api-key')).toBe('sk-cust');
        expect((init.headers as Headers).get('content-type')).toBeNull();
    });

    it('模型名调用方未知 → 从 new-api 文案里提取', async () => {
        mockFetch.mockResolvedValueOnce(modelsList([]));
        const r = await remapModelNotFound(upstream503(), req, 'openai', null);
        expect(r.status).toBe(404);
        const j = (await r.json()) as { error: { message: string } };
        expect(j.error.message).toContain('`nonexistent-model-xyz`');
    });

    it('模型在清单里(已知模型、渠道全挂)→ 保持 503 原体(可重试容量语义)', async () => {
        mockFetch.mockResolvedValueOnce(modelsList(['claude-opus-4-8']));
        const r = await remapModelNotFound(upstream503(), req, 'anthropic', 'claude-opus-4-8');
        expect(r.status).toBe(503);
        expect(await r.text()).toBe(NEWAPI_503);
    });

    it('/v1/models 挂 / 非 200 / 抛异常 → fail-open 保持 503', async () => {
        mockFetch.mockResolvedValueOnce(new Response('nope', { status: 500 }));
        expect((await remapModelNotFound(upstream503(), req, 'openai', 'x')).status).toBe(503);
        mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        expect((await remapModelNotFound(upstream503(), req, 'openai', 'x')).status).toBe(503);
    });

    it('503 但不是 model_not_found(如 memory overloaded)→ 原样,零 fetch', async () => {
        const r = await remapModelNotFound(
            upstream503(JSON.stringify({ error: { message: 'memory overloaded', type: 'new_api_error' } })),
            req,
            'openai',
            'x',
        );
        expect(r.status).toBe(503);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
