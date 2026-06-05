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
