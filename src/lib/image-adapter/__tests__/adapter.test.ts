/**
 * image-adapter(按张计费上游伪装 azure gpt-image-2)单测。
 * 覆盖:守门(合成售价 ≥ 守门线,线下 503 failover)、usage 合成数值(官方计算器公式,
 * 逐 token 对齐)、上游失败不合成 usage、multipart edits 解析、错误脱敏、透传字段。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
    handleAdapterImage,
    parseSize,
    officialOutputTokens,
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

/** ⚠️ 必须 mockImplementation 每次造【新】Response:Response body 只能读一次,
 *  用 mockResolvedValue 复用同一个对象会让扇出的第 2..n 次调用读 body 失败(伪装成"上游失败"),
 *  测试会以错误的理由通过。 */
function okUpstream(nImages = 1) {
    let seq = 0;
    fetchMock.mockImplementation(async () => {
        const s = seq++;
        return new Response(
            JSON.stringify({
                created: 1234,
                data: Array.from({ length: nImages }, (_, i) => ({ b64_json: `img${s}-${i}` })),
                usage: { input_tokens: 1, output_tokens: 1120, total_tokens: 1121 }, // 上游假 usage,必须被丢弃
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    });
}

describe('parseSize', () => {
    it('WxH → 宽高', () => {
        expect(parseSize('1024x1024')).toEqual({ w: 1024, h: 1024 });
        expect(parseSize('2160x3840')).toEqual({ w: 2160, h: 3840 });
        expect(parseSize(' 3840x2160 ')).toEqual({ w: 3840, h: 2160 });
    });
    it('auto / 缺省 / 比例串 → null(不明确不放行)', () => {
        expect(parseSize('auto')).toBe(null);
        expect(parseSize('')).toBe(null);
        expect(parseSize('16:9')).toBe(null);
    });
});

describe('officialOutputTokens(官方计算器逐 token 口径,2026-08-11 采样验证)', () => {
    // 每一行都是官方计算器实采的 ground truth,不是自算的期望值
    it.each([
        [1024, 1024, 'low', 196],
        [1024, 1024, 'medium', 1756],
        [1024, 1024, 'high', 7024],
        [1536, 1024, 'high', 5488],
        [1024, 1536, 'medium', 1372],
        [2048, 1152, 'high', 5650],
        [2048, 2048, 'high', 14272],
        [2560, 1440, 'high', 7370],
        [1280, 720, 'high', 3787],
        [3840, 2160, 'low', 371],
        [3840, 2160, 'medium', 3336],
        [3840, 2160, 'high', 13342],
        [2160, 3840, 'high', 13342], // 客户实拍案例(2026-08-11 投诉截图):必须与官方计算器一致
    ] as const)('%dx%d %s = %d', (w, h, q, expected) => {
        expect(officialOutputTokens(w, h, q)).toBe(expected);
    });
    it('宽高对称', () => {
        expect(officialOutputTokens(1536, 1024, 'medium')).toBe(officialOutputTokens(1024, 1536, 'medium'));
    });
});

describe('isProfitable(守门线 = 合成售价 ≥ ¥0.15 ≈ 3,846 token)', () => {
    it('high 常用尺寸全过线;low/auto/standard 与小尺寸 medium 全在线下', () => {
        const ct = (w: number, h: number, q: 'low' | 'medium' | 'high') => officialOutputTokens(w, h, q);
        // 过线:high 家族 + 大方图 medium
        expect(isProfitable(ct(3840, 2160, 'high'))).toBe(true);
        expect(isProfitable(ct(2048, 2048, 'high'))).toBe(true);
        expect(isProfitable(ct(1024, 1024, 'high'))).toBe(true); // 新扩:1K-high(adobe 上超时重灾区)
        expect(isProfitable(ct(1536, 1024, 'high'))).toBe(true);
        expect(isProfitable(ct(2560, 2560, 'medium'))).toBe(true);
        // 线下:低档全族 + 小尺寸 medium(回 adobe 兜底)
        expect(isProfitable(ct(3840, 2160, 'low'))).toBe(false); // 371 —— 旧守门放行 4K 全档,现在拒
        expect(isProfitable(ct(3840, 2160, 'medium'))).toBe(false); // 3,336,差一点
        expect(isProfitable(ct(1024, 1024, 'medium'))).toBe(false);
        expect(isProfitable(ct(2048, 2048, 'medium'))).toBe(false);
        expect(isProfitable(ct(1280, 720, 'high'))).toBe(false); // 3,787 < 3,846,极小 high 也不亏收
        expect(isProfitable(0)).toBe(false);
    });
});

describe('synthUsage(合成数值 = 官方公式口径)', () => {
    it('4K·high 单图 = 13,342 输出 token(与官方计算器一致)+ 只发 OpenAI images 官方字段', () => {
        const u = synthUsage({
            mode: 'generations',
            w: 3840,
            h: 2160,
            quality: 'high',
            prompt: 'a cat',
            inputImageDims: [],
            imageCount: 1,
        });
        expect(u.output_tokens).toBe(13342);
        // 只发 OpenAI images 官方字段:多送 chat 别名会被中继客户【加】进 chat 家族 → 账面翻倍
        expect(Object.keys(u).sort()).toEqual([
            'input_tokens',
            'input_tokens_details',
            'output_tokens',
            'output_tokens_details',
            'total_tokens',
        ]);
        expect(u.prompt_tokens).toBeUndefined();
        expect(u.completion_tokens).toBeUndefined();
        expect(u.input_tokens).toBe(estimateTextTokens('a cat'));
        expect(u.total_tokens).toBe(13342 + estimateTextTokens('a cat'));
    });
    it('尺寸不同数值不同(告别打平表:2048² 与 2560×1440 同为 high 但不同价)', () => {
        const mk = (w: number, h: number) =>
            synthUsage({ mode: 'generations', w, h, quality: 'high', prompt: 'x', inputImageDims: [], imageCount: 1 });
        expect(mk(2048, 2048).output_tokens).toBe(14272);
        expect(mk(2560, 1440).output_tokens).toBe(7370);
        expect(mk(2160, 3840).output_tokens).toBe(13342);
    });
    it('多图 ct×张数;edits 输入图计入 input(85 + MP×1500,MP 封顶 2,读不出按 1MP)', () => {
        const u = synthUsage({
            mode: 'edits',
            w: 3840,
            h: 2160,
            quality: 'high',
            prompt: 'edit',
            inputImageDims: [{ w: 2048, h: 2048 }, null],
            imageCount: 2,
        });
        expect(u.output_tokens).toBe(13342 * 2);
        // 2048²=4.19MP→ceil 5→封顶 2 → 85+3000;null→1MP → 85+1500
        expect(u.input_tokens).toBe(estimateTextTokens('edit') + (85 + 2 * 1500) + (85 + 1500));
        const details = u.input_tokens_details as { text_tokens: number; image_tokens: number };
        expect(details.image_tokens).toBe(85 + 3000 + 85 + 1500);
    });

    it('4K 输入图 MP 封顶:8.3MP 也只算 2MP(azure 会降采样,防多图 edits 计费爆表)', () => {
        const u = synthUsage({
            mode: 'edits',
            w: 2048,
            h: 2048,
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
        ['1k 缺省 quality(→low)', { size: '1024x1024' }],
        ['1k medium', { size: '1024x1024', quality: 'medium' }],
        ['2k medium', { size: '2048x2048', quality: 'medium' }],
        ['2k low', { size: '2048x2048', quality: 'low' }],
        ['4K low(旧守门放行,售价制拒)', { size: '3840x2160', quality: 'low' }],
        ['4K auto(→low)', { size: '3840x2160', quality: 'auto' }],
        ['4K standard(→low)', { size: '3840x2160', quality: 'standard' }],
        ['4K 缺省 quality(→low)', { size: '3840x2160' }],
        ['size auto', { size: 'auto', quality: 'high' }],
        ['size 缺省', { quality: 'high' }],
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
        // 守门拒(带 size/ct 上下文)+ 上游错误(带上游原文)两类都验
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
            handleAdapterImage(
                jsonReq(URL_GEN, { prompt: 'x', size: '3840x2160', quality: 'high' }),
                'generations',
                'ominiapi',
            ),
        ]);
        for (const res of cases) {
            expect(res.status).toBe(503);
            const body = await res.json();
            expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'type']);
            const text = JSON.stringify(body).toLowerCase();
            for (const leak of ['omini', 'gate', 'size', 'quality', 'channel', 'adapter', 'provider', 'ops@']) {
                expect(text).not.toContain(leak);
            }
        }
    });

    it.each([
        ['2K high', '2048x2048', 14272],
        ['1K high(新扩:adobe 超时重灾区)', '1024x1024', 7024],
        ['1.5K high(新扩)', '1536x1024', 5488],
        ['大方图 medium(新扩)', '2560x2560', 4927],
    ])('%s 放行', async (_label, size, expectedCt) => {
        okUpstream();
        const quality = size === '2560x2560' ? 'medium' : 'high';
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size, quality }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.usage.output_tokens).toBe(expectedCt);
    });
});

describe('handleAdapterImage 成功路径', () => {
    it('4K generations:上游假 usage 被替换成合成值,data 原样透传', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'a 4k cat', size: '3840x2160', quality: 'high' }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual([{ b64_json: 'img0-0' }]);
        expect(body.usage.output_tokens).toBe(13342); // 不是上游的 1120
        expect(body.usage.input_tokens).toBe(estimateTextTokens('a 4k cat'));
        // 上游收到的请求:model 强制 gpt-image-2、JSON content-type、Authorization 透传
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.ominiapi.com/v1/images/generations');
        expect(init.headers['content-type']).toBe('application/json');
        expect(init.headers.authorization).toBe('Bearer sk-upstream-test');
        const sent = JSON.parse(init.body as string);
        expect(sent.model).toBe('gpt-image-2');
        expect(sent.size).toBe('3840x2160');
        expect(sent.quality).toBe('high');
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
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', quality: 'high' }),
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
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', quality: 'high' }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(503);
        expect((await res.json()).error.code).toBe('upstream_unavailable');
    });

    it('n=1 只打一次上游', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', quality: 'high' }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('handleAdapterImage n>1 并发扇出(ominiapi 忽略 n,只能自己扇)', () => {
    it('n=4 → 打 4 次上游、返 4 张、ct 按 4 张算,且不给上游传 n', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', quality: 'high', n: 4 }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(4);
        const body = await res.json();
        expect(body.data).toHaveLength(4);
        expect(new Set(body.data.map((d: { b64_json: string }) => d.b64_json)).size).toBe(4); // 4 张互不相同
        expect(body.usage.output_tokens).toBe(13342 * 4);
        // 每次上游调用都只要 1 张 —— 传 n 给 ominiapi 无效,反而会混淆
        for (const [, init] of fetchMock.mock.calls) {
            expect(JSON.parse(init.body as string).n).toBeUndefined();
        }
    });

    it('n 任意值都生效(不是写死 4):n=2 / n=7', async () => {
        for (const n of [2, 7]) {
            fetchMock.mockReset();
            okUpstream();
            const res = await handleAdapterImage(
                jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', quality: 'high', n }),
                'generations',
                'ominiapi',
            );
            expect(fetchMock).toHaveBeenCalledTimes(n);
            expect((await res.json()).usage.output_tokens).toBe(13342 * n);
        }
    });

    it('n 超过 10 钳到 10(不报错,防单请求内存爆表)', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', quality: 'high', n: 50 }),
            'generations',
            'ominiapi',
        );
        expect(fetchMock).toHaveBeenCalledTimes(10);
        expect((await res.json()).data).toHaveLength(10);
    });

    it('部分失败 → 返回拿到的那几张,按实际张数计费(不 failover)', async () => {
        let call = 0;
        fetchMock.mockImplementation(async () => {
            const i = call++;
            if (i % 2 === 0) return new Response('{"error":{"message":"busy"}}', { status: 429 });
            return new Response(JSON.stringify({ data: [{ b64_json: `ok${i}` }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', quality: 'high', n: 4 }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toHaveLength(2);
        expect(body.usage.output_tokens).toBe(13342 * 2); // 只收 2 张的钱
    });

    it('全部失败 → 503 failover(不合成 usage)', async () => {
        fetchMock.mockImplementation(async () => new Response('{"error":{}}', { status: 500 }));
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', quality: 'high', n: 3 }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(503);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('multipart edits 扇出:每次都重建 FormData 且带齐输入图', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            formReq(URL_EDIT, { prompt: 'e', size: '3840x2160', quality: 'high', n: '3' }, [TINY_PNG]),
            'edits',
            'ominiapi',
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        for (const [, init] of fetchMock.mock.calls) {
            const f = init.body as FormData;
            expect(f).toBeInstanceOf(FormData);
            expect(f.getAll('image')).toHaveLength(1);
            expect(f.get('n')).toBeNull();
        }
        expect((await res.json()).usage.output_tokens).toBe(13342 * 3);
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
        expect(body.usage.output_tokens).toBe(13342);
        // 1×1 PNG → 1MP 兜底:85+1500
        expect(body.usage.input_tokens_details.image_tokens).toBe(85 + 1500);
        // 上游收到 multipart(fetch 自动 boundary;不能手写 content-type)
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.ominiapi.com/v1/images/edits');
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
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', quality: 'high' }),
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
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', quality: 'high' }),
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
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', quality: 'high' }),
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
                quality: 'high',
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
            body: JSON.stringify({ prompt: 'x', size: '3840x2160', quality: 'high' }),
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

describe('codexvip provider(第二家 Adobe Firefly 转售,与 ch154 同 prio 分流)', () => {
    it('注册表解析到正确 base_url,请求路由到该上游', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/codexvip/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'a 4k cat',
                size: '3840x2160',
                quality: 'high',
            }),
            'generations',
            'codexvip',
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.usage.output_tokens).toBe(13342); // 上游假 usage 被合成值替换
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://subdirect.aicodexvip.top/v1/images/generations');
        expect(init.headers.authorization).toBe('Bearer sk-upstream-test'); // key 透传,portal 不存
        expect(JSON.parse(init.body as string).response_format).toBe('b64_json');
    });

    it('brand 正则抹掉 aicodexvip / adobe2api 身份串', () => {
        const out = sanitizeAdapterError(
            'aicodexvip upstream error; usage_source=adobe2api; adobe firefly unsafe',
            /\b(?:aicodexvip|aicodex|codexvip|adobe2api)\b/gi,
        );
        const lc = out.toLowerCase();
        expect(lc).not.toContain('aicodex');
        expect(lc).not.toContain('codexvip');
        expect(lc).not.toContain('adobe2api');
        expect(lc).not.toContain('adobe');
    });
});
