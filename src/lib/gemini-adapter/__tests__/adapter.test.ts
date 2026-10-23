/**
 * gemini-adapter 单测:usage 按官方常数重写(按返回图实际像素分档)、输入图 560/张、无图 0、
 * 未知模型透传、stream 包单条 SSE 且上游走非流式、鉴权透传、上游错误脱敏透传。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
    handleGeminiAdapter,
    rewriteUsage,
    tierFromPixels,
    requestedTier,
    officialFamily,
    officialOutputTokens,
    countInputImages,
    OFFICIAL_INPUT_IMAGE_TOKENS,
} from '@/lib/gemini-adapter/adapter';

const mockFetch = vi.fn();
beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

/** 仅 PNG 签名 + IHDR 的最小 buffer(够 imageDimensions 读尺寸)。 */
function pngB64(w: number, h: number): string {
    const buf = Buffer.alloc(26);
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47;
    buf.write('IHDR', 12, 'latin1');
    buf.writeUInt32BE(w, 16);
    buf.writeUInt32BE(h, 20);
    buf[24] = 8;
    buf[25] = 2;
    return buf.toString('base64');
}

/** 伪造 yobox 式上游回包:图 + 乱编的 usage。 */
function upstreamResponse(
    images: Array<[number, number]>,
    usage: Record<string, unknown> = {
        promptTokenCount: 12,
        candidatesTokenCount: 599,
        totalTokenCount: 611,
        promptTokensDetails: [{ modality: 'TEXT', tokenCount: 12 }],
        candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 599 }],
    },
    extraParts: Array<Record<string, unknown>> = [],
): Response {
    const parts = [
        ...images.map(([w, h]) => ({ inlineData: { mimeType: 'image/png', data: pngB64(w, h) } })),
        ...extraParts,
    ];
    return new Response(
        JSON.stringify({
            candidates: [{ content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 }],
            usageMetadata: usage,
            modelVersion: 'gemini-nano-banana-2.1',
            responseId: 'r1',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

function req(
    model: string,
    action: string,
    body: unknown,
    headers: Record<string, string> = { 'x-goog-api-key': 'sk-upstream-test' },
    query = '',
): NextRequest {
    return new NextRequest(`http://portal.test/gemini-adapter/yobox/v1beta/models/${model}:${action}${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

const TEXT_BODY = {
    contents: [{ role: 'user', parts: [{ text: 'a red apple' }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { imageSize: '1K', aspectRatio: '1:1' } },
};

type Usage = {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
    promptTokensDetails: Array<{ modality: string; tokenCount: number }>;
    candidatesTokensDetails: Array<{ modality: string; tokenCount: number }>;
    thoughtsTokenCount?: number;
};

describe('gemini-adapter — 纯函数', () => {
    it('tierFromPixels:像素预算分档,官方各比例都落对档', () => {
        expect(tierFromPixels(1024, 1024)).toBe('1K');
        expect(tierFromPixels(1376, 768)).toBe('1K'); // 16:9 1K
        expect(tierFromPixels(3072, 384)).toBe('1K'); // 8:1 1K(长边 3072 但仍 1K)
        expect(tierFromPixels(2048, 2048)).toBe('2K');
        expect(tierFromPixels(2752, 1536)).toBe('2K');
        expect(tierFromPixels(4096, 4096)).toBe('4K');
        expect(tierFromPixels(5504, 3072)).toBe('4K');
        expect(tierFromPixels(512, 512)).toBe('0.5K');
        expect(tierFromPixels(792, 168)).toBe('0.5K'); // 21:9 0.5K
    });

    it('requestedTier:缺省 1K;512/0.5K/2K/4K 识别', () => {
        expect(requestedTier({})).toBe('1K');
        expect(requestedTier({ generationConfig: { imageConfig: { imageSize: '2K' } } })).toBe('2K');
        expect(requestedTier({ generationConfig: { imageConfig: { imageSize: '4k' } } })).toBe('4K');
        expect(requestedTier({ generationConfig: { imageConfig: { imageSize: '512' } } })).toBe('0.5K');
    });

    it('officialFamily / officialOutputTokens:裸名、-preview、自家别名都归到同一族;表值对齐官方', () => {
        expect(officialFamily('gemini-nano-banana-2.1')).toBe('gemini-nano-banana-2.1');
        expect(officialFamily('gemini-3-pro-image-preview')).toBe('gemini-3-pro-image');
        expect(officialFamily('gemini-3.1-flash-image-preview-hq')).toBe('gemini-3.1-flash-image');
        expect(officialFamily('gemini-3.8-flash')).toBeNull();
        expect(officialOutputTokens('gemini-nano-banana-2.1', '1K')).toBe(1120);
        expect(officialOutputTokens('gemini-nano-banana-2.1', '2K')).toBe(1680);
        expect(officialOutputTokens('gemini-nano-banana-2.1', '4K')).toBe(3780);
        expect(officialOutputTokens('gemini-3.1-flash-image', '0.5K')).toBe(747);
        expect(officialOutputTokens('gemini-3.1-flash-image', '4K')).toBe(2520);
        expect(officialOutputTokens('gemini-3-pro-image', '2K')).toBe(1120);
        expect(officialOutputTokens('gemini-3-pro-image', '4K')).toBe(2000);
        expect(officialOutputTokens('gemini-3-pro-image', '0.5K')).toBe(1120); // pro 无 0.5K → 取 1K 不少收
    });

    it('countInputImages:inlineData / fileData 都算', () => {
        expect(countInputImages(TEXT_BODY)).toBe(0);
        expect(
            countInputImages({
                contents: [
                    { parts: [{ text: 'x' }, { inlineData: { mimeType: 'image/png', data: 'AA==' } }] },
                    { parts: [{ fileData: { fileUri: 'gs://x' } }] },
                ],
            }),
        ).toBe(2);
    });

    it('rewriteUsage:yobox 乱编的 599 → 官方 1120;TEXT 沿用上游;total 重算', () => {
        const data = JSON.parse(
            JSON.stringify({
                candidates: [{ content: { parts: [{ inlineData: { data: pngB64(1024, 1024) } }] } }],
                usageMetadata: {
                    promptTokenCount: 12,
                    candidatesTokenCount: 599,
                    totalTokenCount: 611,
                    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 12 }],
                    candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 599 }],
                },
            }),
        );
        const r = rewriteUsage(data, 'gemini-nano-banana-2.1', '1K', 0);
        const u = r.usage as unknown as Usage;
        expect(r.tiers).toEqual(['1K']);
        expect(u.candidatesTokenCount).toBe(1120);
        expect(u.candidatesTokensDetails).toEqual([{ modality: 'IMAGE', tokenCount: 1120 }]);
        expect(u.promptTokenCount).toBe(12);
        expect(u.totalTokenCount).toBe(1132);
    });
});

describe('gemini-adapter — handleGeminiAdapter', () => {
    it('1K 1:1 → IMAGE 1120;上游 key 以 x-goog-api-key 透传;body 原样;头标 rewritten', async () => {
        mockFetch.mockResolvedValueOnce(upstreamResponse([[1024, 1024]]));
        const res = await handleGeminiAdapter(
            req('gemini-nano-banana-2.1', 'generateContent', TEXT_BODY),
            'yobox',
            'gemini-nano-banana-2.1',
            'generateContent',
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Silkroadai-Gemini-Adapter')).toBe('rewritten');
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://max.yoboxai.com/gemini/v1beta/models/gemini-nano-banana-2.1:generateContent');
        expect(new Headers(init.headers).get('x-goog-api-key')).toBe('sk-upstream-test');
        expect(JSON.parse(String(init.body))).toEqual(TEXT_BODY);
        const data = (await res.json()) as { usageMetadata: Usage; candidates: unknown[] };
        expect(data.usageMetadata.candidatesTokenCount).toBe(1120);
        expect(data.usageMetadata.candidatesTokensDetails).toEqual([{ modality: 'IMAGE', tokenCount: 1120 }]);
        expect(data.usageMetadata.totalTokenCount).toBe(1132);
        expect(data.candidates).toHaveLength(1); // 图原样
    });

    it('按返回图实际像素分档:请求 4K 但上游只给 2048² → 按 2K 1680 计(不多收)', async () => {
        mockFetch.mockResolvedValueOnce(upstreamResponse([[2048, 2048]]));
        const body = { ...TEXT_BODY, generationConfig: { imageConfig: { imageSize: '4K' } } };
        const res = await handleGeminiAdapter(
            req('gemini-nano-banana-2.1', 'generateContent', body),
            'yobox',
            'gemini-nano-banana-2.1',
            'generateContent',
        );
        const data = (await res.json()) as { usageMetadata: Usage };
        expect(data.usageMetadata.candidatesTokenCount).toBe(1680);
    });

    it('三族 4K 各自表值:nano 3780 / flash 2520 / pro 2000', async () => {
        for (const [model, want] of [
            ['gemini-nano-banana-2.1', 3780],
            ['gemini-3.1-flash-image', 2520],
            ['gemini-3-pro-image', 2000],
        ] as const) {
            mockFetch.mockReset();
            mockFetch.mockResolvedValueOnce(upstreamResponse([[4096, 4096]]));
            const res = await handleGeminiAdapter(
                req(model, 'generateContent', TEXT_BODY),
                'yobox',
                model,
                'generateContent',
            );
            const data = (await res.json()) as { usageMetadata: Usage };
            expect(data.usageMetadata.candidatesTokenCount, model).toBe(want);
        }
    });

    it('图生图:两张输入图 → promptTokensDetails IMAGE 1120(560×2),TEXT 沿用上游', async () => {
        mockFetch.mockResolvedValueOnce(
            upstreamResponse([[1024, 1024]], {
                promptTokenCount: 286,
                candidatesTokenCount: 581,
                totalTokenCount: 867,
                promptTokensDetails: [
                    { modality: 'TEXT', tokenCount: 11 },
                    { modality: 'IMAGE', tokenCount: 275 },
                ],
                candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 581 }],
            }),
        );
        const body = {
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: 'make it green' },
                        { inlineData: { mimeType: 'image/png', data: 'AA==' } },
                        { inlineData: { mimeType: 'image/png', data: 'AA==' } },
                    ],
                },
            ],
            generationConfig: { imageConfig: { imageSize: '1K' } },
        };
        const res = await handleGeminiAdapter(
            req('gemini-nano-banana-2.1', 'generateContent', body),
            'yobox',
            'gemini-nano-banana-2.1',
            'generateContent',
        );
        const u = ((await res.json()) as { usageMetadata: Usage }).usageMetadata;
        expect(u.promptTokensDetails).toEqual([
            { modality: 'TEXT', tokenCount: 11 },
            { modality: 'IMAGE', tokenCount: 2 * OFFICIAL_INPUT_IMAGE_TOKENS },
        ]);
        expect(u.promptTokenCount).toBe(11 + 1120);
        expect(u.candidatesTokenCount).toBe(1120);
        expect(u.totalTokenCount).toBe(11 + 1120 + 1120);
    });

    it('上游没出图(只回文本)→ IMAGE 0,TEXT 输出沿用;thoughts 透传进 total', async () => {
        mockFetch.mockResolvedValueOnce(
            upstreamResponse(
                [],
                {
                    promptTokenCount: 12,
                    candidatesTokenCount: 1120,
                    totalTokenCount: 1132,
                    thoughtsTokenCount: 40,
                    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 12 }],
                    candidatesTokensDetails: [
                        { modality: 'IMAGE', tokenCount: 1100 },
                        { modality: 'TEXT', tokenCount: 20 },
                    ],
                },
                [{ text: 'I cannot draw that.' }],
            ),
        );
        const res = await handleGeminiAdapter(
            req('gemini-nano-banana-2.1', 'generateContent', TEXT_BODY),
            'yobox',
            'gemini-nano-banana-2.1',
            'generateContent',
        );
        const u = ((await res.json()) as { usageMetadata: Usage }).usageMetadata;
        expect(u.candidatesTokensDetails).toEqual([
            { modality: 'TEXT', tokenCount: 20 },
            { modality: 'IMAGE', tokenCount: 0 },
        ]);
        expect(u.candidatesTokenCount).toBe(20);
        expect(u.thoughtsTokenCount).toBe(40);
        expect(u.totalTokenCount).toBe(12 + 20 + 40);
    });

    it('读不出返回图尺寸 → 按请求 imageSize 兜底(2K → 1680)', async () => {
        const resp = new Response(
            JSON.stringify({
                candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }],
                usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
        mockFetch.mockResolvedValueOnce(resp);
        const body = { ...TEXT_BODY, generationConfig: { imageConfig: { imageSize: '2K' } } };
        const res = await handleGeminiAdapter(
            req('gemini-3.1-flash-image', 'generateContent', body),
            'yobox',
            'gemini-3.1-flash-image',
            'generateContent',
        );
        const u = ((await res.json()) as { usageMetadata: Usage }).usageMetadata;
        expect(u.candidatesTokenCount).toBe(1680);
        expect(u.promptTokenCount).toBe(5); // 无 details 时退回 promptTokenCount
    });

    it('未知模型族(文本模型)→ usage 原样透传,头标 passthrough', async () => {
        mockFetch.mockResolvedValueOnce(upstreamResponse([[1024, 1024]]));
        const res = await handleGeminiAdapter(
            req('gemini-3.8-flash', 'generateContent', TEXT_BODY),
            'yobox',
            'gemini-3.8-flash',
            'generateContent',
        );
        expect(res.headers.get('X-Silkroadai-Gemini-Adapter')).toBe('passthrough');
        const u = ((await res.json()) as { usageMetadata: Usage }).usageMetadata;
        expect(u.candidatesTokenCount).toBe(599);
    });

    it('streamGenerateContent → 上游走非流式 generateContent,回单条 SSE(usage 已重写)', async () => {
        mockFetch.mockResolvedValueOnce(upstreamResponse([[1024, 1024]]));
        const res = await handleGeminiAdapter(
            req('gemini-nano-banana-2.1', 'streamGenerateContent', TEXT_BODY, undefined, '?alt=sse'),
            'yobox',
            'gemini-nano-banana-2.1',
            'streamGenerateContent',
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/event-stream');
        const [url] = mockFetch.mock.calls[0] as [string];
        expect(url).toMatch(/:generateContent$/);
        const text = await res.text();
        expect(text.startsWith('data: ')).toBe(true);
        expect(text.endsWith('\n\n')).toBe(true);
        const data = JSON.parse(text.slice(6).trim()) as { usageMetadata: Usage };
        expect(data.usageMetadata.candidatesTokenCount).toBe(1120);
    });

    it('鉴权:Authorization Bearer / ?key= 都接受并转成 x-goog-api-key;都没有 → 401 不打上游', async () => {
        mockFetch.mockResolvedValueOnce(upstreamResponse([[1024, 1024]]));
        await handleGeminiAdapter(
            req('gemini-nano-banana-2.1', 'generateContent', TEXT_BODY, { authorization: 'Bearer k-bearer' }),
            'yobox',
            'gemini-nano-banana-2.1',
            'generateContent',
        );
        expect(new Headers((mockFetch.mock.calls[0] as [string, RequestInit])[1].headers).get('x-goog-api-key')).toBe(
            'k-bearer',
        );
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce(upstreamResponse([[1024, 1024]]));
        await handleGeminiAdapter(
            req('gemini-nano-banana-2.1', 'generateContent', TEXT_BODY, {}, '?key=k-query'),
            'yobox',
            'gemini-nano-banana-2.1',
            'generateContent',
        );
        const [url2, init2] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(new Headers(init2.headers).get('x-goog-api-key')).toBe('k-query');
        expect(url2).not.toContain('key=');
        mockFetch.mockReset();
        const res = await handleGeminiAdapter(
            req('gemini-nano-banana-2.1', 'generateContent', TEXT_BODY, {}),
            'yobox',
            'gemini-nano-banana-2.1',
            'generateContent',
        );
        expect(res.status).toBe(401);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('上游 429 → 原状态码透传 + 品牌脱敏;fetch 抛错 → 503 让 new-api failover', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ error: { message: 'YoboxAI: Too many pending requests' } }), {
                status: 429,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const res = await handleGeminiAdapter(
            req('gemini-nano-banana-2.1', 'generateContent', TEXT_BODY),
            'yobox',
            'gemini-nano-banana-2.1',
            'generateContent',
        );
        expect(res.status).toBe(429);
        const text = await res.text();
        expect(text).not.toMatch(/yobox/i);
        expect(text).toContain('the provider');
        mockFetch.mockReset();
        mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
        const res2 = await handleGeminiAdapter(
            req('gemini-nano-banana-2.1', 'generateContent', TEXT_BODY),
            'yobox',
            'gemini-nano-banana-2.1',
            'generateContent',
        );
        expect(res2.status).toBe(503);
    });

    it('未知 provider → 404;非法 action → 404;坏 JSON → 400', async () => {
        const a = await handleGeminiAdapter(
            req('gemini-nano-banana-2.1', 'generateContent', TEXT_BODY),
            'nope',
            'gemini-nano-banana-2.1',
            'generateContent',
        );
        expect(a.status).toBe(404);
        const b = await handleGeminiAdapter(
            req('gemini-nano-banana-2.1', 'countTokens', TEXT_BODY),
            'yobox',
            'gemini-nano-banana-2.1',
            'countTokens',
        );
        expect(b.status).toBe(404);
        const c = await handleGeminiAdapter(
            new NextRequest('http://portal.test/gemini-adapter/yobox/v1beta/models/m:generateContent', {
                method: 'POST',
                headers: { 'x-goog-api-key': 'k' },
                body: '{not json',
            }),
            'yobox',
            'm',
            'generateContent',
        );
        expect(c.status).toBe(400);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
