/**
 * gpt-image-2.5 独立适配器单测。ground truth 全部来自 2026-09-09 用 viper3 官 key 交叉验证的
 * 真实 usage(不是自算期望值):5 档输出网格、官方输入图 patch 口径、auto→low、n 原生 honor。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
    handleAdapter25Image,
    imageDimensions,
    URL_FETCH_RETRY_DELAYS_MS,
    officialOutputTokens25,
    IMAGE25_TEXT_TOKENS_PER_INPUT_IMAGE,
    officialInputImageTokens25,
    normQuality25,
    synthUsage25,
    sanitizeAdapterError25,
    estimateTextTokens,
} from '@/lib/image-adapter25/adapter';
import { IMAGE_PROVIDERS_25, GPT_IMAGE_25_MODELS } from '@/lib/image-adapter25/providers';

const URL_GEN = 'http://portal.test/image-adapter25/wetokenasia25/v1/images/generations';
const URL_EDIT = 'http://portal.test/image-adapter25/wetokenasia25/v1/images/edits';
const UPSTREAM_GEN = 'https://asian-acc.we-token.cc/v1/images/generations';

/** 最小 PNG(签名 + IHDR w×h + colorType;IDAT 略)—— 够 imageDimensions / imageHasAlpha / sniff 读。 */
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
const TINY_PNG = Buffer.from(pngB64(1024, 1024), 'base64');

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
    return new NextRequest(url, { method: 'POST', headers: { authorization: 'Bearer sk-upstream-test' }, body: f });
}

const fetchMock = vi.fn();
beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

/** 每次造【新】Response(body 只能读一次)。 */
function okUpstream(images: string[]) {
    fetchMock.mockImplementation(
        async () =>
            new Response(JSON.stringify({ created: 1, data: images.map((b64_json) => ({ b64_json })) }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
    );
}

describe('officialOutputTokens25(5 档网格,官 key 实采 ground truth)', () => {
    it.each([
        [1024, 1024, 'low', 196],
        [1024, 1024, 'medium', 439],
        [1024, 1024, 'high', 1756],
        [1024, 1024, 'xhigh', 3122],
        [1024, 1024, 'max', 7024],
        [1536, 1024, 'high', 1372],
        [2048, 2048, 'high', 3568],
        [2880, 2880, 'high', 5930],
        [3840, 2160, 'high', 3336],
    ] as const)('%dx%d %s = %d', (w, h, q, expected) => {
        expect(officialOutputTokens25(w, h, q)).toBe(expected);
    });
    it('宽高对称', () => {
        expect(officialOutputTokens25(1536, 1024, 'xhigh')).toBe(officialOutputTokens25(1024, 1536, 'xhigh'));
    });
});

describe('officialInputImageTokens25(32px patch / 上限 1536 / 超限等比缩小取 floor)', () => {
    it.each([
        [1024, 1024, 1024],
        [1536, 1024, 1536], // 48×32 恰触顶
        [1280, 720, 920], // 40×23 未超顶
        [2048, 2048, 1521], // 64²=4096 超顶 → 39²
        [3840, 2160, 1508], // 120×68 超顶 → 52×29(round 会得 1560,坐实 floor)
    ])('%dx%d → %d', (w, h, expected) => {
        expect(officialInputImageTokens25({ w, h })).toBe(expected);
    });
    it('读不出尺寸 → 按 1024² 兜底 1024', () => {
        expect(officialInputImageTokens25(null)).toBe(1024);
    });
});

describe('normQuality25', () => {
    it.each([
        ['low', 'low'],
        ['medium', 'medium'],
        ['high', 'high'],
        ['xhigh', 'xhigh'],
        ['MAX', 'max'],
        ['auto', 'low'], // 上游对 auto 实测按 low 刻度 196 计
        ['', 'low'],
        ['standard', 'low'],
        ['ultra', 'low'],
    ])('%s → %s', (input, expected) => {
        expect(normQuality25(input)).toBe(expected);
    });
});

describe('synthUsage25', () => {
    it('输出 = 官方公式 × 张数;edits 输入图按官方 2.5 口径(不再 85+MP×1500)', () => {
        const u = synthUsage25({
            mode: 'edits',
            w: 1024,
            h: 1024,
            quality: 'xhigh',
            prompt: 'add a tiny star',
            inputImageDims: [{ w: 2048, h: 2048 }, null],
            imageCount: 2,
        });
        expect(u.output_tokens).toBe(3122 * 2);
        const det = u.input_tokens_details as { text_tokens: number; image_tokens: number };
        expect(det.image_tokens).toBe((1521 + 1024) * 2); // 官方 n 张语义:input ×张数
        // 2.5 edits 每张输入图 +10 文字 token(官方实测),两张 → +20;再 ×张数
        expect(u.input_tokens).toBe((estimateTextTokens('add a tiny star') + 20 + 1521 + 1024) * 2);
        expect(Object.keys(u).sort()).toEqual([
            'input_tokens',
            'input_tokens_details',
            'output_tokens',
            'output_tokens_details',
            'total_tokens',
        ]);
    });
});

describe('handleAdapter25Image 透传契约', () => {
    it('按客户请求的 model 透传(sunburst 不被写死成 flare),quality 原样,不发 response_format', async () => {
        okUpstream([pngB64(1024, 1024)]);
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-sunburst', prompt: 'x', size: '1024x1024', quality: 'xhigh' }),
            'generations',
            'wetokenasia25',
        );
        expect(res.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(UPSTREAM_GEN);
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-upstream-test');
        const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(sent.model).toBe('gpt-image-2.5-sunburst');
        expect(sent.quality).toBe('xhigh');
        expect(sent).not.toHaveProperty('response_format'); // 官方拒收
        const body = (await res.json()) as Record<string, unknown>;
        expect((body.usage as { output_tokens: number }).output_tokens).toBe(3122);
        expect(body.quality).toBe('xhigh'); // echo 5 档
        expect(body.size).toBe('1024x1024');
        expect(body.output_format).toBe('png');
        expect(body.background).toBe('opaque');
    });

    it('quality=auto 透传 auto 给上游、按 low 计费 196、回显 low', async () => {
        okUpstream([pngB64(1024, 1024)]);
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'auto' }),
            'generations',
            'wetokenasia25',
        );
        const sent = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<
            string,
            unknown
        >;
        expect(sent.quality).toBe('auto');
        const body = (await res.json()) as { usage: { output_tokens: number }; quality: string };
        expect(body.usage.output_tokens).toBe(196);
        expect(body.quality).toBe('low');
    });

    it('model 不在 provider 白名单 → 503 让路,不打上游', async () => {
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2', prompt: 'x', size: '1024x1024' }),
            'generations',
            'wetokenasia25',
        );
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('upstream_unavailable');
    });

    it('n=3 原生透传给上游一次(不扇出),按实际返回张数计费', async () => {
        okUpstream([pngB64(1024, 1024), pngB64(1024, 1024), pngB64(1024, 1024)]);
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'low', n: 3 }),
            'generations',
            'wetokenasia25',
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const sent = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<
            string,
            unknown
        >;
        expect(sent.n).toBe(3);
        const body = (await res.json()) as { data: unknown[]; usage: { output_tokens: number } };
        expect(body.data).toHaveLength(3);
        expect(body.usage.output_tokens).toBe(586); // 官方 n 张 = ceil(3×195.1),不是 196×3=588
    });

    it('上游少返且补齐也拿不到(n=3 只回 2,补齐轮空手)→ 按 2 张计费不失败', async () => {
        let call = 0;
        fetchMock.mockImplementation(async () =>
            call++ === 0
                ? new Response(
                      JSON.stringify({ data: [{ b64_json: pngB64(1024, 1024) }, { b64_json: pngB64(1024, 1024) }] }),
                      { status: 200, headers: { 'content-type': 'application/json' } },
                  )
                : new Response('{"error":{}}', { status: 503 }),
        );
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'low', n: 3 }),
            'generations',
            'wetokenasia25',
        );
        expect(((await res.json()) as { usage: { output_tokens: number } }).usage.output_tokens).toBe(391); // ceil(2×195.1)
    });

    it('multipart edits:model/quality/输入图透传,输入图 token 按官方 2.5 口径', async () => {
        okUpstream([pngB64(1024, 1024)]);
        const res = await handleAdapter25Image(
            formReq(URL_EDIT, { model: 'gpt-image-2.5-flare', prompt: 'edit', size: '1024x1024', quality: 'high' }, [
                TINY_PNG,
            ]),
            'edits',
            'wetokenasia25',
        );
        expect(res.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://asian-acc.we-token.cc/v1/images/edits');
        const f = init.body as FormData;
        expect(f.get('model')).toBe('gpt-image-2.5-flare');
        expect(f.get('quality')).toBe('high');
        expect(f.get('response_format')).toBeNull();
        expect(f.getAll('image')).toHaveLength(1);
        const body = (await res.json()) as {
            usage: { output_tokens: number; input_tokens_details: { image_tokens: number } };
        };
        expect(body.usage.output_tokens).toBe(1756);
        expect(body.usage.input_tokens_details.image_tokens).toBe(1024); // 1024² 输入 → 官方 1024
    });

    it('计费按【返回图实际尺寸】:请求 2880² 上游返 2048² → 按 2048² 计(不超收)', async () => {
        okUpstream([pngB64(2048, 2048)]);
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '2880x2880', quality: 'high' }),
            'generations',
            'wetokenasia25',
        );
        const body = (await res.json()) as { usage: { output_tokens: number }; size: string };
        expect(body.usage.output_tokens).toBe(3568);
        expect(body.size).toBe('2048x2048');
    });

    it('上游返 url → 拉回转 b64,绝不外泄上游 url', async () => {
        fetchMock
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ created: 1, data: [{ url: 'https://oss-upstream.example.com/x.png' }] }),
                    {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    },
                ),
            )
            .mockResolvedValueOnce(
                new Response(new Uint8Array(Buffer.from(pngB64(1024, 1024), 'base64')), { status: 200 }),
            );
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'low' }),
            'generations',
            'wetokenasia25',
        );
        expect(res.status).toBe(200);
        const raw = JSON.stringify(await res.json());
        expect(raw).not.toContain('oss-upstream');
        expect(raw).toContain(pngB64(1024, 1024));
    });
});

/**
 * n 补齐(2026-09-23):上游【原生 n】在号池型上游身上不可靠 —— zdchat 实测 n>1 请求约 1/3 少给
 * (要 2 回 1、要 4 回 2),客户投诉"n 参数不读了"。以前只 warn 不补。
 */
describe('handleAdapter25Image n 补齐(上游少给后补打)', () => {
    /** 按调用顺序依次返回每批图(空数组 = 该次 503);超出批次数后恒 503。 */
    function seqUpstream(batches: number[]) {
        let call = 0;
        fetchMock.mockImplementation(async () => {
            const count = batches[call++] ?? 0;
            if (count === 0) return new Response('{"error":{}}', { status: 503 });
            return new Response(
                JSON.stringify({
                    created: 1,
                    data: Array.from({ length: count }, () => ({ b64_json: pngB64(1024, 1024) })),
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        });
    }
    const gen = (n: number) =>
        handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'low', n }),
            'generations',
            'wetokenasia25',
        );
    const bodyOf = (res: Response) => res.json() as Promise<{ data: unknown[]; usage: { output_tokens: number } }>;

    it('要 2 回 1 → 补打 1 张凑满,按 2 张计费(客户实案 c-70fd7c5f 19:06)', async () => {
        seqUpstream([1, 1]);
        const res = await gen(2);
        expect(res.status).toBe(200);
        const body = await bodyOf(res);
        expect(body.data).toHaveLength(2);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(body.usage.output_tokens).toBe(391); // ceil(2×195.1),不是 196
    });

    it('补齐请求只要【缺的那几张】(n=missing),不是整个 n 重打', async () => {
        seqUpstream([2, 2]);
        await gen(4);
        const second = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as {
            n?: number;
        };
        expect(second.n).toBe(2);
    });

    it('两轮补齐封顶:要 4 每次只回 1 → 3 张后停,按 3 张计费', async () => {
        seqUpstream([1, 1, 1, 1]);
        const res = await gen(4);
        const body = await bodyOf(res);
        expect(fetchMock).toHaveBeenCalledTimes(3); // 首轮 + 2 轮补齐
        expect(body.data).toHaveLength(3);
        expect(body.usage.output_tokens).toBe(586); // ceil(3×195.1)
    });

    it('补齐轮空手 → 立即停,不打满轮数', async () => {
        seqUpstream([1]); // 第 2 次起恒 503
        const res = await gen(4);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect((await bodyOf(res)).data).toHaveLength(1);
    });

    it('一张没拿到 → 503 failover,【不】原地补打(换渠道更可能成)', async () => {
        seqUpstream([]);
        const res = await gen(3);
        expect(res.status).toBe(503);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('补齐轮命中终态(内容安全)→ 不推翻已拿到的图,200 交付已有', async () => {
        let call = 0;
        fetchMock.mockImplementation(async () =>
            call++ === 0
                ? new Response(JSON.stringify({ data: [{ b64_json: pngB64(1024, 1024) }] }), {
                      status: 200,
                      headers: { 'content-type': 'application/json' },
                  })
                : new Response('{"error":{"code":"image_unsafe"}}', { status: 451 }),
        );
        const res = await gen(2);
        expect(res.status).toBe(200);
        expect((await bodyOf(res)).data).toHaveLength(1);
    });

    it('首轮就命中终态 → 仍然 400(补齐不改变既有语义)', async () => {
        fetchMock.mockImplementation(async () => new Response('{"error":{"code":"image_unsafe"}}', { status: 451 }));
        const res = await gen(2);
        expect(res.status).toBe(400);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('补齐轮上游多给 → 只交付 n 张(不超发也不超收)', async () => {
        seqUpstream([1, 3]); // 缺 1 张却回了 3 张
        const res = await gen(2);
        const body = await bodyOf(res);
        expect(body.data).toHaveLength(2);
        expect(body.usage.output_tokens).toBe(391);
    });
});

describe('handleAdapter25Image 透明 / 错误 / 脱敏', () => {
    it('transparent:上游返无 alpha(colortype 2)→ 503 让路;返 RGBA → 200 回显 transparent', async () => {
        okUpstream([pngB64(1024, 1024, 2)]);
        const r1 = await handleAdapter25Image(
            jsonReq(URL_GEN, {
                model: 'gpt-image-2.5-flare',
                prompt: 'x',
                size: '1024x1024',
                quality: 'low',
                background: 'transparent',
            }),
            'generations',
            'wetokenasia25',
        );
        expect(r1.status).toBe(503);
        okUpstream([pngB64(1024, 1024, 6)]);
        const r2 = await handleAdapter25Image(
            jsonReq(URL_GEN, {
                model: 'gpt-image-2.5-flare',
                prompt: 'x',
                size: '1024x1024',
                quality: 'low',
                background: 'transparent',
            }),
            'generations',
            'wetokenasia25',
        );
        expect(r2.status).toBe(200);
        expect(((await r2.json()) as { background: string }).background).toBe('transparent');
    });

    it('内容安全 → 终态 400 官方 moderation_blocked / user_error,不 failover', async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ error: { error_code: 'image_unsafe', message: 'appear to be unsafe' } }), {
                status: 451,
            }),
        );
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'low' }),
            'generations',
            'wetokenasia25',
        );
        expect(res.status).toBe(400);
        const e = ((await res.json()) as { error: { code: string; type: string } }).error;
        expect(e.code).toBe('moderation_blocked');
        expect(e.type).toBe('user_error');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('内容安全(zdchat 451 type content_filter / yuanshudian image_safety 措辞)→ 均终态 400,不 failover', async () => {
        // 2026-09-30 线上实况:这些措辞旧正则漏掉 → 503 failover + 客户无限重试
        for (const errBody of [
            {
                error: {
                    message: 'The generated images appear to be unsafe. Try modifying the prompts or the seeds.',
                    type: 'content_filter',
                    code: 'ERR-FFD974C5BD',
                },
            },
            {
                error: {
                    message:
                        'The generated image was filtered by the safety policy. Please adjust your prompt and try again.',
                    type: 'invalid_request_error',
                    code: 'image_safety',
                },
            },
            { error: { message: 'brand-new wording' } }, // 纯靠 HTTP 451 判定
        ]) {
            fetchMock.mockReset();
            fetchMock.mockResolvedValue(new Response(JSON.stringify(errBody), { status: 451 }));
            const res = await handleAdapter25Image(
                jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'low' }),
                'generations',
                'wetokenasia25',
            );
            expect(res.status).toBe(400);
            expect(((await res.json()) as { error: { code: string } }).error.code).toBe('moderation_blocked');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        }
    });

    it('上游非法尺寸 400 → 终态 invalid_request,且【透出上游具体原因】+ param=size(客户能定位)', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    error: { message: 'invalid image size: edges must be multiples of 16 (got "1000x1000")' },
                }),
                { status: 400 },
            ),
        );
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1000x1000', quality: 'low' }),
            'generations',
            'wetokenasia25',
        );
        expect(res.status).toBe(400);
        const e = ((await res.json()) as { error: { code: string; message: string; param: string | null } }).error;
        expect(e.code).toBe('invalid_request');
        expect(e.message).toContain('edges must be multiples of 16'); // 具体原因透出,不再笼统
        expect(e.message).toContain('1000x1000');
        expect(e.param).toBe('size');
    });

    it('bad_request 上游原因带品牌 → 透出前脱敏', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({ error: { message: 'we-token: invalid image size, edges must be multiples of 16' } }),
                {
                    status: 400,
                },
            ),
        );
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '15x15', quality: 'low' }),
            'generations',
            'wetokenasia25',
        );
        expect(res.status).toBe(400);
        const msg = ((await res.json()) as { error: { message: string } }).error.message.toLowerCase();
        expect(msg).not.toContain('we-token');
        expect(msg).toContain('edges must be multiples of 16'); // 具体原因保留
    });

    it('非法 quality(ultra)入口拦截 → 400 invalid_request param=quality,不打上游(不再静默按 low 出图)', async () => {
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'ultra' }),
            'generations',
            'wetokenasia25',
        );
        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled(); // 入口拦,没打上游
        const e = ((await res.json()) as { error: { code: string; param: string; message: string } }).error;
        expect(e.code).toBe('invalid_request');
        expect(e.param).toBe('quality');
        expect(e.message.toLowerCase()).toContain('quality');
    });

    it('合法 quality(含 auto)与空 quality 不被入口拦(auto/空 → 走 low)', async () => {
        for (const q of ['low', 'medium', 'high', 'xhigh', 'max', 'auto', '']) {
            fetchMock.mockReset();
            okUpstream([pngB64(1024, 1024)]);
            const res = await handleAdapter25Image(
                jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: q }),
                'generations',
                'wetokenasia25',
            );
            expect(res.status).toBe(200);
            expect(fetchMock).toHaveBeenCalledTimes(1); // 放行打上游
        }
    });

    it('渠道特定(no available channel / 5xx)→ 503 failover,体中性不泄品牌', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({ error: { message: 'we-token: No available channel for model gpt-image-2.5-flare' } }),
                {
                    status: 503,
                },
            ),
        );
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'low' }),
            'generations',
            'wetokenasia25',
        );
        expect(res.status).toBe(503);
        const text = JSON.stringify(await res.json()).toLowerCase();
        for (const leak of ['we-token', 'adobe', 'channel', 'provider', 'wetoken']) expect(text).not.toContain(leak);
    });

    it('上游 200 无图 → 503(绝不给空图合成 usage)', async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ created: 1, data: [] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'low' }),
            'generations',
            'wetokenasia25',
        );
        expect(res.status).toBe(503);
    });

    it('缺 Authorization → 401;未知 provider → 503', async () => {
        const noAuth = new NextRequest(URL_GEN, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-image-2.5-flare', prompt: 'x' }),
        });
        expect((await handleAdapter25Image(noAuth, 'generations', 'wetokenasia25')).status).toBe(401);
        expect(
            (
                await handleAdapter25Image(
                    jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x' }),
                    'generations',
                    'nope',
                )
            ).status,
        ).toBe(503);
    });

    it('sanitizeAdapterError25 抹 we-token / adobe / firefly', () => {
        const out = sanitizeAdapterError25(
            'we-token.cc: adobe firefly unsafe',
            /\bwe-?token\b|\badobe\b|\bfirefly\b/gi,
        ).toLowerCase();
        expect(out).not.toContain('we-token');
        expect(out).not.toContain('adobe');
        expect(out).not.toContain('firefly');
    });
});

// ---------------- per-provider 上游超时(2026-09-11,we-token 挂死不回头) ----------------
describe('per-provider upstreamTimeoutMs', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        delete IMAGE_PROVIDERS_25.__defaulttimeout;
    });

    function hangingUpstream(): AbortSignal[] {
        const signals: AbortSignal[] = [];
        fetchMock.mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    const s = init.signal as AbortSignal;
                    signals.push(s);
                    s.addEventListener('abort', () =>
                        reject(new DOMException('This operation was aborted', 'AbortError')),
                    );
                }),
        );
        return signals;
    }

    it('wetokenasia25:300s 到点 abort → 503 failover(不再等满 600s)', async () => {
        const signals = hangingUpstream();
        const p = handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'high' }),
            'generations',
            'wetokenasia25',
        );
        await vi.advanceTimersByTimeAsync(299_000);
        expect(signals).toHaveLength(1);
        expect(signals[0].aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(signals[0].aborted).toBe(true);
        const res = await p;
        expect(res.status).toBe(503);
    });

    it('未设 upstreamTimeoutMs 的 provider 仍是 600s 缺省', async () => {
        IMAGE_PROVIDERS_25.__defaulttimeout = {
            baseUrl: 'https://default.test',
            brand: /\bdefault\b/gi,
            models: GPT_IMAGE_25_MODELS,
        };
        const signals = hangingUpstream();
        const p = handleAdapter25Image(
            jsonReq('http://portal.test/image-adapter25/__defaulttimeout/v1/images/generations', {
                model: 'gpt-image-2.5-flare',
                prompt: 'x',
                size: '1024x1024',
                quality: 'high',
            }),
            'generations',
            '__defaulttimeout',
        );
        await vi.advanceTimersByTimeAsync(301_000);
        expect(signals).toHaveLength(1);
        expect(signals[0].aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(signals[0].aborted).toBe(true);
        expect((await p).status).toBe(503);
    });
});

describe('per-provider qualities 白名单(llmway25:上游 xhigh/max 静默降 medium → 让路不打上游)', () => {
    const URL_LLMWAY = 'http://portal.test/image-adapter25/llmway25/v1/images/generations';

    it('registry:llmway25 = llmway.ai、两模型、只放 low/medium/high;wetokenasia25 不设名单(5 档全收)', () => {
        expect(IMAGE_PROVIDERS_25.llmway25.baseUrl).toBe('https://llmway.ai');
        expect(IMAGE_PROVIDERS_25.llmway25.models).toEqual(GPT_IMAGE_25_MODELS);
        expect(IMAGE_PROVIDERS_25.llmway25.qualities).toEqual(['low', 'medium', 'high']);
        expect(IMAGE_PROVIDERS_25.wetokenasia25.qualities).toBeUndefined();
        expect('llmway sucks'.replace(IMAGE_PROVIDERS_25.llmway25.brand, '***')).toBe('*** sucks');
    });

    it('xhigh / max → 503 中性体让路,fetch 一次都不打(不能收 max 的钱交 medium 的图)', async () => {
        for (const q of ['xhigh', 'max', 'XHIGH']) {
            fetchMock.mockReset();
            okUpstream([pngB64(1024, 1024)]);
            const res = await handleAdapter25Image(
                jsonReq(URL_LLMWAY, { model: 'gpt-image-2.5-sunburst', prompt: 'x', size: '1024x1024', quality: q }),
                'generations',
                'llmway25',
            );
            expect(res.status).toBe(503);
            expect(fetchMock).not.toHaveBeenCalled();
            const body = (await res.json()) as { error: { code: string; message: string } };
            expect(body.error.code).toBe('upstream_unavailable');
            expect(body.error.message).not.toMatch(/llmway|quality/i);
        }
    });

    it('low / medium / high / auto / 空 → 正常透传上游并按归一档计费(auto → low 196)', async () => {
        for (const [q, expectTokens] of [
            ['low', 196],
            ['medium', 439],
            ['high', 1756],
            ['auto', 196],
            ['', 196],
        ] as const) {
            fetchMock.mockReset();
            okUpstream([pngB64(1024, 1024)]);
            const res = await handleAdapter25Image(
                jsonReq(URL_LLMWAY, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: q }),
                'generations',
                'llmway25',
            );
            expect(res.status).toBe(200);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(String(fetchMock.mock.calls[0][0])).toBe('https://llmway.ai/v1/images/generations');
            const body = (await res.json()) as { usage: { output_tokens: number } };
            expect(body.usage.output_tokens).toBe(expectTokens);
        }
    });

    it('非法 quality 仍先吃入口 400(名单判定在其后,不会把 ultra 变成 503 让路)', async () => {
        const res = await handleAdapter25Image(
            jsonReq(URL_LLMWAY, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'ultra' }),
            'generations',
            'llmway25',
        );
        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('未设名单的 wetokenasia25 收 max 照常打上游(行为零变化)', async () => {
        okUpstream([pngB64(1024, 1024)]);
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'max' }),
            'generations',
            'wetokenasia25',
        );
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('ominiapi25 全量线(5 档全收 + 裸壳响应自合成 + Adobe 剥/OpenAI 留)', () => {
    const URL_OMINI = 'http://portal.test/image-adapter25/ominiapi25/v1/images/generations';

    /** 带 caBX(C2PA)块的最小 PNG:IHDR + caBX(payload 自定)+ IEND。 */
    function pngWithCaBX(w: number, h: number, payload: string): Buffer {
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(w, 0);
        ihdr.writeUInt32BE(h, 4);
        ihdr[8] = 8;
        ihdr[9] = 2;
        const chunk = (type: string, data: Buffer) => {
            const len = Buffer.alloc(4);
            len.writeUInt32BE(data.length, 0);
            return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
        };
        return Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            chunk('IHDR', ihdr),
            chunk('caBX', Buffer.from(payload, 'latin1')),
            chunk('IEND', Buffer.alloc(0)),
        ]);
    }
    const upstreamRaw = (buf: Buffer, envelope: Record<string, unknown> = {}) =>
        fetchMock.mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({ created: 1, data: [{ b64_json: buf.toString('base64') }], ...envelope }),
                    {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    },
                ),
        );

    it('registry:ominiapi25 = www.ominiapi.com、两模型、无 qualities(全量);brand 抹 ominiapi/adobe', () => {
        expect(IMAGE_PROVIDERS_25.ominiapi25.baseUrl).toBe('https://www.ominiapi.com');
        expect(IMAGE_PROVIDERS_25.ominiapi25.models).toEqual(GPT_IMAGE_25_MODELS);
        expect(IMAGE_PROVIDERS_25.ominiapi25.qualities).toBeUndefined();
        expect('via ominiapi / omini api / Adobe'.replace(IMAGE_PROVIDERS_25.ominiapi25.brand, '*')).toBe(
            'via * / * / *',
        );
    });

    it('5 档 + auto + 空 全部透传上游,按官方档计费(196/439/1756/3122/7024)', async () => {
        for (const [q, expectTokens] of [
            ['low', 196],
            ['medium', 439],
            ['high', 1756],
            ['xhigh', 3122],
            ['max', 7024],
            ['auto', 196],
            ['', 196],
        ] as const) {
            fetchMock.mockReset();
            okUpstream([pngB64(1024, 1024)]);
            const res = await handleAdapter25Image(
                jsonReq(URL_OMINI, { model: 'gpt-image-2.5-sunburst', prompt: 'x', size: '1024x1024', quality: q }),
                'generations',
                'ominiapi25',
            );
            expect(res.status).toBe(200);
            expect(String(fetchMock.mock.calls[0][0])).toBe('https://www.ominiapi.com/v1/images/generations');
            expect(((await res.json()) as { usage: { output_tokens: number } }).usage.output_tokens).toBe(expectTokens);
        }
    });

    it('裸壳响应(上游只有 created+data,无 usage/quality/size)→ 响应壳全部自合成,与带壳响应一致', async () => {
        // 裸壳
        upstreamRaw(pngWithCaBX(1024, 1024, 'OpenAI Media Service API'));
        const bare = (await (
            await handleAdapter25Image(
                jsonReq(URL_OMINI, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'high' }),
                'generations',
                'ominiapi25',
            )
        ).json()) as Record<string, unknown>;
        // 带壳但 usage/quality 是上游自造的假值(必须被丢弃)
        upstreamRaw(pngWithCaBX(1024, 1024, 'OpenAI Media Service API'), {
            usage: { output_tokens: 1 },
            quality: 'medium',
            size: '512x512',
            output_format: 'webp',
            background: 'transparent',
        });
        const shelled = (await (
            await handleAdapter25Image(
                jsonReq(URL_OMINI, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'high' }),
                'generations',
                'ominiapi25',
            )
        ).json()) as Record<string, unknown>;
        for (const r of [bare, shelled]) {
            expect(Object.keys(r).sort()).toEqual([
                'background',
                'created',
                'data',
                'output_format',
                'quality',
                'size',
                'usage',
            ]);
            expect(typeof r.created).toBe('number');
            expect(r.quality).toBe('high');
            expect(r.size).toBe('1024x1024');
            expect(r.background).toBe('opaque');
            expect(r.output_format).toBe('png');
            expect((r.usage as { output_tokens: number }).output_tokens).toBe(1756);
        }
    });

    it('C2PA:Adobe 标识的 caBX 被剥(像素块保留)、OpenAI 签名的字节原样不动', async () => {
        const adobe = pngWithCaBX(
            1024,
            1024,
            'jumdc2pa claim_generator Adobe_Firefly com.adobe.modelVersions gpt-image-2.5-flare',
        );
        upstreamRaw(adobe);
        const r1 = (await (
            await handleAdapter25Image(
                jsonReq(URL_OMINI, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'xhigh' }),
                'generations',
                'ominiapi25',
            )
        ).json()) as { data: Array<{ b64_json: string }> };
        const out1 = Buffer.from(r1.data[0].b64_json, 'base64');
        expect(out1.includes(Buffer.from('Adobe'))).toBe(false);
        expect(out1.includes(Buffer.from('caBX'))).toBe(false);
        expect(out1.includes(Buffer.from('IHDR'))).toBe(true);
        expect(out1.length).toBeLessThan(adobe.length);

        const openai = pngWithCaBX(
            1024,
            1024,
            'jumdc2pa claim_generator_info OpenAI Media Service API OpenAI OpCo, LLC',
        );
        upstreamRaw(openai);
        const r2 = (await (
            await handleAdapter25Image(
                jsonReq(URL_OMINI, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'xhigh' }),
                'generations',
                'ominiapi25',
            )
        ).json()) as { data: Array<{ b64_json: string }> };
        expect(Buffer.from(r2.data[0].b64_json, 'base64').equals(openai)).toBe(true);
    });

    it('上游号池打空(503 No available compatible accounts)→ 503 failover,体中性不泄 ominiapi', async () => {
        fetchMock.mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({ error: { message: 'No available compatible accounts', type: 'api_error' } }),
                    {
                        status: 503,
                    },
                ),
        );
        const res = await handleAdapter25Image(
            jsonReq(URL_OMINI, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'max' }),
            'generations',
            'ominiapi25',
        );
        expect(res.status).toBe(503);
        expect(await res.text()).not.toMatch(/omini/i);
    });
});

describe('zdchat25 全量线 + url→b64 拉取重试', () => {
    const URL_ZD = 'http://portal.test/image-adapter25/zdchat25/v1/images/generations';
    const urlEnvelope = () =>
        new Response(JSON.stringify({ created: 1, data: [{ url: 'https://r2.52image.xyz/cache/x.png' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    const pngResp = () => new Response(new Uint8Array(Buffer.from(pngB64(1024, 1024), 'base64')), { status: 200 });

    it('registry:zdchat25 = api.zdapi.cc(2026-09-23 搬站)、两模型、无 qualities(全量);brand 抹 zdchat/zdapi/52image/adobe', () => {
        expect(IMAGE_PROVIDERS_25.zdchat25.baseUrl).toBe('https://api.zdapi.cc');
        expect(IMAGE_PROVIDERS_25.zdchat25.models).toEqual(GPT_IMAGE_25_MODELS);
        expect(IMAGE_PROVIDERS_25.zdchat25.qualities).toBeUndefined();
        expect('zdchat r2.52image.xyz Adobe'.replace(IMAGE_PROVIDERS_25.zdchat25.brand, '*')).toBe('* r2.*.xyz *');
        // 新域名也要被抹掉,别让 api.zdapi.cc 从错误体里漏给客户。
        expect('api.zdapi.cc down'.replace(IMAGE_PROVIDERS_25.zdchat25.brand, '*')).toBe('api.*.cc down');
    });

    it('5 档 + auto 全部透传上游,按官方档计费', async () => {
        for (const [q, expectTokens] of [
            ['low', 196],
            ['medium', 439],
            ['high', 1756],
            ['xhigh', 3122],
            ['max', 7024],
            ['auto', 196],
        ] as const) {
            fetchMock.mockReset();
            okUpstream([pngB64(1024, 1024)]);
            const res = await handleAdapter25Image(
                jsonReq(URL_ZD, { model: 'gpt-image-2.5-sunburst', prompt: 'x', size: '1024x1024', quality: q }),
                'generations',
                'zdchat25',
            );
            expect(res.status).toBe(200);
            expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.zdapi.cc/v1/images/generations');
            expect(((await res.json()) as { usage: { output_tokens: number } }).usage.output_tokens).toBe(expectTokens);
        }
    });

    it('url 首拉 0 字节 → 等 1s 重拉成功 → 200(zdchat 图床刚返回时对象未落盘)', async () => {
        vi.useFakeTimers();
        try {
            fetchMock
                .mockResolvedValueOnce(urlEnvelope())
                .mockResolvedValueOnce(new Response(new Uint8Array(0), { status: 200 })) // 0 字节
                .mockResolvedValueOnce(pngResp());
            const p = handleAdapter25Image(
                jsonReq(URL_ZD, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'low' }),
                'generations',
                'zdchat25',
            );
            await vi.advanceTimersByTimeAsync(URL_FETCH_RETRY_DELAYS_MS[0] + 10);
            const res = await p;
            expect(res.status).toBe(200);
            expect(fetchMock).toHaveBeenCalledTimes(3); // 1 上游 + 2 次拉图
            const raw = JSON.stringify(await res.json());
            expect(raw).not.toContain('52image');
            expect(raw).toContain(pngB64(1024, 1024));
        } finally {
            vi.useRealTimers();
        }
    });

    it('url 连续 404/空 共 3 次仍失败 → 503 failover(不再多试)', async () => {
        vi.useFakeTimers();
        try {
            fetchMock
                .mockResolvedValueOnce(urlEnvelope())
                .mockResolvedValueOnce(new Response('nf', { status: 404 }))
                .mockResolvedValueOnce(new Response(new Uint8Array(0), { status: 200 }))
                .mockRejectedValueOnce(new Error('ECONNRESET'));
            const p = handleAdapter25Image(
                jsonReq(URL_ZD, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'low' }),
                'generations',
                'zdchat25',
            );
            await vi.advanceTimersByTimeAsync(URL_FETCH_RETRY_DELAYS_MS[0] + URL_FETCH_RETRY_DELAYS_MS[1] + 10);
            const res = await p;
            expect(res.status).toBe(503);
            expect(fetchMock).toHaveBeenCalledTimes(4); // 1 上游 + 3 次拉图
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('yuanshudian25 全量线(真 OpenAI API 签名,按张 $0.09;与 2.0 的 yuanshudian Firefly 线无关)', () => {
    const URL_YSD = 'http://portal.test/image-adapter25/yuanshudian25/v1/images/generations';

    it('registry:api.yuanshudian.com、两模型、无 qualities(全量);brand 抹 yuanshudian / 图床域 / Provider API error 前缀', () => {
        const p = IMAGE_PROVIDERS_25.yuanshudian25;
        expect(p.baseUrl).toBe('https://api.yuanshudian.com');
        expect(p.models).toEqual(GPT_IMAGE_25_MODELS);
        expect(p.qualities).toBeUndefined();
        expect(p.upstreamTimeoutMs).toBeUndefined();
        expect('yuanshudian cdn.jd23kjs.work Adobe'.replace(p.brand, '*')).toBe('* cdn.*.work *');
        expect('Provider API error: Invalid value'.replace(p.brand, '')).toBe('Invalid value');
    });

    it('5 档 + auto 全部透传上游(两模型),按官方档计费 —— 上游自造的浮动 usage 被丢弃', async () => {
        for (const [q, expectTokens] of [
            ['low', 196],
            ['medium', 439],
            ['high', 1756],
            ['xhigh', 3122],
            ['max', 7024],
            ['auto', 196],
        ] as const) {
            for (const model of GPT_IMAGE_25_MODELS) {
                fetchMock.mockReset();
                // 上游壳:只有 created/data/usage,usage 是它自己的浮动值(实测 low 263–289 / max ~8400)
                fetchMock.mockImplementation(
                    async () =>
                        new Response(
                            JSON.stringify({
                                created: 1,
                                data: [{ b64_json: pngB64(1024, 1024) }],
                                usage: {
                                    input_tokens: 17,
                                    output_tokens: 8536,
                                    output_tokens_details: { reasoning_tokens: 0 },
                                },
                            }),
                            { status: 200, headers: { 'content-type': 'application/json' } },
                        ),
                );
                const res = await handleAdapter25Image(
                    jsonReq(URL_YSD, { model, prompt: 'x', size: '1024x1024', quality: q }),
                    'generations',
                    'yuanshudian25',
                );
                expect(res.status).toBe(200);
                expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.yuanshudian.com/v1/images/generations');
                expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).model).toBe(model);
                const body = (await res.json()) as { usage: { output_tokens: number }; quality: string; size: string };
                expect(body.usage.output_tokens).toBe(expectTokens);
                expect(body.size).toBe('1024x1024');
            }
        }
    });

    it('上游 400 `Provider API error: …` → 终态 400,透出具体原因但抹掉 Provider API error 前缀与品牌', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    error: {
                        message:
                            'Provider API error: invalid image size: edges must be multiples of 16 (yuanshudian request id: 2026)',
                    },
                }),
                { status: 400 },
            ),
        );
        const res = await handleAdapter25Image(
            jsonReq(URL_YSD, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'low' }),
            'generations',
            'yuanshudian25',
        );
        expect(res.status).toBe(400);
        const msg = ((await res.json()) as { error: { message: string } }).error.message;
        expect(msg.toLowerCase()).not.toContain('yuanshudian');
        expect(msg.toLowerCase()).not.toContain('provider api error');
        expect(msg).toContain('edges must be multiples of 16');
    });

    it('上游 502 池抖(candidate upstream unavailable)→ 503 failover,体中性不泄品牌', async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ error: { message: 'candidate upstream unavailable (yuanshudian)' } }), {
                status: 502,
            }),
        );
        const res = await handleAdapter25Image(
            jsonReq(URL_YSD, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'max' }),
            'generations',
            'yuanshudian25',
        );
        expect(res.status).toBe(503);
        expect(await res.text()).not.toMatch(/yuanshudian|candidate/i);
    });
});

describe('synoralink25 全量线(与 yuanshudian25 同后端、独立账号池 —— 互为容灾)', () => {
    const URL_SYN = 'http://portal.test/image-adapter25/synoralink25/v1/images/generations';

    it('registry:api.synoralink.com、两模型、无 qualities(全量);brand 抹 synoralink / 图床域 / Provider API error 前缀', () => {
        const p = IMAGE_PROVIDERS_25.synoralink25;
        expect(p.baseUrl).toBe('https://api.synoralink.com');
        expect(p.models).toEqual(GPT_IMAGE_25_MODELS);
        expect(p.qualities).toBeUndefined();
        expect('synoralink cdn.jd23kjs.work Adobe'.replace(p.brand, '*')).toBe('* cdn.*.work *');
        expect('Provider API error: Invalid value'.replace(p.brand, '')).toBe('Invalid value');
        // 两条同后端线必须是两个独立 provider(各自的 base_url / 渠道 key),不能互相覆盖
        expect(p.baseUrl).not.toBe(IMAGE_PROVIDERS_25.yuanshudian25.baseUrl);
    });

    it('5 档 + auto 全部透传上游,按官方档计费(上游浮动 usage 被丢弃)', async () => {
        for (const [q, expectTokens] of [
            ['low', 196],
            ['medium', 439],
            ['high', 1756],
            ['xhigh', 3122],
            ['max', 7024],
            ['auto', 196],
        ] as const) {
            fetchMock.mockReset();
            fetchMock.mockImplementation(
                async () =>
                    new Response(
                        JSON.stringify({
                            created: 1,
                            data: [{ b64_json: pngB64(1024, 1024) }],
                            usage: {
                                input_tokens: 6,
                                output_tokens: 32925,
                                output_tokens_details: { reasoning_tokens: 0 },
                            },
                        }),
                        { status: 200, headers: { 'content-type': 'application/json' } },
                    ),
            );
            const res = await handleAdapter25Image(
                jsonReq(URL_SYN, { model: 'gpt-image-2.5-sunburst', prompt: 'x', size: '1024x1024', quality: q }),
                'generations',
                'synoralink25',
            );
            expect(res.status).toBe(200);
            expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.synoralink.com/v1/images/generations');
            expect(((await res.json()) as { usage: { output_tokens: number } }).usage.output_tokens).toBe(expectTokens);
        }
    });

    it.each([
        [403, { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient account balance' }],
        [503, { error: { message: 'No available compatible accounts', type: 'api_error' } }],
        [502, { error: { message: 'Upstream service temporarily unavailable (synoralink)', type: 'upstream_error' } }],
    ])('上游 %i(余额 0 / 号池空 / 上游不可用)→ 503 failover,体中性不泄品牌与余额', async (status, body) => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: status as number }));
        const res = await handleAdapter25Image(
            jsonReq(URL_SYN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'high' }),
            'generations',
            'synoralink25',
        );
        expect(res.status).toBe(503);
        const text = await res.text();
        expect(text).not.toMatch(/synoralink|balance|compatible accounts/i);
        expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe('upstream_unavailable');
    });
});

describe('2.5 适配器 mask 透传(2026-09-19 补齐;此前只在 2.0 适配器修了)', () => {
    it('multipart edits 带 mask → 上游 FormData 含 mask 文件,不计费', async () => {
        okUpstream([pngB64(1024, 1024)]);
        const fd = new FormData();
        fd.append('model', 'gpt-image-2.5-flare');
        fd.append('prompt', 'edit');
        fd.append('size', '1024x1024');
        fd.append('quality', 'high');
        fd.append('image', new Blob([new Uint8Array(TINY_PNG)], { type: 'image/png' }), 'a.png');
        fd.append('mask', new Blob([new Uint8Array(TINY_PNG)], { type: 'image/png' }), 'm.png');
        const req = new NextRequest(URL_EDIT, { method: 'POST', headers: { authorization: 'Bearer k' }, body: fd });
        const res = await handleAdapter25Image(req, 'edits', 'wetokenasia25');
        expect(res.status).toBe(200);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        const f = init.body as FormData;
        expect(f.getAll('image')).toHaveLength(1);
        const mask = f.get('mask');
        expect(mask).toBeInstanceOf(Blob);
        expect((mask as File).name).toBe('m.png');
        const body = (await res.json()) as { usage: { input_tokens_details: { image_tokens: number } } };
        expect(body.usage.input_tokens_details.image_tokens).toBe(1024); // 只算 image(1024² 夹具),不算 mask(否则 2048)
    });
});

describe('2.5 官方校准(2026-09-19 官方 key 实测):edits 文字 +10/输入图、auto 缺省 1254²、边界 400', () => {
    const URL_G = 'http://portal.test/image-adapter25/wetokenasia25/v1/images/generations';
    const URL_E = 'http://portal.test/image-adapter25/wetokenasia25/v1/images/edits';
    function pngHeader(w: number, h: number): Buffer {
        const png = Buffer.alloc(33);
        png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
        png.writeUInt32BE(13, 8);
        png.write('IHDR', 12, 'latin1');
        png.writeUInt32BE(w, 16);
        png.writeUInt32BE(h, 20);
        return png;
    }
    it('常数 = 10;generations 不加(仍 +6)', () => {
        expect(IMAGE25_TEXT_TOKENS_PER_INPUT_IMAGE).toBe(10);
        expect(estimateTextTokens('a cat')).toBe(8);
    });
    it('edits "a cat" 1 张输入图 → text 18;2 张 → 28;n=2 → 36(官方逐点)', () => {
        const mk = (imgs: number, n: number) =>
            synthUsage25({
                mode: 'edits',
                w: 1024,
                h: 1024,
                quality: 'low',
                prompt: 'a cat',
                inputImageDims: Array.from({ length: imgs }, () => ({ w: 256, h: 256 })),
                imageCount: n,
            });
        expect((mk(1, 1).input_tokens_details as { text_tokens: number }).text_tokens).toBe(18);
        expect((mk(2, 1).input_tokens_details as { text_tokens: number }).text_tokens).toBe(28);
        expect((mk(1, 2).input_tokens_details as { text_tokens: number }).text_tokens).toBe(36);
        expect(mk(1, 1).input_tokens).toBe(18 + 256);
    });
    // 2026-09-30 官方 key 直打 gpt-image-2.5-flare 实测:auto = 模型按 prompt 自选画幅(「竖屏」→ 1024×1536、
    // 中性 → 1254²、「超宽横幅海报」→ 1918×820),官方回显 size 就是实际像素。此前(#480)把 auto 折成固定 1:1
    // 发上游 → 客户 prompt 写「竖屏」仍恒出 1248²。现在 auto 原样透传,计费 + 回显按返回图实际像素(#500)。
    it('generations size=auto → 上游原样收 "auto"(模型自选画幅);返图按实际像素计费 + 回显', async () => {
        okUpstream([pngB64(1248, 1248)]);
        const res = await handleAdapter25Image(
            jsonReq(URL_G, { model: 'gpt-image-2.5-flare', prompt: 'a cat', size: 'auto', quality: 'low' }),
            'generations',
            'wetokenasia25',
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { size: string; usage: { output_tokens: number } };
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect((JSON.parse(String(init.body)) as { size: string }).size).toBe('auto');
        expect(body.size).toBe('1248x1248');
        expect(body.usage.output_tokens).toBe(228);
    });
    it('客户实例(第二轮):prompt「竖屏」+ size=auto → 上游收 "auto",号池返 768×1376 竖版 → 回显 768x1376、按实际计费', async () => {
        okUpstream([pngB64(768, 1376)]);
        const res = await handleAdapter25Image(
            jsonReq(URL_G, {
                model: 'gpt-image-2.5-flare',
                prompt: '可爱的一只猫,竖屏',
                size: 'auto',
                quality: 'low',
                output_format: 'jpeg',
            }),
            'generations',
            'zdchat25',
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { size: string; usage: { output_tokens: number } };
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect((JSON.parse(String(init.body)) as { size: string }).size).toBe('auto');
        expect(body.size).toBe('768x1376');
        expect(body.usage.output_tokens).toBe(officialOutputTokens25(768, 1376, 'low'));
    });
    it('缺省 size → 上游也不带 size(官方缺省即 auto)', async () => {
        okUpstream([pngB64(1264, 848)]);
        const res = await handleAdapter25Image(
            jsonReq(URL_G, { model: 'gpt-image-2.5-flare', prompt: 'a cat', quality: 'low' }),
            'generations',
            'wetokenasia25',
        );
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect((JSON.parse(String(init.body)) as { size?: string }).size).toBeUndefined();
        expect(((await res.json()) as { size: string }).size).toBe('1264x848');
    });
    it('客户实例:size=auto + quality=high + jpeg → 回显 1248x1248、output 2,050(= 官方计算器 1248² high,不再是 1254² 的 2,058)', async () => {
        okUpstream([pngB64(1248, 1248)]);
        const res = await handleAdapter25Image(
            jsonReq(URL_G, {
                model: 'gpt-image-2.5-flare',
                prompt: '可爱的一只猫',
                size: 'auto',
                quality: 'high',
                n: 1,
            }),
            'generations',
            'wetokenasia25',
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { size: string; usage: { output_tokens: number } };
        expect(body.size).toBe('1248x1248');
        expect(body.usage.output_tokens).toBe(2050);
    });
    it('size=auto 且返回图尺寸读不出 → 按官方缺省画幅 1248x1248 计费 + 回显(不 503),打 warn', async () => {
        okUpstream(['bm90LXBuZw==']);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const res = await handleAdapter25Image(
            jsonReq(URL_G, { model: 'gpt-image-2.5-flare', prompt: 'a cat', size: 'auto', quality: 'low' }),
            'generations',
            'wetokenasia25',
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { size: string; usage: { output_tokens: number } };
        expect(body.size).toBe('1248x1248');
        expect(body.usage.output_tokens).toBe(228);
        expect(warn).toHaveBeenCalledWith(
            '[image-adapter25] auto output dimensions unreadable, billing by default auto size',
            expect.objectContaining({ fallback: '1248x1248' }),
        );
        warn.mockRestore();
    });
    it('imageDimensions 读 WebP(VP8 lossy)—— output_format=webp 的 auto 图也能计费', () => {
        const head = Buffer.alloc(20);
        head.write('RIFF', 0, 'latin1');
        head.write('WEBP', 8, 'latin1');
        head.write('VP8 ', 12, 'latin1');
        const vp8 = Buffer.alloc(10);
        vp8.set([0x9d, 0x01, 0x2a], 3);
        vp8.writeUInt16LE(1024, 6);
        vp8.writeUInt16LE(1536, 8);
        head.writeUInt32LE(vp8.length, 16);
        expect(imageDimensions(Buffer.concat([head, vp8]))).toEqual({ w: 1024, h: 1536 });
    });
    it('edits size 缺省 + 16:9 输入 → 上游不带 size(模型跟输入图),返图 1680×944 按实际计 130;input = 18 + 1508', async () => {
        okUpstream([pngB64(1680, 944)]);
        const res = await handleAdapter25Image(
            formReq(URL_E, { model: 'gpt-image-2.5-flare', prompt: 'a cat', quality: 'low' }, [pngHeader(3840, 2160)]),
            'edits',
            'wetokenasia25',
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            size: string;
            usage: {
                output_tokens: number;
                input_tokens: number;
                input_tokens_details: { image_tokens: number; text_tokens: number };
            };
        };
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect((init.body as FormData).get('size')).toBeNull();
        expect(body.size).toBe('1680x944');
        expect(body.usage.output_tokens).toBe(130);
        expect(body.usage.input_tokens_details).toEqual({ text_tokens: 18, image_tokens: 1508 });
        expect(body.usage.input_tokens).toBe(1526);
    });
    it('auto 但上游降级返 512² → 按实际计费(守卫不放松)', async () => {
        okUpstream([pngB64(512, 512)]);
        const res = await handleAdapter25Image(
            jsonReq(URL_G, { model: 'gpt-image-2.5-flare', prompt: 'x', size: 'auto', quality: 'low' }),
            'generations',
            'wetokenasia25',
        );
        const body = (await res.json()) as { size: string };
        expect(body.size).toBe('512x512');
    });
});

describe('JSON /images/edits 输入图:官方 images[{image_url|file_id}] + 自家 image/image_url(2026-09-20 直连 new-api 503 事故)', () => {
    const DATA_URL = 'data:image/png;base64,' + pngB64(1024, 1024);

    it('官方 images:[{image_url: dataURL}] → 上游 multipart 带 1 张 image,输入图按官方口径计费(与 multipart 路径一致)', async () => {
        okUpstream([pngB64(1024, 1024)]);
        const res = await handleAdapter25Image(
            jsonReq(URL_EDIT, {
                model: 'gpt-image-2.5-flare',
                images: [{ image_url: DATA_URL }],
                prompt: 'edit',
                size: '1024x1024',
                quality: 'low',
            }),
            'edits',
            'wetokenasia25',
        );
        expect(res.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://asian-acc.we-token.cc/v1/images/edits');
        const f = init.body as FormData;
        expect(f.getAll('image')).toHaveLength(1);
        expect((f.get('image') as Blob).type).toBe('image/png');
        const body = (await res.json()) as { usage: { input_tokens_details: { image_tokens: number } } };
        expect(body.usage.input_tokens_details.image_tokens).toBe(officialInputImageTokens25({ w: 1024, h: 1024 }));
    });

    it('自家 image:[dataURL, dataURL] → 2 张;mask:{image_url} 对象形 → mask 部件', async () => {
        okUpstream([pngB64(1024, 1024)]);
        const res = await handleAdapter25Image(
            jsonReq(URL_EDIT, {
                model: 'gpt-image-2.5-flare',
                image: [DATA_URL, DATA_URL],
                mask: { image_url: DATA_URL },
                prompt: 'edit',
                size: '1024x1024',
            }),
            'edits',
            'wetokenasia25',
        );
        expect(res.status).toBe(200);
        const f = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
        expect(f.getAll('image')).toHaveLength(2);
        expect(f.get('mask')).toBeInstanceOf(Blob);
    });

    it('官方 image_url 为 https URL → 适配器拉图(第 1 次 fetch)再打上游(第 2 次)', async () => {
        const png = Buffer.from(pngB64(1024, 1024), 'base64');
        fetchMock
            .mockResolvedValueOnce(
                new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ created: 1, data: [{ b64_json: pngB64(1024, 1024) }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            );
        const res = await handleAdapter25Image(
            jsonReq(URL_EDIT, {
                model: 'gpt-image-2.5-flare',
                images: [{ image_url: 'https://rolee-1301812539.cos.ap-shanghai.myqcloud.com/test1.jpg' }],
                prompt: 'edit',
                size: '1024x1024',
            }),
            'edits',
            'wetokenasia25',
        );
        expect(res.status).toBe(200);
        expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
            'https://rolee-1301812539.cos.ap-shanghai.myqcloud.com/test1.jpg',
        );
        const f = (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as FormData;
        expect(f.getAll('image')).toHaveLength(1);
    });

    it('JSON edits 一张图都没有 → 400 missing_required_parameter(终态,不打上游、不 failover)', async () => {
        const res = await handleAdapter25Image(
            jsonReq(URL_EDIT, { model: 'gpt-image-2.5-flare', prompt: 'edit', size: '1024x1024' }),
            'edits',
            'wetokenasia25',
        );
        expect(res.status).toBe(400);
        const j = (await res.json()) as { error: { code: string; param: string; message: string } };
        expect(j.error.code).toBe('missing_required_parameter');
        expect(j.error.param).toBe('image');
        expect(j.error.message).toBe("Missing required parameter: 'image'.");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('file_id 引用(适配器无 portal user 上下文)/ 私网 URL / 拉图失败 → 400 invalid_image,不打上游', async () => {
        for (const images of [
            [{ file_id: 'file_abc' }],
            [{ image_url: 'http://127.0.0.1:3000/x.png' }],
            [{ image_url: 'http://172.20.0.1:3010/x.png' }],
            [{ image_url: 'ftp://example.com/x.png' }],
        ]) {
            fetchMock.mockReset();
            const res = await handleAdapter25Image(
                jsonReq(URL_EDIT, { model: 'gpt-image-2.5-flare', images, prompt: 'edit', size: '1024x1024' }),
                'edits',
                'wetokenasia25',
            );
            expect(res.status).toBe(400);
            expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_image');
            expect(fetchMock).not.toHaveBeenCalled();
        }
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
        const res = await handleAdapter25Image(
            jsonReq(URL_EDIT, {
                model: 'gpt-image-2.5-flare',
                images: [{ image_url: 'https://example.com/missing.png' }],
                prompt: 'edit',
                size: '1024x1024',
            }),
            'edits',
            'wetokenasia25',
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { message: string } }).error.message).toContain('fetch failed: 404');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('上游回「image is required」(即便 500)→ 终态 400 missing_required_parameter,不再 503 空跑渠道', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({ error: { message: 'image is required (request id: x)', type: 'new_api_error' } }),
                { status: 500, headers: { 'content-type': 'application/json' } },
            ),
        );
        const res = await handleAdapter25Image(
            formReq(URL_EDIT, { model: 'gpt-image-2.5-flare', prompt: 'edit', size: '1024x1024' }, [TINY_PNG]),
            'edits',
            'wetokenasia25',
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('missing_required_parameter');
    });

    it('JSON generations 带 images 字段不影响文生图(images 只对 edits 有意义)', async () => {
        okUpstream([pngB64(1024, 1024)]);
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'low' }),
            'generations',
            'wetokenasia25',
        );
        expect(res.status).toBe(200);
    });
});
