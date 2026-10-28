/**
 * 主站火山方舟原生视频入口单测。
 * 契约:只认提交与单任务查询;请求体和鉴权头原样转给 new-api doubao 插件的原生路由;
 * 响应只改写 `model`(上游名 → 对客名),其余字节不动;new-api 不可达 → 502 且不暴露内网地址。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// reqlog capture mock:默认关(与 prod 开关 off 一致);捕获接线用例里单独开。
const mockBeginCapture = vi.fn<(...args: unknown[]) => unknown>(() => null);
const mockRecordRequestBody = vi.fn<(...args: unknown[]) => void>();
const mockIsMediaCaptureSkipped = vi.fn(() => false);
vi.mock('@/lib/reqlog/capture', () => ({
    beginCapture: (...a: unknown[]) => mockBeginCapture(...a),
    recordRequestBody: (...a: unknown[]) => mockRecordRequestBody(...a),
    isMediaCaptureSkipped: () => mockIsMediaCaptureSkipped(),
    parseModelAndStream: (raw: string) => {
        try {
            const o = JSON.parse(raw) as { model?: unknown };
            return { model: typeof o.model === 'string' ? o.model : null, streamed: false };
        } catch {
            return { model: null, streamed: false };
        }
    },
    captureResponse: (_cap: unknown, upstream: Response) =>
        new Response(upstream.body, { status: upstream.status, headers: upstream.headers }),
    captureJsonResponse: vi.fn(),
}));

import { handleArkNativeVideo, matchArkNativeVideoPath, rewriteUpstreamModel } from '../ark-native';

const NEWAPI_BASE = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';

const mockFetch = vi.fn();
beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch as typeof fetch;
});

function makeReq(method: string, path: string, body?: string): NextRequest {
    return new NextRequest(`https://api.llmroute.club/api/v3${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-cust', 'content-length': '999' },
        body,
    });
}

const SUBMIT_BODY = JSON.stringify({
    model: 'doubao-seedance-2-5-260628',
    content: [
        { type: 'text', text: '一只猫在雪地里走' },
        { type: 'video_url', video_url: { url: 'https://example.com/ref.mp4' }, role: 'reference_video' },
    ],
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
});

describe('matchArkNativeVideoPath', () => {
    it('只认 POST 提交和 GET 单任务查询,容忍尾斜杠', () => {
        expect(matchArkNativeVideoPath('POST', '/contents/generations/tasks')).toEqual({ kind: 'submit' });
        expect(matchArkNativeVideoPath('POST', '/contents/generations/tasks/')).toEqual({ kind: 'submit' });
        expect(matchArkNativeVideoPath('GET', '/contents/generations/tasks/task_AbC123')).toEqual({
            kind: 'query',
            taskId: 'task_AbC123',
        });
    });

    it('取消、删除、列表、其他路径和不安全的任务号都不放行', () => {
        expect(matchArkNativeVideoPath('GET', '/contents/generations/tasks')).toBeNull();
        expect(matchArkNativeVideoPath('DELETE', '/contents/generations/tasks/task_abc')).toBeNull();
        expect(matchArkNativeVideoPath('POST', '/images/generations')).toBeNull();
        expect(matchArkNativeVideoPath('GET', '/models')).toBeNull();
        expect(matchArkNativeVideoPath('GET', '/contents/generations/tasks/a/b')).toBeNull();
        expect(matchArkNativeVideoPath('GET', '/contents/generations/tasks/..')).toBeNull();
        expect(matchArkNativeVideoPath('GET', '/contents/generations/tasks/a%2Fb')).toBeNull();
    });
});

describe('rewriteUpstreamModel', () => {
    it('四个上游名改回对客名,其余字段原样', () => {
        const out = rewriteUpstreamModel(
            JSON.stringify({ id: 'task_x', model: 'artsdance-2-0-mini-260801', usage: { completion_tokens: 10 } }),
        );
        expect(JSON.parse(out!)).toEqual({
            id: 'task_x',
            model: 'doubao-seedance-2-0-mini-260615',
            usage: { completion_tokens: 10 },
        });
        for (const [upstream, client] of [
            ['artsdance-2-5-pro-260801', 'doubao-seedance-2-5-260628'],
            ['artsdance-2-0-pro-260801', 'doubao-seedance-2-0-260128'],
            ['artsdance-2-0-fast-260801', 'doubao-seedance-2-0-fast-260128'],
        ]) {
            expect(JSON.parse(rewriteUpstreamModel(JSON.stringify({ model: upstream }))!).model).toBe(client);
        }
    });

    it('不需要改写时返回 null:已是对客名、没有 model、非 JSON、数组', () => {
        expect(rewriteUpstreamModel(JSON.stringify({ model: 'doubao-seedance-2-5-260628' }))).toBeNull();
        expect(rewriteUpstreamModel(JSON.stringify({ id: 'task_x' }))).toBeNull();
        expect(rewriteUpstreamModel('not json')).toBeNull();
        expect(rewriteUpstreamModel(JSON.stringify([{ model: 'artsdance-2-5-pro-260801' }]))).toBeNull();
    });

    it('对应表漏掉的上游名原样返回,但留告警', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(rewriteUpstreamModel(JSON.stringify({ model: 'artsdance-3-0-pro-261001' }))).toBeNull();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('handleArkNativeVideo', () => {
    it('提交:转给插件原生路由,请求体和鉴权头原样,响应原样', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response('{"id":"task_abc"}', { status: 200, headers: { 'content-type': 'application/json' } }),
        );
        const res = await handleArkNativeVideo(makeReq('POST', '/contents/generations/tasks', SUBMIT_BODY), {
            kind: 'submit',
        });
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${NEWAPI_BASE}/doubao/api/v3/contents/generations/tasks`);
        expect(init.method).toBe('POST');
        const headers = init.headers as Headers;
        expect(headers.get('authorization')).toBe('Bearer sk-cust');
        expect(headers.get('content-length')).toBeNull();
        expect(await new Response(init.body).text()).toBe(SUBMIT_BODY);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('{"id":"task_abc"}');
    });

    it('查询:GET 不带请求体,返回里的上游模型名改回对客名', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    id: 'task_abc',
                    model: 'artsdance-2-5-pro-260801',
                    status: 'succeeded',
                    content: { video_url: 'https://v.example.com/a.mp4' },
                    usage: { completion_tokens: 83485, total_tokens: 83485 },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        );
        const res = await handleArkNativeVideo(makeReq('GET', '/contents/generations/tasks/task_abc'), {
            kind: 'query',
            taskId: 'task_abc',
        });
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${NEWAPI_BASE}/doubao/api/v3/contents/generations/tasks/task_abc`);
        expect(init.method).toBe('GET');
        expect(init.body).toBeUndefined();
        expect(res.headers.get('content-type')).toBe('application/json');
        expect(await res.json()).toEqual({
            id: 'task_abc',
            model: 'doubao-seedance-2-5-260628',
            status: 'succeeded',
            content: { video_url: 'https://v.example.com/a.mp4' },
            usage: { completion_tokens: 83485, total_tokens: 83485 },
        });
    });

    it('new-api 报错原样透传(JSON 和纯文本)', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response('{"error":{"code":"invalid_api_key","message":"bad key"}}', {
                status: 401,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const r1 = await handleArkNativeVideo(makeReq('POST', '/contents/generations/tasks', SUBMIT_BODY), {
            kind: 'submit',
        });
        expect(r1.status).toBe(401);
        expect(await r1.text()).toBe('{"error":{"code":"invalid_api_key","message":"bad key"}}');

        mockFetch.mockResolvedValueOnce(new Response('bad request', { status: 400 }));
        const r2 = await handleArkNativeVideo(makeReq('GET', '/contents/generations/tasks/task_abc'), {
            kind: 'query',
            taskId: 'task_abc',
        });
        expect(r2.status).toBe(400);
        expect(await r2.text()).toBe('bad request');
    });

    it('new-api 不可达 → 502,报错里不带内网地址', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockFetch.mockRejectedValueOnce(new Error(`connect ECONNREFUSED ${NEWAPI_BASE}`));
        const res = await handleArkNativeVideo(makeReq('POST', '/contents/generations/tasks', SUBMIT_BODY), {
            kind: 'submit',
        });
        expect(res.status).toBe(502);
        const text = await res.text();
        expect(JSON.parse(text).error.code).toBe('upstream_unreachable');
        expect(text).not.toContain(NEWAPI_BASE);
        warn.mockRestore();
    });

    it('开启请求日志时记下请求体和模型名;text-only 模式不记视频', async () => {
        const cap = { id: 'cap-1' };
        mockBeginCapture.mockReturnValueOnce(cap);
        mockFetch.mockResolvedValueOnce(new Response('{"id":"task_abc"}', { status: 200 }));
        await handleArkNativeVideo(makeReq('POST', '/contents/generations/tasks', SUBMIT_BODY), { kind: 'submit' });
        expect(mockBeginCapture).toHaveBeenCalledWith(expect.anything(), '/api/v3/contents/generations/tasks');
        expect(mockRecordRequestBody).toHaveBeenCalledWith(cap, SUBMIT_BODY, 'doubao-seedance-2-5-260628', false);

        vi.clearAllMocks();
        mockIsMediaCaptureSkipped.mockReturnValueOnce(true);
        mockFetch.mockResolvedValueOnce(new Response('{"id":"task_abc"}', { status: 200 }));
        await handleArkNativeVideo(makeReq('POST', '/contents/generations/tasks', SUBMIT_BODY), { kind: 'submit' });
        expect(mockBeginCapture).not.toHaveBeenCalled();
    });
});
