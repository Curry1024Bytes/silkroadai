/**
 * gpt-image-2.5 独立适配器单测。ground truth 全部来自 2026-09-09 用 viper3 官 key 交叉验证的
 * 真实 usage(不是自算期望值):5 档输出网格、官方输入图 patch 口径、auto→low、n 原生 honor。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
    handleAdapter25Image,
    officialOutputTokens25,
    officialInputImageTokens25,
    normQuality25,
    synthUsage25,
    sanitizeAdapterError25,
    estimateTextTokens,
} from '@/lib/image-adapter25/adapter';

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
        expect(det.image_tokens).toBe(1521 + 1024);
        expect(u.input_tokens).toBe(estimateTextTokens('add a tiny star') + 1521 + 1024);
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
        expect(body.usage.output_tokens).toBe(196 * 3);
    });

    it('上游少返(n=3 只回 2)→ 按 2 张计费不失败', async () => {
        okUpstream([pngB64(1024, 1024), pngB64(1024, 1024)]);
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '1024x1024', quality: 'low', n: 3 }),
            'generations',
            'wetokenasia25',
        );
        expect(((await res.json()) as { usage: { output_tokens: number } }).usage.output_tokens).toBe(196 * 2);
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

    it('上游官方形非法尺寸 400(total pixels must not be less than …)→ 终态 invalid_request', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({ error: { message: 'invalid image size: total pixels must not be less than 655360' } }),
                {
                    status: 400,
                },
            ),
        );
        const res = await handleAdapter25Image(
            jsonReq(URL_GEN, { model: 'gpt-image-2.5-flare', prompt: 'x', size: '512x512', quality: 'low' }),
            'generations',
            'wetokenasia25',
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
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
