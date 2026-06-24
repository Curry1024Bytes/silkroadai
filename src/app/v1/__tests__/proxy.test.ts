/**
 * W9 D1 PR-A — portal /v1/* catch-all proxy 单测(task #33 Phase 1)
 *
 * 覆盖 handoff 1.4 的 8 项:
 * 1. Gemini image text-only → 翻译到 native + X-Silkroadai-Translated
 * 2. Claude max_tokens=8192 → 钳 4096 + X-Silkroadai-Clamped
 * 3. Claude max_tokens=4096 → 不钳
 * 4. GPT-5.4 → 透传,无翻译 header
 * 5. Streaming SSE body 原样转发
 * 6. 上游错误 status(502)透传
 * 7. Authorization 等 header 透传(host/content-length 剥掉)
 * 8. /messages(Anthropic)透传
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Phase 2:mock R2 client(真实现读 R2_* env + 打 S3 API)
const mockUploadImage = vi.fn(
    async (key: string, _body?: Buffer, _contentType?: string) => `https://images.silkroadai.io/${key}`,
);
vi.mock('@/lib/r2/client', () => ({
    uploadImage: (key: string, body: Buffer, contentType?: string) => mockUploadImage(key, body, contentType),
}));

// Phase 3:mock 客户 OSS store + client(真实现触 prisma / S3)。
// 默认:反查不到 user(=匿名/未配置)→ 走平台 R2,Phase 1/2 的既有测试不受影响。
const mockResolveUserId = vi.fn(async (_auth: string | null): Promise<string | null> => null);
const mockGetOssConfig = vi.fn(async (_userId: string): Promise<Record<string, unknown> | null> => null);
const mockUploadToCustomerOss = vi.fn(
    async (_config: unknown, _buf: Buffer, key: string, _mime: string) => `https://cdn.customer.com/${key}`,
);
const mockObjectExistsInOss = vi.fn(async (_config: unknown, _key: string): Promise<boolean> => false);
const mockOssPublicUrl = vi.fn(
    (config: { public_url_prefix: string }, key: string) => `${config.public_url_prefix}/${key}`,
);
vi.mock('@/lib/oss/store', () => ({
    resolveUserIdFromAuthHeader: (auth: string | null) => mockResolveUserId(auth),
    getOssConfig: (userId: string) => mockGetOssConfig(userId),
}));
vi.mock('@/lib/oss/client', () => ({
    uploadToCustomerOss: (config: unknown, buf: Buffer, key: string, mime: string) =>
        mockUploadToCustomerOss(config, buf, key, mime),
    objectExistsInOss: (config: unknown, key: string) => mockObjectExistsInOss(config, key),
    ossPublicUrl: (config: { public_url_prefix: string }, key: string) => mockOssPublicUrl(config, key),
}));

import { GET, POST } from '../[...path]/route';

const NEWAPI_BASE = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';

function makeReq(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): NextRequest {
    const { method = 'POST', body, headers = {} } = init;
    return new NextRequest(`https://ai.silkroadai.io/v1${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
}

function ctx(...segments: string[]) {
    return { params: Promise.resolve({ path: segments }) };
}

const mockFetch = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch as typeof fetch;
});

function geminiNativeResponse() {
    return new Response(
        JSON.stringify({
            candidates: [
                {
                    content: {
                        parts: [{ inlineData: { mimeType: 'image/png', data: 'QkFTRTY0' } }],
                    },
                },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1290, totalTokenCount: 1300 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

describe('/v1 proxy — Gemini image translation', () => {
    it('translates chat/completions to native generateContent with imageSize injected', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());

        const res = await POST(
            makeReq('/chat/completions', {
                body: {
                    model: 'gemini-3.1-flash-image-preview',
                    max_tokens: 2000,
                    messages: [{ role: 'user', content: 'a cat' }],
                },
                headers: { authorization: 'Bearer sk-test' },
            }),
            ctx('chat', 'completions'),
        );

        // 上游打到 native endpoint
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${NEWAPI_BASE}/v1beta/models/gemini-3.1-flash-image-preview:generateContent`);
        const upstreamBody = JSON.parse(String(init.body)) as {
            contents: Array<{ role: string; parts: Array<{ text: string }> }>;
            generationConfig: { imageConfig: { imageSize: string } };
        };
        expect(upstreamBody.generationConfig.imageConfig.imageSize).toBe('2K'); // 3.1-flash-image-preview → 2K
        expect(upstreamBody.generationConfig.imageConfig).not.toHaveProperty('aspectRatio'); // §2:chat 路径不再钉 1:1
        expect(upstreamBody.contents[0].parts[0].text).toBe('a cat');

        // 响应转回 OpenAI 格式 + 翻译 header
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Silkroadai-Translated')).toBe('gemini-native');
        const data = (await res.json()) as {
            object: string;
            choices: Array<{ message: { content: string } }>;
            usage: { completion_tokens: number };
        };
        expect(data.object).toBe('chat.completion');
        // Phase 2:图片走 R2,content 是 markdown 公网 URL(非 base64 内联)
        expect(data.choices[0].message.content).toMatch(
            /^!\[image\]\(https:\/\/images\.silkroadai\.io\/gen\/[0-9a-f-]+\.png\)$/,
        );
        expect(data.usage.completion_tokens).toBe(1290);
    });

    it('maps 4K model to imageSize 4K', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        await POST(
            makeReq('/chat/completions', {
                body: { model: 'gemini-3-pro-image-preview', messages: [{ role: 'user', content: 'x' }] },
            }),
            ctx('chat', 'completions'),
        );
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(String(init.body)) as { generationConfig: { imageConfig: { imageSize: string } } };
        expect(body.generationConfig.imageConfig.imageSize).toBe('4K');
    });

    it('passes through upstream error status (e.g. 429) without translating', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }),
        );
        const res = await POST(
            makeReq('/chat/completions', {
                body: { model: 'gemini-2.5-flash-image', messages: [{ role: 'user', content: 'x' }] },
            }),
            ctx('chat', 'completions'),
        );
        expect(res.status).toBe(429);
        expect(res.headers.get('X-Silkroadai-Translated')).toBeNull();
    });
});

describe('/v1 proxy — Claude max_tokens clamp', () => {
    it('clamps max_tokens 8192 → 4096 and sets X-Silkroadai-Clamped', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const res = await POST(
            makeReq('/chat/completions', {
                body: { model: 'claude-opus-4-7', max_tokens: 8192, messages: [{ role: 'user', content: 'hi' }] },
            }),
            ctx('chat', 'completions'),
        );

        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${NEWAPI_BASE}/v1/chat/completions`);
        const sent = JSON.parse(String(init.body)) as { max_tokens: number };
        expect(sent.max_tokens).toBe(4096);
        expect(res.headers.get('X-Silkroadai-Clamped')).toBe('max_tokens=4096-was-8192');
    });

    it('does NOT clamp when max_tokens=4096 exactly', async () => {
        mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        const res = await POST(
            makeReq('/chat/completions', {
                body: { model: 'claude-opus-4-7', max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] },
            }),
            ctx('chat', 'completions'),
        );
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const sent = JSON.parse(String(init.body)) as { max_tokens: number };
        expect(sent.max_tokens).toBe(4096);
        expect(res.headers.get('X-Silkroadai-Clamped')).toBeNull();
    });
});

describe('/v1 proxy — Claude prompt-cache injection', () => {
    const BIG_SYS = 'You are a careful assistant. '.repeat(300); // > MIN_CACHE_CHARS
    function anthropicMsgResponse() {
        return new Response(
            JSON.stringify({
                id: 'msg_x',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-4-6',
                content: [{ type: 'text', text: 'Hi there' }],
                stop_reason: 'end_turn',
                usage: {
                    input_tokens: 5,
                    cache_read_input_tokens: 5000,
                    cache_creation_input_tokens: 0,
                    output_tokens: 3,
                },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }

    it('translates cacheable Claude chat → /v1/messages with cache_control injected + OpenAI response + header', async () => {
        mockFetch.mockResolvedValueOnce(anthropicMsgResponse());
        const res = await POST(
            makeReq('/chat/completions', {
                body: {
                    model: 'claude-sonnet-4-6',
                    messages: [
                        { role: 'system', content: BIG_SYS },
                        { role: 'user', content: 'hello' },
                    ],
                },
                headers: { authorization: 'Bearer sk-test' },
            }),
            ctx('chat', 'completions'),
        );
        // 打到原生 /v1/messages,且注入了 cache_control
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${NEWAPI_BASE}/v1/messages`);
        const sent = JSON.parse(String(init.body)) as {
            system: Array<{ cache_control?: unknown }>;
            messages: Array<{ content: Array<{ cache_control?: unknown }> }>;
            max_tokens: number;
        };
        expect(sent.system[0].cache_control).toEqual({ type: 'ephemeral' });
        expect(sent.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
        expect(sent.max_tokens).toBe(4096);
        // Authorization 透传
        expect((init.headers as Headers).get('authorization')).toBe('Bearer sk-test');
        // 响应翻回 OpenAI 形 + header
        expect(res.headers.get('X-Silkroadai-Cache-Injected')).toBe('claude');
        const data = (await res.json()) as {
            object: string;
            choices: Array<{ message: { content: string } }>;
            usage: { prompt_tokens: number; prompt_tokens_details: { cached_tokens: number } };
        };
        expect(data.object).toBe('chat.completion');
        expect(data.choices[0].message.content).toBe('Hi there');
        expect(data.usage.prompt_tokens).toBe(5005);
        expect(data.usage.prompt_tokens_details.cached_tokens).toBe(5000);
    });

    it('upstream /v1/messages 4xx → falls back to original /chat/completions passthrough (no regression)', async () => {
        mockFetch
            .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'error' }), { status: 400 }))
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            );
        const res = await POST(
            makeReq('/chat/completions', {
                body: {
                    model: 'claude-sonnet-4-6',
                    messages: [
                        { role: 'system', content: BIG_SYS },
                        { role: 'user', content: 'hi' },
                    ],
                },
            }),
            ctx('chat', 'completions'),
        );
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect((mockFetch.mock.calls[0] as [string, RequestInit])[0]).toBe(`${NEWAPI_BASE}/v1/messages`);
        expect((mockFetch.mock.calls[1] as [string, RequestInit])[0]).toBe(`${NEWAPI_BASE}/v1/chat/completions`);
        expect(res.headers.get('X-Silkroadai-Cache-Injected')).toBeNull();
    });

    it('Claude with tools → NOT translated, passthrough to /chat/completions', async () => {
        mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        const res = await POST(
            makeReq('/chat/completions', {
                body: {
                    model: 'claude-sonnet-4-6',
                    tools: [{ type: 'function', function: { name: 'f' } }],
                    messages: [
                        { role: 'system', content: BIG_SYS },
                        { role: 'user', content: 'hi' },
                    ],
                },
            }),
            ctx('chat', 'completions'),
        );
        const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${NEWAPI_BASE}/v1/chat/completions`);
        expect(res.headers.get('X-Silkroadai-Cache-Injected')).toBeNull();
    });

    it('small Claude chat (below cache threshold) → NOT translated, passthrough', async () => {
        mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        await POST(
            makeReq('/chat/completions', {
                body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
            }),
            ctx('chat', 'completions'),
        );
        const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${NEWAPI_BASE}/v1/chat/completions`);
    });

    it('streaming cacheable Claude → /v1/messages + translated SSE + header', async () => {
        const enc = new TextEncoder();
        const sse = [
            'event: message_start',
            'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6"}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
            '',
            'event: message_stop',
            'data: {"type":"message_stop"}',
            '',
            '',
        ].join('\n');
        mockFetch.mockResolvedValueOnce(
            new Response(
                new ReadableStream({
                    start(c) {
                        c.enqueue(enc.encode(sse));
                        c.close();
                    },
                }),
                {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                },
            ),
        );
        const res = await POST(
            makeReq('/chat/completions', {
                body: {
                    model: 'claude-sonnet-4-6',
                    stream: true,
                    messages: [
                        { role: 'system', content: BIG_SYS },
                        { role: 'user', content: 'hi' },
                    ],
                },
            }),
            ctx('chat', 'completions'),
        );
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${NEWAPI_BASE}/v1/messages`);
        expect(JSON.parse(String(init.body)).stream).toBe(true);
        expect(res.headers.get('content-type')).toMatch(/event-stream/);
        expect(res.headers.get('X-Silkroadai-Cache-Injected')).toBe('claude');
        const text = await res.text();
        expect(text).toContain('"content":"Hi"');
        expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    });
});

describe('/v1 proxy — passthrough', () => {
    it('forwards GPT-5.4 chat/completions untouched, no translation headers', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ id: 'chatcmpl-x' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const res = await POST(
            makeReq('/chat/completions', {
                body: { model: 'gpt-5.4', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] },
            }),
            ctx('chat', 'completions'),
        );
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${NEWAPI_BASE}/v1/chat/completions`);
        const sent = JSON.parse(String(init.body)) as { model: string; max_tokens: number };
        expect(sent.model).toBe('gpt-5.4');
        expect(sent.max_tokens).toBe(50);
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Silkroadai-Translated')).toBeNull();
        expect(res.headers.get('X-Silkroadai-Clamped')).toBeNull();
    });

    it('forwards streaming SSE body unbuffered', async () => {
        const sse = 'data: {"choices":[{"delta":{"content":"hel"}}]}\n\ndata: [DONE]\n\n';
        mockFetch.mockResolvedValueOnce(
            new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
        const res = await POST(
            makeReq('/chat/completions', {
                body: { model: 'gpt-5.4', stream: true, messages: [{ role: 'user', content: 'hi' }] },
            }),
            ctx('chat', 'completions'),
        );
        expect(res.headers.get('content-type')).toBe('text/event-stream');
        expect(await res.text()).toBe(sse);
    });

    it('passes through upstream 502 status', async () => {
        mockFetch.mockResolvedValueOnce(new Response('bad gateway', { status: 502 }));
        const res = await POST(
            makeReq('/chat/completions', {
                body: { model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }] },
            }),
            ctx('chat', 'completions'),
        );
        expect(res.status).toBe(502);
    });

    it('forwards Authorization header, strips host/content-length', async () => {
        mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
        await POST(
            makeReq('/chat/completions', {
                body: { model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }] },
                headers: { authorization: 'Bearer sk-abc123', 'x-custom': 'keep-me' },
            }),
            ctx('chat', 'completions'),
        );
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const headers = init.headers as Headers;
        expect(headers.get('authorization')).toBe('Bearer sk-abc123');
        expect(headers.get('x-custom')).toBe('keep-me');
        expect(headers.get('host')).toBeNull();
        expect(headers.get('content-length')).toBeNull();
    });

    it('forwards /messages (Anthropic native) as-is with query string', async () => {
        mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ type: 'message' }), { status: 200 }));
        const res = await POST(
            makeReq('/messages?beta=true', {
                body: { model: 'claude-opus-4-7', max_tokens: 8192, messages: [] },
            }),
            ctx('messages'),
        );
        const [url] = mockFetch.mock.calls[0] as [string];
        // /messages 不是 /chat/completions → 不钳、不翻译,原样转(包括 query)
        expect(url).toBe(`${NEWAPI_BASE}/v1/messages?beta=true`);
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Silkroadai-Clamped')).toBeNull();
    });

    it('forwards GET /models untouched', async () => {
        mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
        const res = await GET(makeReq('/models', { method: 'GET' }), ctx('models'));
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${NEWAPI_BASE}/v1/models`);
        expect(init.method).toBe('GET');
        expect(res.status).toBe(200);
    });

    it('returns 400 on invalid JSON body for chat/completions', async () => {
        const req = new NextRequest('https://ai.silkroadai.io/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: 'not-json{{{',
        });
        const res = await POST(req, ctx('chat', 'completions'));
        expect(res.status).toBe(400);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('/v1 proxy — Phase 2: image_url 入参 + R2 上传 (W9 D2)', () => {
    function geminiReq(content: unknown) {
        return makeReq('/chat/completions', {
            body: {
                model: 'gemini-3.1-flash-image-preview',
                messages: [{ role: 'user', content }],
            },
        });
    }

    it('fetches external image_url and sends inlineData upstream (test 9)', async () => {
        const imgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic
        mockFetch.mockImplementation(async (url: string) => {
            if (String(url).includes('example.com/cat.jpg')) {
                return new Response(imgBytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });
            }
            return geminiNativeResponse();
        });

        const res = await POST(
            geminiReq([
                { type: 'text', text: 'make this cat wear a hat' },
                { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } },
            ]),
            ctx('chat', 'completions'),
        );

        expect(res.status).toBe(200);
        // 第 1 个 fetch = 拉图,第 2 个 = native generateContent
        const upstreamCall = mockFetch.mock.calls.find(([u]) => String(u).includes(':generateContent'));
        expect(upstreamCall).toBeDefined();
        const sent = JSON.parse(String((upstreamCall![1] as RequestInit).body)) as {
            contents: Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>;
        };
        const parts = sent.contents[0].parts;
        expect(parts[0].text).toBe('make this cat wear a hat');
        expect(parts[1].inlineData?.mimeType).toBe('image/jpeg');
        expect(parts[1].inlineData?.data).toBe(Buffer.from(imgBytes).toString('base64'));
    });

    it('extracts base64 directly from data URL image_url, no fetch for the image (test 10)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const res = await POST(
            geminiReq([
                { type: 'text', text: 'edit this' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
            ]),
            ctx('chat', 'completions'),
        );
        expect(res.status).toBe(200);
        // 只有 1 个 fetch(generateContent),图没走网络
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const sent = JSON.parse(String((mockFetch.mock.calls[0][1] as RequestInit).body)) as {
            contents: Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }>;
        };
        expect(sent.contents[0].parts[1].inlineData).toEqual({ mimeType: 'image/png', data: 'QUJD' });
    });

    it('多图(≥2 输入图)追加锁定首图画幅的文字强指令', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const res = await POST(
            geminiReq([
                { type: 'text', text: 'try-on' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,REVG' } },
            ]),
            ctx('chat', 'completions'),
        );
        expect(res.status).toBe(200);
        const sent = JSON.parse(String((mockFetch.mock.calls[0][1] as RequestInit).body)) as {
            contents: Array<{ parts: Array<{ text?: string }> }>;
        };
        const texts = sent.contents.flatMap((c) => c.parts).map((p) => p.text);
        expect(texts.some((t) => /FIRST reference image/.test(String(t)))).toBe(true);
    });

    it('单图 img2img 不追加多图指令', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        await POST(
            geminiReq([
                { type: 'text', text: 'edit' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
            ]),
            ctx('chat', 'completions'),
        );
        const sent = JSON.parse(String((mockFetch.mock.calls[0][1] as RequestInit).body)) as {
            contents: Array<{ parts: Array<{ text?: string }> }>;
        };
        const texts = sent.contents.flatMap((c) => c.parts).map((p) => p.text);
        expect(texts.some((t) => /FIRST reference image/.test(String(t)))).toBe(false);
    });

    it('uploads generated image to R2 and returns markdown URL, not base64 (test 11)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const res = await POST(geminiReq('a cat'), ctx('chat', 'completions'));
        const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };

        expect(mockUploadImage).toHaveBeenCalledTimes(1);
        const [key, body, contentType] = mockUploadImage.mock.calls[0];
        expect(key).toMatch(/^gen\/[0-9a-f-]{36}\.png$/);
        expect(Buffer.isBuffer(body)).toBe(true);
        expect(contentType).toBe('image/png');
        expect(data.choices[0].message.content).toBe(`![image](https://images.silkroadai.io/${key})`);
        expect(data.choices[0].message.content).not.toContain('base64');
        expect(res.headers.get('X-Silkroadai-R2-Fallback')).toBeNull();
    });

    it('returns 400 (not throw) when external image_url fetch fails (test 12)', async () => {
        mockFetch.mockResolvedValueOnce(new Response('not found', { status: 404 }));
        const res = await POST(
            geminiReq([{ type: 'image_url', image_url: { url: 'https://example.com/gone.jpg' } }]),
            ctx('chat', 'completions'),
        );
        expect(res.status).toBe(400);
        const data = (await res.json()) as { error: { message: string; type: string } };
        expect(data.error.type).toBe('invalid_request_error');
        expect(data.error.message).toContain('404');
        // 没打到 generateContent
        expect(mockFetch.mock.calls.some(([u]) => String(u).includes(':generateContent'))).toBe(false);
    });

    it('rejects localhost / private-IP image_url with 400 (SSRF guard)', async () => {
        for (const bad of [
            'http://localhost/x.png',
            'http://10.0.0.5/x.png',
            'http://169.254.169.254/meta',
            'file:///etc/passwd',
        ]) {
            const res = await POST(
                geminiReq([{ type: 'image_url', image_url: { url: bad } }]),
                ctx('chat', 'completions'),
            );
            expect(res.status, bad).toBe(400);
        }
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('falls back to inline data URL + header when R2 upload throws', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        mockUploadImage.mockRejectedValueOnce(new Error('R2 env not configured'));
        const res = await POST(geminiReq('a cat'), ctx('chat', 'completions'));
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Silkroadai-R2-Fallback')).toBe('yes');
        const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
        expect(data.choices[0].message.content).toBe('![image](data:image/png;base64,QkFTRTY0)');
    });
});

describe('/v1 proxy — Phase 3: 客户自定义 OSS (W9 D3)', () => {
    const activeConfig = {
        provider: 'r2',
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        bucket: 'customer-bucket',
        region: null,
        access_key_id: 'AKID',
        secret_access_key_encrypted: 'encrypted',
        public_url_prefix: 'https://cdn.customer.com',
        status: 'active',
    };

    function geminiTextReq() {
        return makeReq('/chat/completions', {
            body: { model: 'gemini-3.1-flash-image-preview', messages: [{ role: 'user', content: 'a cat' }] },
            headers: { authorization: 'Bearer sk-customer-token' },
        });
    }

    it('uploads to customer OSS when config is active (test 16)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        mockResolveUserId.mockResolvedValueOnce('user-uuid-1');
        mockGetOssConfig.mockResolvedValueOnce(activeConfig);

        const res = await POST(geminiTextReq(), ctx('chat', 'completions'));
        const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };

        expect(mockResolveUserId).toHaveBeenCalledWith('Bearer sk-customer-token');
        expect(mockGetOssConfig).toHaveBeenCalledWith('user-uuid-1');
        expect(mockUploadToCustomerOss).toHaveBeenCalledTimes(1);
        expect(mockUploadImage).not.toHaveBeenCalled(); // 平台 R2 没被用
        expect(data.choices[0].message.content).toMatch(
            /^!\[image\]\(https:\/\/cdn\.customer\.com\/gen\/[0-9a-f-]+\.png\)$/,
        );
        expect(res.headers.get('X-Silkroadai-Oss-Fallback')).toBeNull();
    });

    it('falls back to platform R2 + header when customer OSS upload throws (test 17)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        mockResolveUserId.mockResolvedValueOnce('user-uuid-1');
        mockGetOssConfig.mockResolvedValueOnce(activeConfig);
        mockUploadToCustomerOss.mockRejectedValueOnce(new Error('AccessDenied'));

        const res = await POST(geminiTextReq(), ctx('chat', 'completions'));
        const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };

        expect(res.status).toBe(200); // 客户请求不失败
        expect(res.headers.get('X-Silkroadai-Oss-Fallback')).toBe('yes');
        expect(mockUploadImage).toHaveBeenCalledTimes(1);
        expect(data.choices[0].message.content).toMatch(/^!\[image\]\(https:\/\/images\.silkroadai\.io\//);
    });

    it('uses platform R2 directly when user has no OSS config (test 18)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        mockResolveUserId.mockResolvedValueOnce('user-uuid-1');
        mockGetOssConfig.mockResolvedValueOnce(null);

        const res = await POST(geminiTextReq(), ctx('chat', 'completions'));
        expect(mockUploadToCustomerOss).not.toHaveBeenCalled();
        expect(mockUploadImage).toHaveBeenCalledTimes(1);
        expect(res.headers.get('X-Silkroadai-Oss-Fallback')).toBeNull();
    });

    it('skips customer OSS when config status is inactive', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        mockResolveUserId.mockResolvedValueOnce('user-uuid-1');
        mockGetOssConfig.mockResolvedValueOnce({ ...activeConfig, status: 'inactive' });

        await POST(geminiTextReq(), ctx('chat', 'completions'));
        expect(mockUploadToCustomerOss).not.toHaveBeenCalled();
        expect(mockUploadImage).toHaveBeenCalledTimes(1);
    });

    it('survives DB lookup failure — falls back to platform R2 WITH X-Silkroadai-Oss-Fallback header', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        mockResolveUserId.mockRejectedValueOnce(new Error('db down'));

        const res = await POST(geminiTextReq(), ctx('chat', 'completions'));
        expect(res.status).toBe(200); // 客户请求不失败
        expect(mockUploadImage).toHaveBeenCalledTimes(1);
        // 2026-06-12 修复:lookup 失败不再无痕 — 响应头可检测(日志侧另有 warn)
        expect(res.headers.get('X-Silkroadai-Oss-Fallback')).toBe('yes');
    });
});

describe('/v1 proxy — Phase 4: DALL·E /v1/images/{edits,generations} (W9 D4)', () => {
    /** multipart 请求:body 传 FormData 让 Request 自动生成 multipart content-type + boundary。 */
    function makeMultipartReq(form: FormData, path = '/images/edits'): NextRequest {
        return new NextRequest(`https://ai.silkroadai.io/v1${path}`, { method: 'POST', body: form });
    }

    function imageFile(bytes: number[], name = 'ref.png', type = 'image/png'): File {
        return new File([new Uint8Array(bytes)], name, { type });
    }

    it('edits multipart happy path → native translate + url DALL·E response (test D4-1)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const jpegBytes = [0xff, 0xd8, 0xff, 0xe0];
        const form = new FormData();
        form.append('model', 'gemini-3.1-flash-image-preview');
        form.append('prompt', 'make this cat wear a hat');
        form.append('aspect_ratio', '16:9');
        form.append('image', imageFile(jpegBytes, 'cat.jpg', 'image/jpeg'));

        const res = await POST(makeMultipartReq(form, '/images/edits'), ctx('images', 'edits'));

        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${NEWAPI_BASE}/v1beta/models/gemini-3.1-flash-image-preview:generateContent`);
        const sent = JSON.parse(String(init.body)) as {
            contents: Array<{
                role: string;
                parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
            }>;
            generationConfig: { imageConfig: { imageSize: string; aspectRatio: string } };
        };
        expect(sent.generationConfig.imageConfig.imageSize).toBe('2K');
        expect(sent.generationConfig.imageConfig.aspectRatio).toBe('16:9');
        expect(sent.contents[0].parts[0].text).toBe('make this cat wear a hat');
        expect(sent.contents[0].parts[1].inlineData?.mimeType).toBe('image/jpeg');
        expect(sent.contents[0].parts[1].inlineData?.data).toBe(Buffer.from(jpegBytes).toString('base64'));

        expect(res.status).toBe(200);
        expect(res.headers.get('X-Silkroadai-Translated')).toBe('gemini-native');
        const data = (await res.json()) as { created: number; data: Array<{ url: string }> };
        expect(typeof data.created).toBe('number');
        expect(data.data).toHaveLength(1);
        expect(data.data[0].url).toMatch(/^https:\/\/images\.silkroadai\.io\/gen\/[0-9a-f-]+\.png$/);
    });

    it('edits multipart response_format=b64_json → base64, no R2 upload (test D4-2)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const form = new FormData();
        form.append('model', 'gemini-3.1-flash-image-preview');
        form.append('prompt', 'x');
        form.append('response_format', 'b64_json');
        form.append('image', imageFile([1, 2, 3]));

        const res = await POST(makeMultipartReq(form), ctx('images', 'edits'));
        expect(res.status).toBe(200);
        const data = (await res.json()) as { data: Array<{ b64_json?: string; url?: string }> };
        expect(data.data[0].b64_json).toBe('QkFTRTY0'); // geminiNativeResponse 的 inlineData.data
        expect(data.data[0].url).toBeUndefined();
        expect(mockUploadImage).not.toHaveBeenCalled();
        expect(mockUploadToCustomerOss).not.toHaveBeenCalled();
    });

    it('generations JSON happy path (no image) → DALL·E url response (test D4-3)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const res = await POST(
            makeReq('/images/generations', { body: { model: 'gemini-2.5-flash-image', prompt: 'a sunset' } }),
            ctx('images', 'generations'),
        );
        expect(res.status).toBe(200);
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${NEWAPI_BASE}/v1beta/models/gemini-2.5-flash-image:generateContent`);
        const sent = JSON.parse(String(init.body)) as {
            contents: Array<{ parts: Array<{ text?: string }> }>;
            generationConfig: { imageConfig: { imageSize: string; aspectRatio?: string } };
        };
        expect(sent.generationConfig.imageConfig.imageSize).toBe('1K');
        // 无 aspect_ratio = 不指定 → 不注入,让 Gemini 自动定比例
        expect(sent.generationConfig.imageConfig).not.toHaveProperty('aspectRatio');
        expect(sent.contents[0].parts).toHaveLength(1);
        expect(sent.contents[0].parts[0].text).toBe('a sunset');
        const data = (await res.json()) as { data: Array<{ url: string }> };
        expect(data.data[0].url).toMatch(/^https:\/\/images\.silkroadai\.io\/gen\//);
    });

    it('rejects unsupported aspect_ratio with 400, does not hit upstream (test D4-4)', async () => {
        const res = await POST(
            makeReq('/images/generations', {
                body: { model: 'gemini-2.5-flash-image', prompt: 'x', aspect_ratio: '7:3' },
            }),
            ctx('images', 'generations'),
        );
        expect(res.status).toBe(400);
        const data = (await res.json()) as { error: { type: string; message: string } };
        expect(data.error.type).toBe('invalid_request_error');
        expect(data.error.message).toContain('7:3');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('empty aspect_ratio = unspecified → no aspectRatio injected (test D4-5)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        await POST(
            makeReq('/images/generations', {
                body: { model: 'gemini-2.5-flash-image', prompt: 'x', aspect_ratio: '' },
            }),
            ctx('images', 'generations'),
        );
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const sent = JSON.parse(String(init.body)) as {
            generationConfig: { imageConfig: { imageSize: string; aspectRatio?: string } };
        };
        expect(sent.generationConfig.imageConfig.imageSize).toBe('1K');
        expect(sent.generationConfig.imageConfig).not.toHaveProperty('aspectRatio');
    });

    it('aspect_ratio=auto + 读不出输入图尺寸 → 200,fallback 不注入(hotfix + img2img fallback)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const form = new FormData();
        form.append('model', 'gemini-3.1-flash-image-preview');
        form.append('prompt', 'edit this');
        form.append('aspect_ratio', 'auto');
        // [1,2,3] 不是合法图片字节 → imageDimensions 读不出 → 维持不注入,出图不阻断
        form.append('image', imageFile([1, 2, 3], 'in.png', 'image/png'));

        const res = await POST(makeMultipartReq(form, '/images/edits'), ctx('images', 'edits'));
        expect(res.status).toBe(200); // 不再 400
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const sent = JSON.parse(String(init.body)) as {
            generationConfig: { imageConfig: { imageSize: string; aspectRatio?: string } };
        };
        expect(sent.generationConfig.imageConfig.imageSize).toBe('2K');
        expect(sent.generationConfig.imageConfig).not.toHaveProperty('aspectRatio');
    });

    it('aspect_ratio=AUTO (case-insensitive) → no aspectRatio injected (hotfix)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const res = await POST(
            makeReq('/images/generations', {
                body: { model: 'gemini-2.5-flash-image', prompt: 'x', aspect_ratio: 'AUTO' },
            }),
            ctx('images', 'generations'),
        );
        expect(res.status).toBe(200);
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const sent = JSON.parse(String(init.body)) as {
            generationConfig: { imageConfig: { aspectRatio?: string } };
        };
        expect(sent.generationConfig.imageConfig).not.toHaveProperty('aspectRatio');
    });

    it('pro-tier-only ratio 8:1 passes for pro, rejected for flash (test D4-6)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const proRes = await POST(
            makeReq('/images/generations', {
                body: { model: 'gemini-3-pro-image-preview', prompt: 'x', aspect_ratio: '8:1' },
            }),
            ctx('images', 'generations'),
        );
        expect(proRes.status).toBe(200);
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const sent = JSON.parse(String(init.body)) as { generationConfig: { imageConfig: { aspectRatio: string } } };
        expect(sent.generationConfig.imageConfig.aspectRatio).toBe('8:1');

        // 同比例在 flash 档不在白名单 → 400(分档生效),不打上游
        const flashRes = await POST(
            makeReq('/images/generations', {
                body: { model: 'gemini-3.1-flash-image-preview', prompt: 'x', aspect_ratio: '8:1' },
            }),
            ctx('images', 'generations'),
        );
        expect(flashRes.status).toBe(400);
        expect(mockFetch).toHaveBeenCalledTimes(1); // 只有 pro 那次打了上游
    });

    it('passes non-Gemini model multipart through to new-api unchanged (test D4-7)', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ data: [{ url: 'x' }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const form = new FormData();
        form.append('model', 'gpt-image-2');
        form.append('prompt', 'a logo');
        form.append('image', imageFile([1, 2, 3]));

        const res = await POST(makeMultipartReq(form, '/images/edits'), ctx('images', 'edits'));
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${NEWAPI_BASE}/v1/images/edits`); // 透传,不翻译
        expect(url).not.toContain('generateContent');
        expect(init.body).toBeInstanceOf(FormData); // 重建 FormData 转发
        // content-type 被删 → fetch 会按新 FormData 重生 boundary(mock 不会重生,断言已删)
        expect((init.headers as Headers).get('content-type')).toBeNull();
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Silkroadai-Translated')).toBeNull();
    });

    it('falls back to inline data URL + header when R2 upload throws (test D4-8)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        mockUploadImage.mockRejectedValueOnce(new Error('R2 env not configured'));
        const res = await POST(
            makeReq('/images/generations', { body: { model: 'gemini-2.5-flash-image', prompt: 'x' } }),
            ctx('images', 'generations'),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Silkroadai-R2-Fallback')).toBe('yes');
        const data = (await res.json()) as { data: Array<{ url: string }> };
        expect(data.data[0].url).toBe('data:image/png;base64,QkFTRTY0');
    });

    it('rejects oversized image file with 400, does not hit upstream (test D4-9)', async () => {
        const tooBig = new Array(20 * 1024 * 1024 + 1).fill(0); // 20MB + 1 byte
        const form = new FormData();
        form.append('model', 'gemini-3.1-flash-image-preview');
        form.append('prompt', 'x');
        form.append('image', imageFile(tooBig, 'big.png'));

        const res = await POST(makeMultipartReq(form), ctx('images', 'edits'));
        expect(res.status).toBe(400);
        const data = (await res.json()) as { error: { type: string; message: string } };
        expect(data.error.type).toBe('invalid_request_error');
        expect(data.error.message).toContain('too large');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns 502 when upstream generates no image part (test D4-10)', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'cannot draw that' }] } }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const res = await POST(
            makeReq('/images/generations', { body: { model: 'gemini-2.5-flash-image', prompt: 'x' } }),
            ctx('images', 'generations'),
        );
        expect(res.status).toBe(502);
        const data = (await res.json()) as { error: { type: string; message: string } };
        expect(data.error.message).toBe('no image generated');
        expect(data.error.type).toBe('invalid_request_error');
    });

    it('honors customer OSS on the DALL·E path too (storeGeneratedImage shared)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        mockResolveUserId.mockResolvedValueOnce('user-uuid-9');
        mockGetOssConfig.mockResolvedValueOnce({
            provider: 'r2',
            endpoint: 'https://acct.r2.cloudflarestorage.com',
            bucket: 'customer-bucket',
            region: null,
            access_key_id: 'AKID',
            secret_access_key_encrypted: 'encrypted',
            public_url_prefix: 'https://cdn.customer.com',
            status: 'active',
        });

        const res = await POST(
            makeReq('/images/generations', {
                body: { model: 'gemini-2.5-flash-image', prompt: 'x' },
                headers: { authorization: 'Bearer sk-customer-token' },
            }),
            ctx('images', 'generations'),
        );
        const data = (await res.json()) as { data: Array<{ url: string }> };
        expect(mockUploadToCustomerOss).toHaveBeenCalledTimes(1);
        expect(mockUploadImage).not.toHaveBeenCalled();
        expect(data.data[0].url).toMatch(/^https:\/\/cdn\.customer\.com\/gen\/[0-9a-f-]+\.png$/);
    });

    it('forces application/json Content-Type on translated generateContent for multipart input (CT hotfix core)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const form = new FormData();
        form.append('model', 'gemini-3.1-flash-image-preview');
        form.append('prompt', '给这只猫戴一顶圣诞帽');
        form.append('aspect_ratio', 'auto');
        form.append('image', imageFile([0xff, 0xd8, 0xff, 0xe0], 'cat.jpg', 'image/jpeg'));

        const res = await POST(makeMultipartReq(form, '/images/edits'), ctx('images', 'edits'));
        expect(res.status).toBe(200);
        // 核心守护:翻译到 generateContent 的请求 Content-Type 必须是 application/json,
        // 不能把原 multipart/form-data CT 带过去(否则 new-api 把 JSON 当 multipart → bufio buffer full)。
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toContain(':generateContent');
        expect((init.headers as Headers).get('content-type')).toBe('application/json');
    });

    it('translated chat generateContent also uses application/json Content-Type (CT hotfix, §2)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        await POST(
            makeReq('/chat/completions', {
                body: { model: 'gemini-3.1-flash-image-preview', messages: [{ role: 'user', content: 'a cat' }] },
                headers: { authorization: 'Bearer sk-x' },
            }),
            ctx('chat', 'completions'),
        );
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toContain(':generateContent');
        expect((init.headers as Headers).get('content-type')).toBe('application/json');
    });
});

describe('/v1 proxy — img2img:auto 时输出比例跟随输入图(fix gemini-img2img-match-input-aspect)', () => {
    // Gemini 实测不给 aspectRatio 时图生图默认 1:1(不跟随输入图),
    // 所以 auto + 有输入图 → proxy 读字节头测宽高,注入白名单里最近的比例。
    // ---- 最小图片字节构造器(只含 imageDimensions 解析所需的头) ----
    function pngBytes(w: number, h: number): Uint8Array<ArrayBuffer> {
        const buf = Buffer.alloc(33);
        buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
        buf.writeUInt32BE(13, 8);
        buf.write('IHDR', 12, 'latin1');
        buf.writeUInt32BE(w, 16);
        buf.writeUInt32BE(h, 20);
        return new Uint8Array(buf);
    }
    function jpegBytes(w: number, h: number): Uint8Array<ArrayBuffer> {
        const buf = Buffer.alloc(29);
        buf.set([0xff, 0xd8, 0xff, 0xe0], 0); // SOI + APP0
        buf.writeUInt16BE(16, 4); // APP0 段长(payload 被跳过)
        buf.set([0xff, 0xc0], 20); // SOF0
        buf.writeUInt16BE(17, 22);
        buf[24] = 8; // precision
        buf.writeUInt16BE(h, 25);
        buf.writeUInt16BE(w, 27);
        return new Uint8Array(buf);
    }
    function webpVp8Bytes(w: number, h: number): Uint8Array<ArrayBuffer> {
        const buf = Buffer.alloc(30);
        buf.write('RIFF', 0, 'latin1');
        buf.writeUInt32LE(22, 4);
        buf.write('WEBP', 8, 'latin1');
        buf.write('VP8 ', 12, 'latin1');
        buf.writeUInt32LE(10, 16);
        buf.set([0x9d, 0x01, 0x2a], 23); // sync code(20-22 frame tag 任意)
        buf.writeUInt16LE(w, 26);
        buf.writeUInt16LE(h, 28);
        return new Uint8Array(buf);
    }
    function webpVp8lBytes(w: number, h: number): Uint8Array<ArrayBuffer> {
        const buf = Buffer.alloc(30);
        buf.write('RIFF', 0, 'latin1');
        buf.writeUInt32LE(22, 4);
        buf.write('WEBP', 8, 'latin1');
        buf.write('VP8L', 12, 'latin1');
        buf.writeUInt32LE(10, 16);
        buf[20] = 0x2f; // VP8L 签名
        const wm = w - 1;
        const hm = h - 1;
        buf[21] = wm & 0xff;
        buf[22] = ((wm >> 8) & 0x3f) | ((hm & 0x03) << 6);
        buf[23] = (hm >> 2) & 0xff;
        buf[24] = (hm >> 10) & 0x0f;
        return new Uint8Array(buf);
    }
    function webpVp8xBytes(w: number, h: number): Uint8Array<ArrayBuffer> {
        const buf = Buffer.alloc(30);
        buf.write('RIFF', 0, 'latin1');
        buf.writeUInt32LE(22, 4);
        buf.write('WEBP', 8, 'latin1');
        buf.write('VP8X', 12, 'latin1');
        buf.writeUInt32LE(10, 16);
        const wm = w - 1;
        const hm = h - 1;
        buf[24] = wm & 0xff;
        buf[25] = (wm >> 8) & 0xff;
        buf[26] = (wm >> 16) & 0xff;
        buf[27] = hm & 0xff;
        buf[28] = (hm >> 8) & 0xff;
        buf[29] = (hm >> 16) & 0xff;
        return new Uint8Array(buf);
    }

    function multipartReq(form: FormData): NextRequest {
        return new NextRequest('https://ai.silkroadai.io/v1/images/edits', { method: 'POST', body: form });
    }

    function editsForm(
        image: Uint8Array<ArrayBuffer>,
        opts: { model?: string; aspectRatio?: string; type?: string } = {},
    ): FormData {
        const form = new FormData();
        form.append('model', opts.model ?? 'gemini-3.1-flash-image-preview');
        form.append('prompt', 'edit this');
        if (opts.aspectRatio !== undefined) form.append('aspect_ratio', opts.aspectRatio);
        form.append('image', new File([image], 'in.img', { type: opts.type ?? 'image/png' }));
        return form;
    }

    /** 取最近一次打到 generateContent 的 imageConfig。 */
    function sentImageConfig(): { imageSize: string; aspectRatio?: string } {
        const call = mockFetch.mock.calls.find(([u]) => String(u).includes(':generateContent'));
        expect(call).toBeDefined();
        const sent = JSON.parse(String((call![1] as RequestInit).body)) as {
            generationConfig: { imageConfig: { imageSize: string; aspectRatio?: string } };
        };
        return sent.generationConfig.imageConfig;
    }

    it('edits + auto + 1920×1080 PNG → 注入 16:9(不再被 Gemini 默认成方图)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const res = await POST(
            multipartReq(editsForm(pngBytes(1920, 1080), { aspectRatio: 'auto' })),
            ctx('images', 'edits'),
        );
        expect(res.status).toBe(200);
        expect(sentImageConfig().aspectRatio).toBe('16:9');
    });

    it('edits + 缺省 aspect_ratio + 1024×1024 JPEG → 注入 1:1', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const res = await POST(
            multipartReq(editsForm(jpegBytes(1024, 1024), { type: 'image/jpeg' })),
            ctx('images', 'edits'),
        );
        expect(res.status).toBe(200);
        expect(sentImageConfig().aspectRatio).toBe('1:1');
    });

    it('edits + auto + 竖图 1080×1920 WebP(VP8 / VP8L / VP8X 三种头)→ 注入 9:16', async () => {
        for (const bytes of [webpVp8Bytes(1080, 1920), webpVp8lBytes(1080, 1920), webpVp8xBytes(1080, 1920)]) {
            mockFetch.mockClear();
            mockFetch.mockResolvedValueOnce(geminiNativeResponse());
            const res = await POST(
                multipartReq(editsForm(bytes, { aspectRatio: 'auto', type: 'image/webp' })),
                ctx('images', 'edits'),
            );
            expect(res.status).toBe(200);
            expect(sentImageConfig().aspectRatio).toBe('9:16');
        }
    });

    it('JSON edits + auto + 非标 1600×1000(1.6:1)→ 取白名单最近的 3:2', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const dataUrl = `data:image/png;base64,${Buffer.from(pngBytes(1600, 1000)).toString('base64')}`;
        const res = await POST(
            makeReq('/images/edits', {
                body: { model: 'gemini-2.5-flash-image', prompt: 'x', image: dataUrl },
            }),
            ctx('images', 'edits'),
        );
        expect(res.status).toBe(200);
        expect(sentImageConfig().aspectRatio).toBe('3:2');
    });

    it('显式 aspect_ratio=1:1 + 16:9 输入 → 仍用显式值(显式覆盖优先)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const res = await POST(
            multipartReq(editsForm(pngBytes(1920, 1080), { aspectRatio: '1:1' })),
            ctx('images', 'edits'),
        );
        expect(res.status).toBe(200);
        expect(sentImageConfig().aspectRatio).toBe('1:1');
    });

    it('多参考图 → 取第一张(主图)的比例', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const form = editsForm(pngBytes(1920, 1080), { aspectRatio: 'auto' });
        form.append('image', new File([pngBytes(1000, 1000)], 'ref2.png', { type: 'image/png' }));
        const res = await POST(multipartReq(form), ctx('images', 'edits'));
        expect(res.status).toBe(200);
        expect(sentImageConfig().aspectRatio).toBe('16:9');
    });

    it('极端 8000×1000 输入:pro 档注入独有的 8:1,flash 档取白名单内最近的 21:9', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        await POST(
            multipartReq(editsForm(pngBytes(8000, 1000), { model: 'gemini-3-pro-image-preview' })),
            ctx('images', 'edits'),
        );
        expect(sentImageConfig().aspectRatio).toBe('8:1');

        mockFetch.mockClear();
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        await POST(
            multipartReq(editsForm(pngBytes(8000, 1000), { model: 'gemini-3.1-flash-image-preview' })),
            ctx('images', 'edits'),
        );
        expect(sentImageConfig().aspectRatio).toBe('21:9');
    });

    it('chat image_url 图生图(等同 auto)→ 也注入输入图比例 16:9', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const dataUrl = `data:image/png;base64,${Buffer.from(pngBytes(1920, 1080)).toString('base64')}`;
        const res = await POST(
            makeReq('/chat/completions', {
                body: {
                    model: 'gemini-3.1-flash-image-preview',
                    messages: [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: 'make it night' },
                                { type: 'image_url', image_url: { url: dataUrl } },
                            ],
                        },
                    ],
                },
            }),
            ctx('chat', 'completions'),
        );
        expect(res.status).toBe(200);
        expect(sentImageConfig().aspectRatio).toBe('16:9');
    });

    it('chat 文生图(无输入图)→ 维持不注入', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        await POST(
            makeReq('/chat/completions', {
                body: { model: 'gemini-3.1-flash-image-preview', messages: [{ role: 'user', content: 'a cat' }] },
            }),
            ctx('chat', 'completions'),
        );
        expect(sentImageConfig()).not.toHaveProperty('aspectRatio');
    });
});

describe('/v1 proxy — pro imageSize 可选 (size param, feat/pro-image-size-select)', () => {
    // 仅 gemini-3-pro-image-preview 认 size;其余模型忽略 size 维持固定档。
    function makeMultipartReq(form: FormData, path = '/images/edits'): NextRequest {
        return new NextRequest(`https://ai.silkroadai.io/v1${path}`, { method: 'POST', body: form });
    }
    function imageFile(bytes: number[], name = 'ref.png', type = 'image/png'): File {
        return new File([new Uint8Array(bytes)], name, { type });
    }
    /** 取最近一次打到 generateContent 的 imageConfig.imageSize。 */
    function sentImageSize(): string {
        const call = mockFetch.mock.calls.find(([u]) => String(u).includes(':generateContent'));
        expect(call).toBeDefined();
        const sent = JSON.parse(String((call![1] as RequestInit).body)) as {
            generationConfig: { imageConfig: { imageSize: string } };
        };
        return sent.generationConfig.imageConfig.imageSize;
    }

    // ---- JSON /v1/images/generations 入口 ----
    it('pro + size=2K (JSON images) → imageSize 2K (test 1)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const res = await POST(
            makeReq('/images/generations', {
                body: { model: 'gemini-3-pro-image-preview', prompt: 'x', size: '2K' },
            }),
            ctx('images', 'generations'),
        );
        expect(res.status).toBe(200);
        expect(sentImageSize()).toBe('2K');
    });

    it('pro + size=2048x2048 → imageSize 2K (test 2)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        await POST(
            makeReq('/images/generations', {
                body: { model: 'gemini-3-pro-image-preview', prompt: 'x', size: '2048x2048' },
            }),
            ctx('images', 'generations'),
        );
        expect(sentImageSize()).toBe('2K');
    });

    it('pro + size=4K → imageSize 4K (test 3)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        await POST(
            makeReq('/images/generations', {
                body: { model: 'gemini-3-pro-image-preview', prompt: 'x', size: '4K' },
            }),
            ctx('images', 'generations'),
        );
        expect(sentImageSize()).toBe('4K');
    });

    it('pro + 无 size → 默认 4K(回归保护,test 4)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        await POST(
            makeReq('/images/generations', {
                body: { model: 'gemini-3-pro-image-preview', prompt: 'x' },
            }),
            ctx('images', 'generations'),
        );
        expect(sentImageSize()).toBe('4K');
    });

    it('pro + size=8K(非法)→ 400 invalid_request_error,不打上游 (test 5)', async () => {
        const res = await POST(
            makeReq('/images/generations', {
                body: { model: 'gemini-3-pro-image-preview', prompt: 'x', size: '8K' },
            }),
            ctx('images', 'generations'),
        );
        expect(res.status).toBe(400);
        const data = (await res.json()) as { error: { type: string; message: string } };
        expect(data.error.type).toBe('invalid_request_error');
        expect(data.error.message).toContain('8K');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('非 pro 忽略 size:gemini-2.5-flash-image + size=4K → 仍 1K (test 6)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const res = await POST(
            makeReq('/images/generations', {
                body: { model: 'gemini-2.5-flash-image', prompt: 'x', size: '4K' },
            }),
            ctx('images', 'generations'),
        );
        expect(res.status).toBe(200); // size 被忽略,不报错
        expect(sentImageSize()).toBe('1K');
    });

    // ---- multipart /v1/images/edits 入口 (test 7a) ----
    it('pro + size=2K (multipart images/edits) → imageSize 2K', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const form = new FormData();
        form.append('model', 'gemini-3-pro-image-preview');
        form.append('prompt', 'edit this');
        form.append('size', '2K');
        form.append('image', imageFile([1, 2, 3])); // 非法字节 → 不注入 aspectRatio,只验 size
        const res = await POST(makeMultipartReq(form, '/images/edits'), ctx('images', 'edits'));
        expect(res.status).toBe(200);
        expect(sentImageSize()).toBe('2K');
    });

    // ---- chat /v1/chat/completions 入口(body.size,test 7b) ----
    it('pro + body.size=2K (chat/completions) → imageSize 2K', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const res = await POST(
            makeReq('/chat/completions', {
                body: {
                    model: 'gemini-3-pro-image-preview',
                    size: '2K',
                    messages: [{ role: 'user', content: 'a cat' }],
                },
            }),
            ctx('chat', 'completions'),
        );
        expect(res.status).toBe(200);
        expect(sentImageSize()).toBe('2K');
    });

    it('pro + body.size=8K (chat/completions, 非法)→ 400,不打上游', async () => {
        const res = await POST(
            makeReq('/chat/completions', {
                body: {
                    model: 'gemini-3-pro-image-preview',
                    size: '8K',
                    messages: [{ role: 'user', content: 'a cat' }],
                },
            }),
            ctx('chat', 'completions'),
        );
        expect(res.status).toBe(400);
        const data = (await res.json()) as { error: { type: string } };
        expect(data.error.type).toBe('invalid_request_error');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    // ── 折扣 SKU gemini-3-pro-image-preview-2k(锁 2K @ ¥0.30,new-api 单独计费)──
    it('折扣 SKU → 锁 2K + native URL 用【别名】(new-api 据此按 ¥0.30 计费,不是真名 ¥0.50)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const res = await POST(
            makeReq('/images/generations', {
                body: { model: 'gemini-3-pro-image-preview-2k', prompt: 'x' },
            }),
            ctx('images', 'generations'),
        );
        expect(res.status).toBe(200);
        const call = mockFetch.mock.calls.find(([u]) => String(u).includes(':generateContent'));
        expect(call).toBeDefined();
        // 关键:打到 new-api 的 model 必须是别名(new-api model_mapping 再翻回真名给上游)。
        // 若这里误用真名,new-api 会按 ¥0.50 计费,折扣 SKU 形同虚设。
        expect(String(call![0])).toBe(`${NEWAPI_BASE}/v1beta/models/gemini-3-pro-image-preview-2k:generateContent`);
        expect(sentImageSize()).toBe('2K');
    });

    it('折扣 SKU 忽略 size 参数(锁 2K):传 size=4K → 仍 2K', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        await POST(
            makeReq('/images/generations', {
                body: { model: 'gemini-3-pro-image-preview-2k', prompt: 'x', size: '4K' },
            }),
            ctx('images', 'generations'),
        );
        expect(sentImageSize()).toBe('2K');
    });

    it('折扣 SKU 走 chat/completions 也锁 2K', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const res = await POST(
            makeReq('/chat/completions', {
                body: { model: 'gemini-3-pro-image-preview-2k', messages: [{ role: 'user', content: 'a cat' }] },
            }),
            ctx('chat', 'completions'),
        );
        expect(res.status).toBe(200);
        expect(sentImageSize()).toBe('2K');
    });

    it('折扣 SKU 复用 pro 档比例白名单(pro 独有 8:1 通过,不 400)', async () => {
        mockFetch.mockResolvedValueOnce(geminiNativeResponse());
        const res = await POST(
            makeReq('/images/generations', {
                body: { model: 'gemini-3-pro-image-preview-2k', prompt: 'x', aspect_ratio: '8:1' },
            }),
            ctx('images', 'generations'),
        );
        expect(res.status).toBe(200);
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const sent = JSON.parse(String(init.body)) as { generationConfig: { imageConfig: { aspectRatio: string } } };
        expect(sent.generationConfig.imageConfig.aspectRatio).toBe('8:1');
    });
});

describe('/v1 proxy — 非 Gemini 图片(gpt-image-2)透传整形 + 估算 usage + 报错透传', () => {
    type Usage = {
        input_tokens: number;
        input_tokens_details: { image_tokens: number; text_tokens: number };
        output_tokens: number;
        output_tokens_details: { image_tokens: number; text_tokens: number };
        total_tokens: number;
        // chat-completions 形别名(中继/new-api 记 token 用)
        prompt_tokens: number;
        completion_tokens: number;
    };

    it('generations 成功 → 透传 new-api + 补顶层 size + 估算 usage,b64_json 原样保留', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    created: 123,
                    data: [{ b64_json: 'QUJD', revised_prompt: 'a red apple', size: '1536x1024' }],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        );
        const res = await POST(
            makeReq('/images/generations', {
                body: { model: 'gpt-image-2', prompt: 'a red apple', size: '1536x1024' },
            }),
            ctx('images', 'generations'),
        );
        expect(res.status).toBe(200);
        // 透传到 new-api images 端点(不翻译成 generateContent)
        const [url] = mockFetch.mock.calls[0] as [string];
        expect(url).toBe(`${NEWAPI_BASE}/v1/images/generations`);
        expect(url).not.toContain('generateContent');

        const data = (await res.json()) as {
            created: number;
            size: string;
            data: Array<{ b64_json: string }>;
            usage: Usage;
        };
        expect(data.data[0].b64_json).toBe('QUJD'); // 图原样
        expect(data.created).toBe(123);
        expect(data.size).toBe('1536x1024'); // 顶层 size 补上(原在 data[0].size)
        // 估算 usage 结构对齐官方 gpt-image-1
        expect(data.usage.output_tokens_details.image_tokens).toBeGreaterThan(1000);
        expect(data.usage.output_tokens).toBe(data.usage.output_tokens_details.image_tokens);
        expect(data.usage.input_tokens_details.text_tokens).toBeGreaterThan(0);
        expect(data.usage.input_tokens_details.image_tokens).toBe(0);
        expect(data.usage.total_tokens).toBe(data.usage.input_tokens + data.usage.output_tokens);
        // chat-completions 形别名:中继(new-api)按这套字段记 token,缺了就显示 0
        expect(data.usage.prompt_tokens).toBe(data.usage.input_tokens);
        expect(data.usage.completion_tokens).toBe(data.usage.output_tokens);
    });

    async function imageTokensFor(size: string): Promise<number> {
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ created: 1, data: [{ b64_json: 'QUJD', size }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const res = await POST(
            makeReq('/images/generations', { body: { model: 'gpt-image-2', prompt: 'x', size } }),
            ctx('images', 'generations'),
        );
        return ((await res.json()) as { usage: Usage }).usage.output_tokens_details.image_tokens;
    }

    it('image_tokens 随输出尺寸缩放(按面积:1536x1024≈1106 > 1024x1024≈737)', async () => {
        expect(await imageTokensFor('1536x1024')).toBe(1106);
        expect(await imageTokensFor('1024x1024')).toBe(737);
    });

    it('multipart edits 也整形(补 size + usage)', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ created: 1, data: [{ b64_json: 'QUJD', size: '1024x1024' }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const form = new FormData();
        form.append('model', 'gpt-image-2');
        form.append('prompt', '改成夜景');
        form.append('image', new File([new Uint8Array([1, 2, 3])], 'in.png', { type: 'image/png' }));
        const req = new NextRequest('https://ai.silkroadai.io/v1/images/edits', { method: 'POST', body: form });
        const res = await POST(req, ctx('images', 'edits'));
        expect(res.status).toBe(200);
        const data = (await res.json()) as { size: string; usage: Usage };
        expect(data.size).toBe('1024x1024');
        expect(data.usage.output_tokens_details.image_tokens).toBeGreaterThan(0);
    });

    it('上游报错 → 原样透传 status + 错误体,不加 usage(不隐藏报错)', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    error: { message: 'blocked', type: 'invalid_request_error', code: 'content_policy_violation' },
                }),
                { status: 400, headers: { 'content-type': 'application/json' } },
            ),
        );
        const res = await POST(
            makeReq('/images/generations', { body: { model: 'gpt-image-2', prompt: 'x' } }),
            ctx('images', 'generations'),
        );
        expect(res.status).toBe(400); // 上游状态码透传
        const data = (await res.json()) as { error: { code: string }; usage?: unknown };
        expect(data.error.code).toBe('content_policy_violation'); // 上游错误体原样
        expect(data.usage).toBeUndefined(); // 报错不加 usage
    });

    it('连不上 new-api(网络异常)→ 502 透出真实原因,不被兜底成笼统 400', async () => {
        mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        const res = await POST(
            makeReq('/images/generations', { body: { model: 'gpt-image-2', prompt: 'x' } }),
            ctx('images', 'generations'),
        );
        expect(res.status).toBe(502);
        const data = (await res.json()) as { error: { message: string; type: string } };
        expect(data.error.message).toContain('ECONNREFUSED');
        expect(data.error.type).toBe('invalid_request_error');
    });
});

describe('/v1 proxy — video poll customer-OSS rehost', () => {
    const R2 = 'https://images.silkroadai.io';
    const R2_VIDEO = `${R2}/seedance-video/task_abc.mp4`;
    const OSS_CONFIG = { status: 'active', public_url_prefix: 'https://cdn.customer.com' };

    beforeEach(() => {
        process.env.R2_PUBLIC_URL = R2;
    });

    function videoPoll(videoUrl: string, status = 'SUCCESS') {
        return new Response(
            JSON.stringify({
                code: 'success',
                data: {
                    id: 1,
                    status,
                    data: { status: 'completed', video_url: videoUrl, url: videoUrl, urls: [videoUrl] },
                },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }
    function pollReq() {
        return makeReq('/video/generations/task_abc', { method: 'GET', headers: { authorization: 'Bearer sk-x' } });
    }

    it('completed + R2 video + customer OSS → rehosts + rewrites video_url', async () => {
        mockResolveUserId.mockResolvedValueOnce('user-1');
        mockGetOssConfig.mockResolvedValueOnce(OSS_CONFIG as unknown as Record<string, unknown>);
        mockObjectExistsInOss.mockResolvedValueOnce(false);
        mockFetch
            .mockResolvedValueOnce(videoPoll(R2_VIDEO))
            .mockResolvedValueOnce(
                new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'video/mp4' } }),
            );
        const res = await GET(pollReq(), ctx('video', 'generations', 'task_abc'));
        const body = (await res.json()) as { data: { data: { video_url: string; urls: string[] } } };
        expect(body.data.data.video_url).toBe('https://cdn.customer.com/seedance-video/task_abc.mp4');
        expect(body.data.data.urls).toEqual(['https://cdn.customer.com/seedance-video/task_abc.mp4']);
        expect(mockUploadToCustomerOss).toHaveBeenCalledTimes(1);
        expect(mockUploadToCustomerOss.mock.calls[0][2]).toBe('seedance-video/task_abc.mp4');
    });

    it('completed + OSS object already exists → ossPublicUrl, no re-upload', async () => {
        mockResolveUserId.mockResolvedValueOnce('user-1');
        mockGetOssConfig.mockResolvedValueOnce(OSS_CONFIG as unknown as Record<string, unknown>);
        mockObjectExistsInOss.mockResolvedValueOnce(true);
        mockFetch.mockResolvedValueOnce(videoPoll(R2_VIDEO));
        const res = await GET(pollReq(), ctx('video', 'generations', 'task_abc'));
        const body = (await res.json()) as { data: { data: { video_url: string } } };
        expect(body.data.data.video_url).toBe('https://cdn.customer.com/seedance-video/task_abc.mp4');
        expect(mockUploadToCustomerOss).not.toHaveBeenCalled();
    });

    it('no customer OSS → keeps platform R2 url', async () => {
        mockResolveUserId.mockResolvedValueOnce('user-1');
        mockGetOssConfig.mockResolvedValueOnce(null);
        mockFetch.mockResolvedValueOnce(videoPoll(R2_VIDEO));
        const res = await GET(pollReq(), ctx('video', 'generations', 'task_abc'));
        const body = (await res.json()) as { data: { data: { video_url: string } } };
        expect(body.data.data.video_url).toBe(R2_VIDEO);
        expect(mockUploadToCustomerOss).not.toHaveBeenCalled();
    });

    it('in-progress → passthrough, no user lookup / no rehost', async () => {
        mockFetch.mockResolvedValueOnce(videoPoll(R2_VIDEO, 'IN_PROGRESS'));
        const res = await GET(pollReq(), ctx('video', 'generations', 'task_abc'));
        const body = (await res.json()) as { data: { data: { video_url: string } } };
        expect(mockResolveUserId).not.toHaveBeenCalled();
        expect(body.data.data.video_url).toBe(R2_VIDEO);
    });
});

describe('/v1 proxy — gpt-image-2 response_format stripping (zhiyunai compat)', () => {
    it('strips response_format from JSON /images/generations, keeps size/quality', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ data: [{ b64_json: 'QkFTRTY0' }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const res = await POST(
            makeReq('/images/generations', {
                body: {
                    model: 'gpt-image-2',
                    prompt: 'a red apple',
                    size: '1024x1024',
                    quality: 'high',
                    response_format: 'url',
                },
                headers: { authorization: 'Bearer sk-test' },
            }),
            ctx('images', 'generations'),
        );
        expect(res.status).toBe(200);
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${NEWAPI_BASE}/v1/images/generations`);
        const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        // response_format 剥掉(zhiyunai 拒收),其余官方参数照常透传
        expect(sent).not.toHaveProperty('response_format');
        expect(sent.size).toBe('1024x1024');
        expect(sent.quality).toBe('high');
        expect(sent.model).toBe('gpt-image-2');
    });

    it('strips response_format from multipart /images/edits before forwarding', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ data: [{ b64_json: 'QkFTRTY0' }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const form = new FormData();
        form.append('model', 'gpt-image-2');
        form.append('prompt', 'make it red');
        form.append('response_format', 'b64_json');
        form.append('image', new Blob([Buffer.from('x')], { type: 'image/png' }), 'in.png');
        const req = new NextRequest('https://ai.silkroadai.io/v1/images/edits', {
            method: 'POST',
            headers: { authorization: 'Bearer sk-test' },
            body: form,
        });
        const res = await POST(req, ctx('images', 'edits'));
        expect(res.status).toBe(200);
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const sentForm = init.body as FormData;
        expect(sentForm.get('response_format')).toBeNull();
        expect(sentForm.get('model')).toBe('gpt-image-2');
    });
});
