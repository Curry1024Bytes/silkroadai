/**
 * image-adapter(按张计费上游伪装 azure gpt-image-2)单测。
 * 覆盖:守门(4K 全档 + 2K-high,其余 503 failover)、usage 合成数值(OUT_TOKENS 口径)、
 * 上游失败不合成 usage、multipart edits 解析、错误脱敏、透传字段。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
    handleAdapterImage,
    sizeTier,
    isProfitable,
    synthUsage,
    estimateTextTokens,
    sanitizeAdapterError,
} from '@/lib/image-adapter/adapter';

const URL_GEN = 'http://portal.test/image-adapter/ominiapi/v1/images/generations';
const URL_EDIT = 'http://portal.test/image-adapter/ominiapi/v1/images/edits';

// 1×1 PNG(佐 imageDimensions 解析;IHDR w=1 h=1)
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

function jsonReq(url: string, body: unknown): NextRequest {
    return new NextRequest(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-upstream-test' },
        body: JSON.stringify(body),
    });
}

function formReq(url: string, fields: Record<string, string>, images: Buffer[] = []): NextRequest {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    for (const img of images) f.append('image', new Blob([new Uint8Array(img)], { type: 'image/png' }), 'in.png');
    return new NextRequest(url, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-upstream-test' },
        body: f,
    });
}

const fetchMock = vi.fn();

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

function okUpstream(nImages = 1) {
    fetchMock.mockResolvedValue(
        new Response(
            JSON.stringify({
                created: 1234,
                data: Array.from({ length: nImages }, (_, i) => ({ b64_json: `img${i}` })),
                usage: { input_tokens: 1, output_tokens: 1120, total_tokens: 1121 }, // 上游假 usage,必须被丢弃
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
}

describe('sizeTier / isProfitable(守门口径)', () => {
    it('按面积就近分档', () => {
        expect(sizeTier('1024x1024')).toBe('1k');
        expect(sizeTier('1536x1024')).toBe('1.5k');
        expect(sizeTier('2048x2048')).toBe('2k');
        expect(sizeTier('3840x2160')).toBe('4k');
        expect(sizeTier('3200x2000')).toBe('4k'); // 6.4MP 靠近 8.29M
    });
    it('auto / 缺省 / 比例串 → null(不明确不放行)', () => {
        expect(sizeTier('auto')).toBe(null);
        expect(sizeTier('')).toBe(null);
        expect(sizeTier('16:9')).toBe(null);
    });
    it('4K 全档放行;2K 仅 high;其余全拒', () => {
        expect(isProfitable('4k', 'low')).toBe(true);
        expect(isProfitable('4k', 'medium')).toBe(true);
        expect(isProfitable('4k', 'high')).toBe(true);
        expect(isProfitable('2k', 'high')).toBe(true);
        expect(isProfitable('2k', 'medium')).toBe(false);
        expect(isProfitable('2k', 'low')).toBe(false);
        expect(isProfitable('1k', 'high')).toBe(false);
        expect(isProfitable('1.5k', 'high')).toBe(false);
        expect(isProfitable(null, 'high')).toBe(false);
    });
});

describe('synthUsage(合成数值 = OUT_TOKENS 口径)', () => {
    it('4k·medium 单图 = 3800 输出 token(≈真 4K 渠道 avg_ct 3777,售价锚 ¥0.25)', () => {
        const u = synthUsage({
            mode: 'generations',
            tier: '4k',
            quality: 'medium',
            prompt: 'a cat',
            inputImageDims: [],
            imageCount: 1,
        });
        expect(u.output_tokens).toBe(3800);
        expect(u.completion_tokens).toBe(3800); // 中继别名字段
        expect(u.input_tokens).toBe(estimateTextTokens('a cat'));
        expect(u.total_tokens).toBe(3800 + estimateTextTokens('a cat'));
    });
    it('4k·high=14000 / 4k·low=1000 / 2k·high=12000', () => {
        const mk = (tier: '2k' | '4k', quality: 'low' | 'medium' | 'high') =>
            synthUsage({ mode: 'generations', tier, quality, prompt: 'x', inputImageDims: [], imageCount: 1 });
        expect(mk('4k', 'high').output_tokens).toBe(14000);
        expect(mk('4k', 'low').output_tokens).toBe(1000);
        expect(mk('2k', 'high').output_tokens).toBe(12000);
    });
    it('多图 ct×张数;edits 输入图计入 input(85 + MP×1500,MP 封顶 2,读不出按 1MP)', () => {
        const u = synthUsage({
            mode: 'edits',
            tier: '4k',
            quality: 'medium',
            prompt: 'edit',
            inputImageDims: [{ w: 2048, h: 2048 }, null],
            imageCount: 2,
        });
        expect(u.output_tokens).toBe(3800 * 2);
        // 2048²=4.19MP→ceil 5→封顶 2 → 85+3000;null→1MP → 85+1500
        expect(u.input_tokens).toBe(estimateTextTokens('edit') + (85 + 2 * 1500) + (85 + 1500));
        const details = u.input_tokens_details as { text_tokens: number; image_tokens: number };
        expect(details.image_tokens).toBe(85 + 3000 + 85 + 1500);
    });

    it('4K 输入图 MP 封顶:8.3MP 也只算 2MP(azure 会降采样,防多图 edits 计费爆表)', () => {
        const u = synthUsage({
            mode: 'edits',
            tier: '2k',
            quality: 'high',
            prompt: 'x',
            inputImageDims: [
                { w: 3840, h: 2160 },
                { w: 3840, h: 2160 },
                { w: 3840, h: 2160 },
                { w: 3840, h: 2160 },
            ],
            imageCount: 1,
        });
        const details = u.input_tokens_details as { text_tokens: number; image_tokens: number };
        expect(details.image_tokens).toBe(4 * (85 + 3000)); // 不封顶时是 4×13585=54340
    });
});

describe('handleAdapterImage 守门(调上游之前拒,返 503 让 new-api failover)', () => {
    it.each([
        ['1k', { size: '1024x1024' }],
        ['2k medium', { size: '2048x2048' }],
        ['2k low', { size: '2048x2048', quality: 'low' }],
        ['size auto', { size: 'auto' }],
        ['size 缺省', {}],
    ])('%s → 503 且不打上游', async (_label, extra) => {
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', ...extra }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
        const body = await res.json();
        expect(body.error.code).toBe('upstream_unavailable');
    });

    it('503 响应体不含任何内部信息(全渠道挂时 new-api 会把它原文透给客户)', async () => {
        // 守门拒(带 size/tier 上下文)+ 上游错误(带上游原文)两类都验
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({ error: { message: 'ominiapi says: bad image, contact ops@omini.example' } }),
                {
                    status: 400,
                },
            ),
        );
        const cases = await Promise.all([
            handleAdapterImage(jsonReq(URL_GEN, { prompt: 'x', size: '1024x1024' }), 'generations', 'ominiapi'),
            handleAdapterImage(jsonReq(URL_GEN, { prompt: 'x', size: '3840x2160' }), 'generations', 'ominiapi'),
        ]);
        for (const res of cases) {
            expect(res.status).toBe(503);
            const body = await res.json();
            expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'type']);
            const text = JSON.stringify(body).toLowerCase();
            for (const leak of ['omini', 'tier', 'size', 'quality', 'channel', 'adapter', 'provider', 'ops@']) {
                expect(text).not.toContain(leak);
            }
        }
    });

    it('2K + high 放行', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '2048x2048', quality: 'high' }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.usage.output_tokens).toBe(12000);
    });

    it('4K + low 放行(operator 拍板全档)', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', quality: 'low' }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.usage.output_tokens).toBe(1000);
    });
});

describe('handleAdapterImage 成功路径', () => {
    it('4K generations:上游假 usage 被替换成合成值,data 原样透传', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'a 4k cat', size: '3840x2160' }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual([{ b64_json: 'img0' }]);
        expect(body.usage.output_tokens).toBe(3800); // 不是上游的 1120
        expect(body.usage.input_tokens).toBe(estimateTextTokens('a 4k cat'));
        // 上游收到的请求:model 强制 gpt-image-2、JSON content-type、Authorization 透传
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://www.ominiapi.com/v1/images/generations');
        expect(init.headers['content-type']).toBe('application/json');
        expect(init.headers.authorization).toBe('Bearer sk-upstream-test');
        const sent = JSON.parse(init.body as string);
        expect(sent.model).toBe('gpt-image-2');
        expect(sent.size).toBe('3840x2160');
        expect(sent.response_format).toBe('b64_json'); // 缺省时 ominiapi 返自家 OSS url,必须显式要 b64
    });

    it('上游返 url(response_format 被无视)→ 拉下来转 b64,绝不外泄上游 URL', async () => {
        fetchMock
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ created: 1, data: [{ url: 'https://oss-upstream.example.com/x.png' }] }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                ),
            )
            .mockResolvedValueOnce(new Response(Buffer.from('pngbytes'), { status: 200 }));
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160' }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual([{ b64_json: Buffer.from('pngbytes').toString('base64') }]);
        expect(JSON.stringify(body)).not.toContain('oss-upstream');
        expect(fetchMock.mock.calls[1][0]).toBe('https://oss-upstream.example.com/x.png');
    });

    it('上游返 url 但拉取失败 → 503(不合成 usage,不外泄)', async () => {
        fetchMock
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ created: 1, data: [{ url: 'https://oss-upstream.example.com/x.png' }] }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                ),
            )
            .mockResolvedValueOnce(new Response('gone', { status: 404 }));
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160' }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(503);
        expect((await res.json()).error.code).toBe('upstream_unavailable');
    });

    it('n>1 按上游真实出图张数累加 ct', async () => {
        okUpstream(3);
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', n: 3 }),
            'generations',
            'ominiapi',
        );
        const body = await res.json();
        expect(body.usage.output_tokens).toBe(3800 * 3);
    });

    it('multipart edits:解析 prompt/size/quality + 输入图透传上游 + 输入图 token 计入', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            formReq(URL_EDIT, { model: 'gpt-image-2', prompt: 'edit it', size: '3840x2160', quality: 'high' }, [
                TINY_PNG,
            ]),
            'edits',
            'ominiapi',
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.usage.output_tokens).toBe(14000);
        // 1×1 PNG → 1MP 兜底:85+1500
        expect(body.usage.input_tokens_details.image_tokens).toBe(85 + 1500);
        // 上游收到 multipart(fetch 自动 boundary;不能手写 content-type)
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://www.ominiapi.com/v1/images/edits');
        expect(init.body).toBeInstanceOf(FormData);
        expect(init.headers['content-type']).toBeUndefined();
        const sentForm = init.body as FormData;
        expect(sentForm.get('model')).toBe('gpt-image-2');
        expect(sentForm.get('response_format')).toBe('b64_json');
        expect(sentForm.getAll('image')).toHaveLength(1);
    });
});

describe('handleAdapterImage 失败路径(不合成 usage → new-api 不扣费)', () => {
    it('上游 4xx → 503 failover(网关拒不终态化)+ 品牌名脱敏', async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ error: { message: 'ominiapi quota exceeded' } }), { status: 402 }),
        );
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160' }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(503);
        const text = JSON.stringify(await res.json());
        expect(text.toLowerCase()).not.toContain('omini');
    });

    it('上游 fetch 抛错(超时/断连)→ 503', async () => {
        fetchMock.mockRejectedValue(new Error('network down'));
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160' }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(503);
    });

    it('上游 200 但无图 → 503(绝不给空图合成 usage)', async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ created: 1, data: [] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160' }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(503);
        expect((await res.json()).error.code).toBe('upstream_unavailable');
    });

    it('未知 provider → 503(配置错也走 failover,客户无感)', async () => {
        const res = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/nope/v1/images/generations', {
                prompt: 'x',
                size: '3840x2160',
            }),
            'generations',
            'nope',
        );
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('缺 Authorization → 401', async () => {
        const req = new NextRequest(URL_GEN, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: 'x', size: '3840x2160' }),
        });
        const res = await handleAdapterImage(req, 'generations', 'ominiapi');
        expect(res.status).toBe(401);
    });
});

describe('sanitizeAdapterError', () => {
    it('抹 provider 品牌名与 adobe', () => {
        const out = sanitizeAdapterError('OminiAPI rejected; adobe unsafe', /\bomini(?:api)?\b/gi);
        expect(out.toLowerCase()).not.toContain('omini');
        expect(out.toLowerCase()).not.toContain('adobe');
    });
});
