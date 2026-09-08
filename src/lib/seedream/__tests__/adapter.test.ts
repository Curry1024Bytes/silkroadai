/**
 * seedream-adapter(Seedream 5.0 Pro · service-inference.ai)单测。
 * 覆盖:售价表(quota 精确)、usage 合成、入参归一(输入图四字段 / size 别名 / 透传白名单)、
 * n 扇出与图层拆分单次、返回图实际尺寸计费、上游错误分类与脱敏、鉴权。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
    handleSeedreamImage,
    synthSeedreamUsage,
    outputImageQuota,
    inputImagesQuota,
    sellQuota,
    pixelTier,
    collectInputImages,
    normalizeSize,
    parseIncoming,
    sanitizeUpstreamMessage,
    isSeedreamModel,
    SEEDREAM_MODEL,
    SEEDREAM_UPSTREAM_MODEL,
} from '@/lib/seedream/adapter';

const URL = 'http://portal.test/seedream-adapter/v1/images/generations';

/** 仅 PNG 签名 + IHDR 的最小 buffer 的 base64(够 imageDimensions 读尺寸)。 */
function pngB64(w: number, h: number, colorType = 6): string {
    const buf = Buffer.alloc(26);
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47;
    buf.write('IHDR', 12, 'latin1');
    buf.writeUInt32BE(w, 16);
    buf.writeUInt32BE(h, 20);
    buf[24] = 8;
    buf[25] = colorType;
    return buf.toString('base64');
}

function req(body: unknown, auth: string | null = 'Bearer sk-inf-v1-test'): NextRequest {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) headers.authorization = auth;
    return new NextRequest(URL, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

const fetchMock = vi.fn();
beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

type Item = Record<string, unknown>;
/** 上游成功体(每次调用造新 Response —— body 只能读一次,扇出会读多次)。 */
function upstreamOk(items: Item[], usage: Record<string, unknown> = {}) {
    fetchMock.mockImplementation(
        async () =>
            new Response(
                JSON.stringify({
                    model: 'dola-seedream-5-0-pro-260628',
                    created: 1,
                    data: items,
                    usage: {
                        input_images: 0,
                        generated_images: items.length,
                        output_tokens: 4096,
                        total_tokens: 4096,
                        ...usage,
                    },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
    );
}
function upstreamErr(status: number, body: unknown) {
    fetchMock.mockImplementation(
        async () =>
            new Response(typeof body === 'string' ? body : JSON.stringify(body), {
                status,
                headers: { 'content-type': 'application/json' },
            }),
    );
}
function sentBody(call = 0): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
    return JSON.parse(String(init.body)) as Record<string, unknown>;
}

// ============ 定价 ============

describe('seedream pricing (官方 USD × 0.55 × 6.8;500k quota = ¥1)', () => {
    it('售价表逐 quota 精确', () => {
        expect(sellQuota(0.045)).toBe(84_150); // 普通 ≤2.36MP  ¥0.1683
        expect(sellQuota(0.09)).toBe(168_300); // 普通 >2.36MP  ¥0.3366
        expect(sellQuota(0.0225)).toBe(42_075); // 图层 ≤2.36MP  ¥0.0842
        expect(sellQuota(0.003)).toBe(5_610); // 输入图第 2 张起 ¥0.01122
    });
    it('像素分档:1.5K(1536²=2,359,296)在 low 档内,多 1 像素行即 high', () => {
        expect(pixelTier(1024, 1024)).toBe('low');
        expect(pixelTier(1536, 1536)).toBe('low');
        expect(pixelTier(1537, 1537)).toBe('high');
        expect(pixelTier(2048, 2048)).toBe('high');
        expect(outputImageQuota(1536, 1536, false)).toBe(84_150);
        expect(outputImageQuota(2048, 2048, false)).toBe(168_300);
        expect(outputImageQuota(1020, 806, true)).toBe(42_075);
        expect(outputImageQuota(2048, 2048, true)).toBe(84_150);
    });
    it('输入图:第 1 张免费,第 2 张起按张', () => {
        expect(inputImagesQuota(0)).toBe(0);
        expect(inputImagesQuota(1)).toBe(0);
        expect(inputImagesQuota(2)).toBe(5_610);
        expect(inputImagesQuota(4)).toBe(16_830);
    });
    it('synthSeedreamUsage:input/output 即 quota,附 input_images / generated_images', () => {
        expect(synthSeedreamUsage({ outputs: [{ w: 1024, h: 1024 }], layer: false, inputImages: 2 })).toEqual({
            input_tokens: 5_610,
            output_tokens: 84_150,
            total_tokens: 89_760,
            input_images: 2,
            generated_images: 1,
        });
        // 图层拆分:底图 1024² + 图层 1020×806 + 图层 692×743,各按自身像素走图层表
        const u = synthSeedreamUsage({
            outputs: [
                { w: 1024, h: 1024 },
                { w: 1020, h: 806 },
                { w: 692, h: 743 },
            ],
            layer: true,
            inputImages: 1,
        });
        expect(u.output_tokens).toBe(42_075 * 3);
        expect(u.input_tokens).toBe(0);
        expect(u.generated_images).toBe(3);
    });
});

// ============ 入参归一 ============

describe('seedream 入参归一', () => {
    it('isSeedreamModel 大小写宽容,只认对客名', () => {
        expect(isSeedreamModel('seedream-5-0-pro')).toBe(true);
        expect(isSeedreamModel(' Seedream-5-0-Pro ')).toBe(true);
        expect(isSeedreamModel(SEEDREAM_UPSTREAM_MODEL)).toBe(false);
        expect(isSeedreamModel('gpt-image-2')).toBe(false);
    });
    it('collectInputImages:image / images / image_url / image_urls,string 与 {url} 两形,顺序保留,空串丢', () => {
        expect(collectInputImages({ image: 'a' })).toEqual(['a']);
        expect(collectInputImages({ image: ['a', ' ', { url: 'b' }] })).toEqual(['a', 'b']);
        expect(collectInputImages({ images: ['x'], image_url: 'y', image_urls: ['z'] })).toEqual(['x', 'y', 'z']);
        expect(collectInputImages({})).toEqual([]);
    });
    it('normalizeSize:k 档大写归一,WxH 原样,缺省空', () => {
        expect(normalizeSize('1k')).toBe('1K');
        expect(normalizeSize('1.5k ')).toBe('1.5K');
        expect(normalizeSize('2048x2048')).toBe('2048x2048');
        expect(normalizeSize(undefined)).toBe('');
    });
    it('parseIncoming:resolution 别名、透传白名单、水印缺省关、quality/style 丢弃', () => {
        const p = parseIncoming({
            prompt: ' hi ',
            resolution: '2k',
            n: '3',
            quality: 'high',
            style: 'vivid',
            web_search: true,
            seed: 7,
            output_format: 'png',
        });
        expect(p.prompt).toBe('hi');
        expect(p.size).toBe('2K');
        expect(p.n).toBe(3);
        expect(p.extras).toEqual({ web_search: true, seed: 7, output_format: 'png', watermark: false });
        expect(parseIncoming({ prompt: 'x', watermark: true }).extras.watermark).toBe(true);
        expect(parseIncoming({ prompt: 'x', n: 0 }).n).toBe(1);
    });
    it('sanitizeUpstreamMessage:抹上游品牌 / 内部码,上游模型名换成对客名', () => {
        const s = sanitizeUpstreamMessage(
            `service-inference.ai ERR_PROVIDER_005: model ${SEEDREAM_UPSTREAM_MODEL} from dola/volcengine rejected size`,
        );
        expect(s).not.toMatch(/service-?inference|ERR_PROVIDER|dola|volcengine/i);
        expect(s).toContain(SEEDREAM_MODEL);
    });
});

// ============ 主流程 ============

describe('handleSeedreamImage', () => {
    it('无 / 非 sk- 鉴权 → 401,不打上游', async () => {
        expect((await handleSeedreamImage(req({ model: SEEDREAM_MODEL, prompt: 'x' }, null))).status).toBe(401);
        expect((await handleSeedreamImage(req({ model: SEEDREAM_MODEL, prompt: 'x' }, 'Bearer nope'))).status).toBe(
            401,
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('非 JSON / 非本模型 / 缺 prompt → 400 终态', async () => {
        expect((await handleSeedreamImage(req('not json'))).status).toBe(400);
        const r = await handleSeedreamImage(req({ model: 'gpt-image-2', prompt: 'x' }));
        expect(r.status).toBe(400);
        expect(((await r.json()) as { error: { code: string } }).error.code).toBe('model_not_found');
        expect((await handleSeedreamImage(req({ model: SEEDREAM_MODEL }))).status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('图层拆分必须恰好 1 张输入图;参考图 >10 张拒', async () => {
        const r0 = await handleSeedreamImage(req({ model: SEEDREAM_MODEL, prompt: 'x', layer_decomposition: true }));
        expect(r0.status).toBe(400);
        const r2 = await handleSeedreamImage(
            req({ model: SEEDREAM_MODEL, prompt: 'x', layer_decomposition: true, image: ['a', 'b'] }),
        );
        expect(r2.status).toBe(400);
        const r11 = await handleSeedreamImage(
            req({ model: SEEDREAM_MODEL, prompt: 'x', image: Array.from({ length: 11 }, (_, i) => `u${i}`) }),
        );
        expect(r11.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('翻译:上游模型名 / 恒 b64_json / size 归一 / image 数组 / 白名单透传 / 鉴权透传', async () => {
        upstreamOk([{ b64_json: pngB64(1024, 1024), size: '1024x1024', output_format: 'jpeg' }]);
        const res = await handleSeedreamImage(
            req({
                model: SEEDREAM_MODEL,
                prompt: 'apple',
                size: '1.5k',
                response_format: 'url',
                image: 'data:image/png;base64,QUJD',
                quality: 'high',
                style: 'vivid',
                user: 'u1',
                web_search: true,
                seed: 7,
                output_format: 'jpeg',
            }),
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://model.service-inference.ai/v1/images/generations');
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-inf-v1-test');
        const sent = sentBody();
        expect(sent.model).toBe(SEEDREAM_UPSTREAM_MODEL);
        expect(sent.response_format).toBe('b64_json'); // 客户的 url 由代理回程存图床实现
        expect(sent.size).toBe('1.5K');
        expect(sent.image).toEqual(['data:image/png;base64,QUJD']);
        expect(sent.watermark).toBe(false);
        expect(sent.web_search).toBe(true);
        expect(sent.seed).toBe(7);
        expect(sent.output_format).toBe('jpeg');
        expect(sent).not.toHaveProperty('quality');
        expect(sent).not.toHaveProperty('style');
        expect(sent).not.toHaveProperty('user');
        expect(sent).not.toHaveProperty('layer_decomposition');
    });

    it('成功体:b64 + size + output_format 原样,附 usage(quota),不带内部 w/h,model 为对客名', async () => {
        upstreamOk([{ b64_json: pngB64(1024, 1024), size: '1024x1024', output_format: 'jpeg' }]);
        const res = await handleSeedreamImage(req({ model: SEEDREAM_MODEL, prompt: 'apple' }));
        const j = (await res.json()) as {
            model: string;
            data: Array<Record<string, unknown>>;
            usage: Record<string, number>;
        };
        expect(j.model).toBe(SEEDREAM_MODEL);
        expect(j.data).toHaveLength(1);
        expect(j.data[0].b64_json).toBe(pngB64(1024, 1024));
        expect(j.data[0].size).toBe('1024x1024');
        expect(j.data[0].output_format).toBe('jpeg');
        expect(j.data[0]).not.toHaveProperty('w');
        expect(j.data[0]).not.toHaveProperty('url');
        expect(j.usage).toEqual({
            input_tokens: 0,
            output_tokens: 84_150,
            total_tokens: 84_150,
            input_images: 0,
            generated_images: 1,
        });
        expect(sentBody().size).toBeUndefined(); // 缺省不传 size,上游默认 2K
    });

    it('计费尺寸:上游没给 size 字段 → 读图字节头;2K 走 high 档', async () => {
        upstreamOk([{ b64_json: pngB64(2048, 2048) }]);
        const res = await handleSeedreamImage(req({ model: SEEDREAM_MODEL, prompt: 'x', size: '2K' }));
        const j = (await res.json()) as { data: Array<{ size: string }>; usage: { output_tokens: number } };
        expect(j.data[0].size).toBe('2048x2048');
        expect(j.usage.output_tokens).toBe(168_300);
    });

    it('输入图计费以上游 usage.input_images 为准(第 1 张免费)', async () => {
        upstreamOk([{ b64_json: pngB64(1024, 1024), size: '1024x1024' }], { input_images: 2 });
        const res = await handleSeedreamImage(req({ model: SEEDREAM_MODEL, prompt: 'x', image: ['a', 'b'] }));
        const j = (await res.json()) as { usage: Record<string, number> };
        expect(j.usage.input_tokens).toBe(5_610);
        expect(j.usage.input_images).toBe(2);
        expect(j.usage.total_tokens).toBe(89_760);
    });

    it('n>1 本层扇出(上游忽略 n):3 次上游调用、3 张、按张累计;n>10 钳到 10', async () => {
        upstreamOk([{ b64_json: pngB64(1024, 1024), size: '1024x1024' }]);
        const res = await handleSeedreamImage(req({ model: SEEDREAM_MODEL, prompt: 'x', n: 3 }));
        const j = (await res.json()) as { data: unknown[]; usage: Record<string, number> };
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(sentBody()).not.toHaveProperty('n');
        expect(j.data).toHaveLength(3);
        expect(j.usage.output_tokens).toBe(84_150 * 3);
        expect(j.usage.generated_images).toBe(3);

        fetchMock.mockClear();
        await handleSeedreamImage(req({ model: SEEDREAM_MODEL, prompt: 'x', n: 12 }));
        expect(fetchMock).toHaveBeenCalledTimes(10);
    });

    it('扇出部分失败 → 返回拿到的张数、只按实际计费', async () => {
        let seq = 0;
        fetchMock.mockImplementation(async () => {
            seq++;
            if (seq === 2) return new Response('{"error":{"message":"boom"}}', { status: 500 });
            return new Response(
                JSON.stringify({ data: [{ b64_json: pngB64(1024, 1024), size: '1024x1024' }], usage: {} }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        });
        const res = await handleSeedreamImage(req({ model: SEEDREAM_MODEL, prompt: 'x', n: 2 }));
        expect(res.status).toBe(200);
        const j = (await res.json()) as { data: unknown[]; usage: Record<string, number> };
        expect(j.data).toHaveLength(1);
        expect(j.usage.output_tokens).toBe(84_150);
    });

    it('图层拆分:单次上游(n 无效)、image 单字符串、prompt 可空、扩展字段原样、按图层表计费', async () => {
        upstreamOk(
            [
                { b64_json: pngB64(1024, 1024, 2), size: '1024x1024', output_format: 'png', z_index: 0 },
                {
                    b64_json: pngB64(1020, 806),
                    size: '1020x806',
                    output_format: 'png',
                    z_index: 1,
                    bounding_box: { absolute: [1, 214, 1021, 1020], normalized: [1, 209, 996, 995] },
                    name: '桌面与背景',
                    description: 'desc',
                },
                { b64_json: pngB64(2048, 2048), size: '2048x2048', output_format: 'png', z_index: 2 },
            ],
            { input_images: 1 },
        );
        const res = await handleSeedreamImage(
            req({
                model: SEEDREAM_MODEL,
                prompt: ' ',
                image: ['https://x/poster.png'],
                layer_decomposition: true,
                n: 3,
            }),
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const sent = sentBody();
        expect(sent.layer_decomposition).toBe(true);
        expect(sent.image).toBe('https://x/poster.png');
        expect(sent.prompt).toBe('');
        const j = (await res.json()) as { data: Array<Record<string, unknown>>; usage: Record<string, number> };
        expect(j.data).toHaveLength(3);
        expect(j.data[1].z_index).toBe(1);
        expect(j.data[1].bounding_box).toEqual({ absolute: [1, 214, 1021, 1020], normalized: [1, 209, 996, 995] });
        expect(j.data[1].name).toBe('桌面与背景');
        expect(j.data[2].z_index).toBe(2);
        expect(j.usage.output_tokens).toBe(42_075 + 42_075 + 84_150);
        expect(j.usage.generated_images).toBe(3);
        expect(j.usage.input_tokens).toBe(0);
    });

    it('上游返 url 而非 b64 → 拉下来转 b64,绝不外泄上游 url', async () => {
        let seq = 0;
        fetchMock.mockImplementation(async () => {
            seq++;
            if (seq === 1)
                return new Response(
                    JSON.stringify({ data: [{ url: 'https://tos.volces.com/x.jpeg', size: '1024x1024' }], usage: {} }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            return new Response(Buffer.from(pngB64(1024, 1024), 'base64'), { status: 200 });
        });
        const res = await handleSeedreamImage(req({ model: SEEDREAM_MODEL, prompt: 'x' }));
        const j = (await res.json()) as { data: Array<Record<string, unknown>> };
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(j.data[0].b64_json).toBe(pngB64(1024, 1024));
        expect(j.data[0]).not.toHaveProperty('url');
    });

    it('上游 4xx 参数错 → 400 invalid_request,message 脱敏、param 保留', async () => {
        upstreamErr(400, {
            error: {
                message:
                    'The parameter `size` specified in the request are not valid: image area must be at most 4624220 pixels',
                type: 'server_error',
                code: 'ERR_PROVIDER_005',
                param: 'size',
                upstream_code: 'InvalidParameter',
            },
            request_id: 'r1',
        });
        const res = await handleSeedreamImage(req({ model: SEEDREAM_MODEL, prompt: 'x', size: '3072x1536' }));
        expect(res.status).toBe(400);
        const j = (await res.json()) as { error: { code: string; param: string; message: string; type: string } };
        expect(j.error.code).toBe('invalid_request');
        expect(j.error.param).toBe('size');
        expect(j.error.type).toBe('invalid_request_error');
        expect(j.error.message).toContain('at most 4624220 pixels');
        expect(j.error.message).not.toMatch(/ERR_PROVIDER|service-?inference|dola/i);
    });

    it('上游内容审核拒绝 → 400 moderation_blocked + 「content rejected」文案(代理层统一改写)', async () => {
        upstreamErr(400, { error: { message: 'InputTextSensitiveContentDetected: prompt flagged', code: 'ERR_X_1' } });
        const res = await handleSeedreamImage(req({ model: SEEDREAM_MODEL, prompt: 'x' }));
        expect(res.status).toBe(400);
        const j = (await res.json()) as { error: { code: string; message: string } };
        expect(j.error.code).toBe('moderation_blocked');
        expect(j.error.message).toContain('content rejected');
    });

    it('上游 5xx / 429 / 网络失败 / 200 无图 → 502 server_error,不合成 usage', async () => {
        upstreamErr(500, { error: { message: 'internal' } });
        let res = await handleSeedreamImage(req({ model: SEEDREAM_MODEL, prompt: 'x' }));
        expect(res.status).toBe(502);
        expect(((await res.json()) as { error: { type: string } }).error.type).toBe('server_error');

        upstreamErr(429, { error: { message: 'rate limited' } });
        expect((await handleSeedreamImage(req({ model: SEEDREAM_MODEL, prompt: 'x' }))).status).toBe(502);

        fetchMock.mockImplementation(async () => {
            throw new Error('ECONNRESET');
        });
        expect((await handleSeedreamImage(req({ model: SEEDREAM_MODEL, prompt: 'x' }))).status).toBe(502);

        upstreamOk([]);
        res = await handleSeedreamImage(req({ model: SEEDREAM_MODEL, prompt: 'x' }));
        expect(res.status).toBe(502);
        expect(await res.text()).not.toContain('usage');
    });
});
