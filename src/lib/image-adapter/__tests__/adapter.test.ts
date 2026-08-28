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

/** 造一个仅 PNG 签名 + IHDR(w×h + colortype)的最小 buffer 的 base64 —— 够 imageDimensions
 *  读尺寸(测 auto 计费)+ imageHasAlpha 读 colortype(测透明出图校验;缺省 6 = RGBA)。 */
function pngB64(w: number, h: number, colorType = 6): string {
    const buf = Buffer.alloc(26);
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47;
    buf.write('IHDR', 12, 'latin1');
    buf.writeUInt32BE(w, 16);
    buf.writeUInt32BE(h, 20);
    buf[24] = 8; // bit depth
    buf[25] = colorType;
    return buf.toString('base64');
}

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
    // 方图 / 3:2(长/短 ≤ 1.5,非狭长)不过盈利档 → 拒。狭长图(16:9)另见下方 shape-aware 测试。
    it.each([
        ['1k 缺省 quality(→low)', { size: '1024x1024' }],
        ['1k medium', { size: '1024x1024', quality: 'medium' }],
        ['2k medium', { size: '2048x2048', quality: 'medium' }],
        ['2k low', { size: '2048x2048', quality: 'low' }],
        ['大方图 low(2880² low)', { size: '2880x2880', quality: 'low' }],
        ['大方图 auto(2880²→low)', { size: '2880x2880', quality: 'auto' }],
        ['3:2 low(1536x1024,比 1.5 不算狭长)', { size: '1536x1024', quality: 'low' }],
        ['3:2 standard(→low)', { size: '1536x1024', quality: 'standard' }],
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

    // shape-aware:狭长图(16:9,长/短 > 1.5)不论盈利档一律放行 → 走适配器拿官方账单
    it.each([
        ['4K 16:9 low', { size: '3840x2160', quality: 'low' }],
        ['4K 16:9 auto(→low)', { size: '2160x3840', quality: 'auto' }],
        ['4K 16:9 medium', { size: '3840x2160', quality: 'medium' }],
        ['2560x1440 medium(重灾区 +79%)', { size: '2560x1440', quality: 'medium' }],
        ['1024x1792 low', { size: '1024x1792', quality: 'low' }],
    ])('狭长 %s → 过闸打上游(官方账单)', async (_label, extra) => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', ...extra }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('狭长阈值边界:3:2(1.5)不算狭长仍守门拒,16:10(1.6)算狭长放行', async () => {
        // 3:2 low → 拒(不打上游)
        const r32 = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '1536x1024', quality: 'low' }),
            'generations',
            'ominiapi',
        );
        expect(r32.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
        // 16:10(1600x1000=1.6)low → 放行打上游
        okUpstream();
        const r1610 = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '1600x1000', quality: 'low' }),
            'generations',
            'ominiapi',
        );
        expect(r1610.status).toBe(200);
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
    it('JSON generations:output_compression 数字/数字串 → 上游 body 里是 number(修类型 bug)', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '3840x2160',
                quality: 'high',
                output_compression: 75, // 客户传数字
                output_format: 'webp', // 非整型字段仍原样透传
            }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(200);
        const [, init] = fetchMock.mock.calls[0];
        const sent = JSON.parse(init.body as string);
        expect(sent.output_compression).toBe(75); // number,不是 "75"
        expect(typeof sent.output_compression).toBe('number');
        expect(sent.output_format).toBe('webp'); // 字符串字段照旧
    });

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

    it('内容安全(451 image_unsafe)→ 终态 400 content_policy_violation(不 failover)', async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ error: { error_code: 'image_unsafe', message: 'appear to be unsafe' } }), {
                status: 451,
            }),
        );
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', quality: 'high' }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(400); // 终态,不是 503
        const body = await res.json();
        expect(body.error.code).toBe('content_policy_violation');
        expect(fetchMock).toHaveBeenCalledTimes(1); // 只打一次,没被重复扇出
        // body 含 'content rejected' 标记(供代理 IMAGE_SAFETY_RE 命中),身份中性
        expect(JSON.stringify(body).toLowerCase()).toContain('content rejected');
        expect(JSON.stringify(body).toLowerCase()).not.toContain('omini');
    });

    it('请求本身错(prompt is required,400)→ 终态 400 invalid_request(不 failover)', async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ error: { message: 'prompt is required' } }), { status: 400 }),
        );
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: '', size: '3840x2160', quality: 'high' }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(400);
        expect((await res.json()).error.code).toBe('invalid_request');
    });

    it('渠道特定(no available channel,400)→ 仍 503 failover(换渠道有意义)', async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ error: { code: 'model_not_found', message: 'No available channel' } }), {
                status: 400,
            }),
        );
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', quality: 'high' }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(503);
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

describe('wetokengated provider(同 us-la 上游但不带 openAllTiers = ch154 式守门,给 ch175 用)', () => {
    it('路由到 us-la.we-token.cc(与 wetoken 同上游)', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/wetokengated/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '3840x2160',
                quality: 'high',
            }),
            'generations',
            'wetokengated',
        );
        expect(res.status).toBe(200);
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe('https://us-la.we-token.cc/v1/images/generations');
        expect(((await res.json()) as { usage: { output_tokens: number } }).usage.output_tokens).toBe(13342);
    });

    it('守门:方图 1024 low → 503 拒(不打上游),与 ch154 一致', async () => {
        const res = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/wetokengated/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '1024x1024',
                quality: 'low',
            }),
            'generations',
            'wetokengated',
        );
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('守门:狭长 16:9 low → 放行(与 ch154 shape-aware 一致)', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/wetokengated/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '2560x1440',
                quality: 'low',
            }),
            'generations',
            'wetokengated',
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('守门:size=auto → 503 拒(非 openAllTiers,与 ch154 一致)', async () => {
        const res = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/wetokengated/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'x',
                size: 'auto',
                quality: 'high',
            }),
            'generations',
            'wetokengated',
        );
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('wetoken provider(us-la.we-token.cc,adobe 上游挂适配器 → 合成官方 usage)', () => {
    it('路由到 us-la.we-token.cc,上游面积 usage 被丢弃、返回官方合成值', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/wetoken/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'a 4k cat',
                size: '3840x2160',
                quality: 'high',
            }),
            'generations',
            'wetoken',
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.usage.output_tokens).toBe(13342); // 官方公式,不是上游面积 19755
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe('https://us-la.we-token.cc/v1/images/generations');
    });

    it('openAllTiers:1024 low(方图)也放行打上游、合成官方 196(全量官方账单)', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/wetoken/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '1024x1024',
                quality: 'low',
            }),
            'generations',
            'wetoken',
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = await res.json();
        expect(body.usage.output_tokens).toBe(196); // 官方 low 196(不是上游面积)
    });

    it('openAllTiers:4:3(1344x1008 low,客户对账重灾区)也放行、合成官方 162', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/wetoken/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '1344x1008',
                quality: 'low',
            }),
            'generations',
            'wetoken',
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.usage.output_tokens).toBe(162); // 官方 162(azure 直连是 223)
    });

    it('openAllTiers:size=auto → 透传上游、按返回图实际尺寸(1344x1008)合成官方 162', async () => {
        // 上游把 auto 解析成 1344x1008 并返回该尺寸的 PNG;适配器解码 IHDR 得实际尺寸再计费
        fetchMock.mockImplementation(
            async () =>
                new Response(JSON.stringify({ created: 1, data: [{ b64_json: pngB64(1344, 1008) }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const res = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/wetoken/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'x',
                size: 'auto',
                quality: 'low',
            }),
            'generations',
            'wetoken',
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1); // 不再守门拒,打了上游
        const body = await res.json();
        expect(body.usage.output_tokens).toBe(162); // = officialOutputTokens(1344,1008,low)
    });

    it('openAllTiers:size=auto 但上游返回图无法解码尺寸 → failover(不瞎计费)', async () => {
        fetchMock.mockImplementation(
            async () =>
                new Response(JSON.stringify({ created: 1, data: [{ b64_json: 'bm90LXBuZw==' }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const res = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/wetoken/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'x',
                size: 'auto',
                quality: 'low',
            }),
            'generations',
            'wetoken',
        );
        expect(res.status).toBe(503);
    });

    it('非 openAllTiers(ominiapi):size=auto 仍守门拒(auto 只走 openAllTiers 上游)', async () => {
        const res = await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: 'auto', quality: 'high' }),
            'generations',
            'ominiapi',
        );
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('wetokenasia(asian-acc)路由 + openAllTiers 放行方图 low', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/wetokenasia/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '1024x1024',
                quality: 'low',
            }),
            'generations',
            'wetokenasia',
        );
        expect(res.status).toBe(200);
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe('https://asian-acc.we-token.cc/v1/images/generations');
    });

    it('ominiapifull(ominiapi 另一个账号,全量线)路由到 www. + openAllTiers 放行方图 low', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/ominiapifull/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '1024x1024',
                quality: 'low',
            }),
            'generations',
            'ominiapifull',
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.usage.output_tokens).toBe(196); // 官方 low,不是上游值
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe('https://www.ominiapi.com/v1/images/generations'); // 与 gated 的 api. 是两条独立线
    });

    it('frimodel 路由到 api.frimodel.com(platform. 是控制台,/v1/* 恒 403)+ openAllTiers 放行方图 low', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/frimodel/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '1024x1024',
                quality: 'low',
            }),
            'generations',
            'frimodel',
        );
        expect(res.status).toBe(200);
        expect((await res.json()).usage.output_tokens).toBe(196);
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.frimodel.com/v1/images/generations');
    });

    it('frimodel 生图恒返预签名 S3 url(无视 response_format)→ 拉回转 b64,URL 不外泄', async () => {
        const s3 = 'https://pre-signed-firefly-prod.s3-accelerate.amazonaws.com/images/abc?X-Amz-Signature=deadbeef';
        fetchMock
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ created: 1, data: [{ url: s3 }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(new Response(Buffer.from(pngB64(1024, 1024), 'base64'), { status: 200 }));
        const res = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/frimodel/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '1024x1024',
                quality: 'low',
            }),
            'generations',
            'frimodel',
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual([{ b64_json: pngB64(1024, 1024) }]);
        const raw = JSON.stringify(body);
        expect(raw).not.toContain('amazonaws');
        expect(raw).not.toContain('firefly');
        expect(fetchMock.mock.calls[1][0]).toBe(s3);
    });

    it('frimodel brand 正则抹掉 frimodel / firefly / S3 桶名', () => {
        const out = sanitizeAdapterError(
            'frimodel gateway error from pre-signed-firefly-prod.s3-accelerate.amazonaws.com: firefly said no',
            /\bfri-?model\b|\bfirefly\b|\bs3-accelerate\.amazonaws\.com\b/gi,
        );
        const lc = out.toLowerCase();
        expect(lc).not.toContain('frimodel');
        expect(lc).not.toContain('firefly');
        expect(lc).not.toContain('amazonaws');
    });

    it('brand 正则抹掉 we-token / adobe / firefly 身份串', () => {
        const out = sanitizeAdapterError(
            'we-token.cc upstream error; adobe firefly content unsafe',
            /\bwe-?token\b|\badobe\b|\bfirefly\b/gi,
        );
        const lc = out.toLowerCase();
        expect(lc).not.toContain('we-token');
        expect(lc).not.toContain('adobe');
        expect(lc).not.toContain('firefly');
    });
});

describe('oaidist provider(真 OpenAI 签名分销网关,gateMinCt 1,756 纯盈利档守门)', () => {
    const URL_OAIDIST = 'http://portal.test/image-adapter/oaidist/v1/images/generations';

    it('路由到 64.32.31.178:3009,key 透传,model 强制 gpt-image-2 + 显式 b64_json', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq(URL_OAIDIST, { model: 'gpt-image-2', prompt: 'x', size: '1024x1024', quality: 'medium' }),
            'generations',
            'oaidist',
        );
        expect(res.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://64.32.31.178:3009/v1/images/generations');
        expect(init.headers.authorization).toBe('Bearer sk-upstream-test');
        const sent = JSON.parse(init.body as string);
        expect(sent.model).toBe('gpt-image-2');
        expect(sent.response_format).toBe('b64_json');
    });

    // 守门线 1,756 = ¥0.06/张成本保本线(operator 2026-08-24):1024² medium 恰好放行,
    // 线下第一档 1280×1024 medium(1,510)拒;low 族天花板 659,永远在线下。
    it.each([
        ['1024² medium(=1,756 恰好过线)', { size: '1024x1024', quality: 'medium' }],
        ['2560×1440 medium(1,843)', { size: '2560x1440', quality: 'medium' }],
        ['1024² high(7,024)', { size: '1024x1024', quality: 'high' }],
        ['4K high(13,342)', { size: '3840x2160', quality: 'high' }],
    ])('放行:%s', async (_label, extra) => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq(URL_OAIDIST, { model: 'gpt-image-2', prompt: 'x', ...extra }),
            'generations',
            'oaidist',
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['1280×1024 medium(1,510,线下第一档)', { size: '1280x1024', quality: 'medium' }],
        ['1024² low(196)', { size: '1024x1024', quality: 'low' }],
        ['1024² 缺省 quality(→low)', { size: '1024x1024' }],
        ['4K low(371,旧守门也拒)', { size: '3840x2160', quality: 'low' }],
        ['size=auto(非 openAllTiers 不收)', { size: 'auto', quality: 'high' }],
    ])('拒(503 不打上游):%s', async (_label, extra) => {
        const res = await handleAdapterImage(
            jsonReq(URL_OAIDIST, { model: 'gpt-image-2', prompt: 'x', ...extra }),
            'generations',
            'oaidist',
        );
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('【无狭长放行】狭长 16:9 low(2560×1440 low = 205)→ 拒;同尺寸存量 wetokengated 仍放行', async () => {
        // gateMinCt provider:狭长低档 = 亏钱档,拒(兜底 openAllTiers 线接走,照样官方账单)
        const rNew = await handleAdapterImage(
            jsonReq(URL_OAIDIST, { model: 'gpt-image-2', prompt: 'x', size: '2560x1440', quality: 'low' }),
            'generations',
            'oaidist',
        );
        expect(rNew.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
        // 存量 gated provider 行为不动:同请求狭长条款放行
        okUpstream();
        const rOld = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/wetokengated/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '2560x1440',
                quality: 'low',
            }),
            'generations',
            'wetokengated',
        );
        expect(rOld.status).toBe(200);
    });

    it('上游静默降级尺寸 → 按【返回图实际尺寸】计费(7000² 式超收根治)', async () => {
        // 请求 2048² high(过线),上游"降级"返 1024² 的图 → 计费必须是 1024² high 7,024,
        // 不是请求值 2048² high 14,272
        fetchMock.mockImplementation(
            async () =>
                new Response(JSON.stringify({ created: 1, data: [{ b64_json: pngB64(1024, 1024) }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const res = await handleAdapterImage(
            jsonReq(URL_OAIDIST, { model: 'gpt-image-2', prompt: 'x', size: '2048x2048', quality: 'high' }),
            'generations',
            'oaidist',
        );
        expect(res.status).toBe(200);
        expect((await res.json()).usage.output_tokens).toBe(7024);
    });

    it('返回图实际尺寸 = 请求值 → 计费与旧口径逐 token 一致(如实上游零变化)', async () => {
        fetchMock.mockImplementation(
            async () =>
                new Response(JSON.stringify({ created: 1, data: [{ b64_json: pngB64(3840, 2160) }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const res = await handleAdapterImage(
            jsonReq(URL_OAIDIST, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', quality: 'high' }),
            'generations',
            'oaidist',
        );
        expect((await res.json()).usage.output_tokens).toBe(13342);
    });

    it('返回图解不出尺寸(非 PNG/JPEG)→ 退回按请求值计费(旧行为兜底,不失败)', async () => {
        okUpstream(); // b64_json = "img0-0",解码不是图
        const res = await handleAdapterImage(
            jsonReq(URL_OAIDIST, { model: 'gpt-image-2', prompt: 'x', size: '1024x1024', quality: 'medium' }),
            'generations',
            'oaidist',
        );
        expect(res.status).toBe(200);
        expect((await res.json()).usage.output_tokens).toBe(1756);
    });

    it('brand 正则抹掉 distributor 与上游 IP', () => {
        const out = sanitizeAdapterError(
            'No available channel for model x under group default (distributor); upstream 64.32.31.178 refused',
            /\bdistributor\b|64\.32\.31\.178/gi,
        );
        const lc = out.toLowerCase();
        expect(lc).not.toContain('distributor');
        expect(lc).not.toContain('64.32.31.178');
    });
});

describe('oaidistfull provider(oaidist 同上游同 key 的全量线,openAllTiers)', () => {
    const URL_FULL = 'http://portal.test/image-adapter/oaidistfull/v1/images/generations';

    it('路由到同一上游 64.32.31.178:3009 + openAllTiers 放行方图 low(合成官方 196)', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq(URL_FULL, { model: 'gpt-image-2', prompt: 'x', size: '1024x1024', quality: 'low' }),
            'generations',
            'oaidistfull',
        );
        expect(res.status).toBe(200);
        expect((await res.json()).usage.output_tokens).toBe(196);
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe('http://64.32.31.178:3009/v1/images/generations');
    });

    it('size=auto → 透传上游,按返回图实际尺寸(1344x1008 low)合成官方 162', async () => {
        fetchMock.mockImplementation(
            async () =>
                new Response(JSON.stringify({ created: 1, data: [{ b64_json: pngB64(1344, 1008) }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const res = await handleAdapterImage(
            jsonReq(URL_FULL, { model: 'gpt-image-2', prompt: 'x', size: 'auto', quality: 'low' }),
            'generations',
            'oaidistfull',
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect((await res.json()).usage.output_tokens).toBe(162);
    });

    it('同为守门线的 oaidist 对照:同请求(1024² low)在 gated 线仍 503 拒', async () => {
        const res = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/oaidist/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '1024x1024',
                quality: 'low',
            }),
            'generations',
            'oaidist',
        );
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('background:transparent 路由(未验证上游 503 让路,支持的正常透传)', () => {
    const gen = (provider: string, body: Record<string, unknown>) =>
        handleAdapterImage(
            jsonReq(`http://portal.test/image-adapter/${provider}/v1/images/generations`, {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '1024x1024',
                quality: 'low',
                ...body,
            }),
            'generations',
            provider,
        );

    it('wetoken(openAllTiers 但未验证透明)→ 503 不打上游(flag 压过 openAllTiers)', async () => {
        const res = await gen('wetoken', { background: 'transparent' });
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
        expect((await res.json()).error.code).toBe('upstream_unavailable'); // body 恒中性
    });

    it('大小写/空白不敏感:" Transparent " 同样拒', async () => {
        const res = await gen('wetokengated', { background: ' Transparent ', quality: 'high', size: '3840x2160' });
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('multipart edits 带 background=transparent → 未验证上游同样 503', async () => {
        const res = await handleAdapterImage(
            formReq(
                'http://portal.test/image-adapter/frimodel/v1/images/edits',
                { prompt: 'e', size: '1024x1024', quality: 'low', background: 'transparent' },
                [TINY_PNG],
            ),
            'edits',
            'frimodel',
        );
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('wetoken 不带 background / background=opaque → 照常放行(不误伤)', async () => {
        okUpstream();
        expect((await gen('wetoken', {})).status).toBe(200);
        okUpstream();
        expect((await gen('wetoken', { background: 'opaque' })).status).toBe(200);
    });

    it('ominiapifull(实测支持)→ 放行且 background=transparent 透传进上游 body', async () => {
        okUpstream();
        const res = await gen('ominiapifull', { background: 'transparent' });
        expect(res.status).toBe(200);
        const [, init] = fetchMock.mock.calls[0];
        expect(JSON.parse(init.body as string).background).toBe('transparent');
    });

    it('oaidist(信任支持,gated)→ 过守门档位带 transparent 正常放行透传', async () => {
        okUpstream();
        const res = await gen('oaidist', { background: 'transparent', quality: 'medium' });
        expect(res.status).toBe(200);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).background).toBe('transparent');
    });
});

describe('background:transparent 出图校验(号池型上游 50/50 随机,假棋盘格不放行)', () => {
    const URL_FULL2 = 'http://portal.test/image-adapter/ominiapifull/v1/images/generations';
    const upstreamReturning = (b64s: string[]) => {
        let i = 0;
        fetchMock.mockImplementation(
            async () =>
                new Response(JSON.stringify({ created: 1, data: [{ b64_json: b64s[i++ % b64s.length] }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
    };

    it('transparent 请求返回 colortype=2(无 alpha)→ 全丢 503(不给客户假棋盘格,不计费)', async () => {
        upstreamReturning([pngB64(1024, 1024, 2)]);
        const res = await handleAdapterImage(
            jsonReq(URL_FULL2, {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '1024x1024',
                quality: 'low',
                background: 'transparent',
            }),
            'generations',
            'ominiapifull',
        );
        expect(res.status).toBe(503);
        expect((await res.json()).error.code).toBe('upstream_unavailable');
    });

    it('n=2 一真一假 → 只返真 RGBA 那张,按 1 张计费', async () => {
        upstreamReturning([pngB64(1024, 1024, 6), pngB64(1024, 1024, 2)]);
        const res = await handleAdapterImage(
            jsonReq(URL_FULL2, {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '1024x1024',
                quality: 'low',
                background: 'transparent',
                n: 2,
            }),
            'generations',
            'ominiapifull',
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toHaveLength(1);
        expect(body.data[0].b64_json).toBe(pngB64(1024, 1024, 6));
        expect(body.usage.output_tokens).toBe(196); // 1 张,不是 2 张
    });

    it('不带 transparent 时 colortype=2 照常放行(校验只对透明请求生效)', async () => {
        upstreamReturning([pngB64(1024, 1024, 2)]);
        const res = await handleAdapterImage(
            jsonReq(URL_FULL2, { model: 'gpt-image-2', prompt: 'x', size: '1024x1024', quality: 'low' }),
            'generations',
            'ominiapifull',
        );
        expect(res.status).toBe(200);
        expect((await res.json()).data).toHaveLength(1);
    });

    it('transparent + 识别不出的格式(非 PNG/JPEG)→ 存疑放行不误杀', async () => {
        upstreamReturning([Buffer.from('RIFFxxxxWEBPVP8 fake-webp-bytes-here').toString('base64')]);
        const res = await handleAdapterImage(
            jsonReq(URL_FULL2, {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '1024x1024',
                quality: 'low',
                background: 'transparent',
            }),
            'generations',
            'ominiapifull',
        );
        expect(res.status).toBe(200);
    });
});

describe('frimodelmedium provider(frimodel 新账号,onlyQualities=[medium] + upstreamModel 覆盖)', () => {
    const URL_FM = 'http://portal.test/image-adapter/frimodelmedium/v1/images/generations';
    const gen = (body: Record<string, unknown>) =>
        handleAdapterImage(
            jsonReq(URL_FM, { model: 'gpt-image-2', prompt: 'x', size: '1024x1024', ...body }),
            'generations',
            'frimodelmedium',
        );

    it('medium 放行:路由 api.frimodel.com,上游 model 覆盖成 gpt-image-2-adobe', async () => {
        okUpstream();
        const res = await gen({ quality: 'medium' });
        expect(res.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.frimodel.com/v1/images/generations');
        expect(JSON.parse(init.body as string).model).toBe('gpt-image-2-adobe');
    });

    it('medium 不看尺寸:4K medium / 狭长 medium / size=auto medium 全放行', async () => {
        for (const size of ['3840x2160', '2560x1440']) {
            fetchMock.mockReset();
            okUpstream();
            expect((await gen({ quality: 'medium', size })).status).toBe(200);
        }
        // auto:上游返真图,按实际尺寸计费(官方 1024² medium = 1756)
        fetchMock.mockReset();
        fetchMock.mockImplementation(
            async () =>
                new Response(JSON.stringify({ created: 1, data: [{ b64_json: pngB64(1024, 1024) }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const res = await gen({ quality: 'medium', size: 'auto' });
        expect(res.status).toBe(200);
        expect((await res.json()).usage.output_tokens).toBe(1756);
    });

    it.each([
        ['low', { quality: 'low' }],
        ['high', { quality: 'high' }],
        ['auto(→low)', { quality: 'auto' }],
        ['standard(→low)', { quality: 'standard' }],
        ['缺省(→low)', {}],
    ])('非 medium 拒(503 不打上游):%s', async (_label, extra) => {
        const res = await gen(extra);
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('multipart edits medium → 放行且 form model 覆盖成 gpt-image-2-adobe', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            formReq(
                'http://portal.test/image-adapter/frimodelmedium/v1/images/edits',
                { prompt: 'e', size: '1024x1024', quality: 'medium' },
                [TINY_PNG],
            ),
            'edits',
            'frimodelmedium',
        );
        expect(res.status).toBe(200);
        expect((fetchMock.mock.calls[0][1].body as FormData).get('model')).toBe('gpt-image-2-adobe');
    });

    it('medium + background=transparent → 503(实测该上游出假图,flag 拒)', async () => {
        const res = await gen({ quality: 'medium', background: 'transparent' });
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('存量 provider 上游 model 名不受影响(仍送 gpt-image-2)', async () => {
        okUpstream();
        await handleAdapterImage(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '3840x2160', quality: 'high' }),
            'generations',
            'ominiapi',
        );
        expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model).toBe('gpt-image-2');
    });
});

describe('frimodellow provider(frimodel 第三账号,onlyQualities=[low] + gpt-image-2-low)', () => {
    const URL_FL = 'http://portal.test/image-adapter/frimodellow/v1/images/generations';
    const gen = (body: Record<string, unknown>) =>
        handleAdapterImage(
            jsonReq(URL_FL, { model: 'gpt-image-2', prompt: 'x', size: '1024x1024', ...body }),
            'generations',
            'frimodellow',
        );

    it.each([
        ['显式 low', { quality: 'low' }],
        ['auto(→low)', { quality: 'auto' }],
        ['standard(→low)', { quality: 'standard' }],
        ['缺省(→low)', {}],
    ])('low 族放行:%s → 上游 model 覆盖成 gpt-image-2-low', async (_label, extra) => {
        fetchMock.mockReset();
        okUpstream();
        const res = await gen(extra);
        expect(res.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.frimodel.com/v1/images/generations');
        expect(JSON.parse(init.body as string).model).toBe('gpt-image-2-low');
    });

    it.each([
        ['medium', { quality: 'medium' }],
        ['high', { quality: 'high' }],
    ])('非 low 拒(503 不打上游):%s', async (_label, extra) => {
        const res = await gen(extra);
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('low + size=auto → 放行,按返回图实际尺寸合成官方 low(196)', async () => {
        fetchMock.mockImplementation(
            async () =>
                new Response(JSON.stringify({ created: 1, data: [{ b64_json: pngB64(1024, 1024) }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const res = await gen({ quality: 'low', size: 'auto' });
        expect(res.status).toBe(200);
        expect((await res.json()).usage.output_tokens).toBe(196);
    });

    it('low + background=transparent → 503(frimodel 家族不出真 alpha)', async () => {
        const res = await gen({ quality: 'low', background: 'transparent' });
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('与 frimodelmedium 互斥不重叠:medium 归 204 线,low 归本线', async () => {
        okUpstream();
        const rMed = await handleAdapterImage(
            jsonReq('http://portal.test/image-adapter/frimodelmedium/v1/images/generations', {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '1024x1024',
                quality: 'low',
            }),
            'generations',
            'frimodelmedium',
        );
        expect(rMed.status).toBe(503); // medium 线拒 low
        fetchMock.mockReset();
        okUpstream();
        expect((await gen({ quality: 'low' })).status).toBe(200); // low 线收 low
    });
});

describe('pandatk provider(Adobe Firefly 转售,openAllTiers 全量线)', () => {
    const URL_PD = 'http://portal.test/image-adapter/pandatk/v1/images/generations';

    it('openAllTiers:方图 low 放行,路由 api.pandatk.com,model 仍送裸 gpt-image-2', async () => {
        okUpstream();
        const res = await handleAdapterImage(
            jsonReq(URL_PD, { model: 'gpt-image-2', prompt: 'x', size: '1024x1024', quality: 'low' }),
            'generations',
            'pandatk',
        );
        expect(res.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.pandatk.com/v1/images/generations');
        expect(JSON.parse(init.body as string).model).toBe('gpt-image-2');
        expect((await res.json()).usage.output_tokens).toBe(196); // 官方合成,不是上游 medium 托底值
    });

    it('size=auto → 放行,按返回图实际尺寸合成', async () => {
        fetchMock.mockImplementation(
            async () =>
                new Response(JSON.stringify({ created: 1, data: [{ b64_json: pngB64(2048, 2048) }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const res = await handleAdapterImage(
            jsonReq(URL_PD, { model: 'gpt-image-2', prompt: 'x', size: 'auto', quality: 'medium' }),
            'generations',
            'pandatk',
        );
        expect(res.status).toBe(200);
        expect((await res.json()).usage.output_tokens).toBe(3568);
    });

    it('background=transparent → 503 拒(Firefly 家族 fail-closed)', async () => {
        const res = await handleAdapterImage(
            jsonReq(URL_PD, {
                model: 'gpt-image-2',
                prompt: 'x',
                size: '1024x1024',
                quality: 'medium',
                background: 'transparent',
            }),
            'generations',
            'pandatk',
        );
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('brand 正则抹掉 pandatk / firefly(adobe 由 sanitize 内建兜)', () => {
        const out = sanitizeAdapterError('pandatk gateway: adobe firefly rejected', /\bpandatk\b|\bfirefly\b/gi);
        const lc = out.toLowerCase();
        expect(lc).not.toContain('pandatk');
        expect(lc).not.toContain('firefly');
        expect(lc).not.toContain('adobe');
    });
});
