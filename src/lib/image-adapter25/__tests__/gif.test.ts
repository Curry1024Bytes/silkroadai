/**
 * gpt-image-2.6 GIF 规则。帧数 / 帧时长 / 拼图报错的 ground truth 来自 2026-11-06 ztyunjuan 透出的官方错误原文,
 * 放大尺寸对照 ztyunjuan 实测(512×512 → 816×816、512×768 → 672×992)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { handleAdapter25Image, imageDimensions, sniffOutputFormat } from '@/lib/image-adapter25/adapter';
import {
    gifDimensions,
    gifFrameCount,
    gifSheetDims,
    gifUpstreamDims,
    gpt26ParamError,
    pickFrameIndices,
    pruneGpt26Extras,
    resizeGifB64,
    retimeGifB64,
    takeEditsGifFrameParams,
} from '@/lib/image-adapter25/gif';
import { resolveOutputBackground } from '@/lib/image/opacity';

async function animatedGif(size: number, frames: number, delayMs: number): Promise<Buffer> {
    const pages = await Promise.all(
        Array.from({ length: frames }, (_, i) =>
            sharp({ create: { width: size, height: size, channels: 3, background: { r: 25 * i, g: 80, b: 120 } } })
                .png()
                .toBuffer(),
        ),
    );
    return sharp(pages, { join: { animated: true } })
        .gif({ delay: Array.from({ length: frames }, () => delayMs) })
        .toBuffer();
}

const framesOf = async (b64: string) => {
    const m = await sharp(Buffer.from(b64, 'base64'), { animated: true }).metadata();
    return { pages: m.pages, delay: m.delay, w: m.width, h: m.pageHeight };
};

describe('gifSheetDims / gifFrameCount', () => {
    it.each([
        [512, 512, 2, 2048, 1024],
        [512, 512, 8, 2048, 1024],
        [512, 512, 9, 1536, 1536],
        [512, 512, 10, 2048, 1536],
        [512, 512, 13, 2048, 2048],
        [768, 512, 2, 1536, 2048],
        [512, 768, 2, 2048, 1536],
        [768, 512, 12, 2304, 2048],
    ])('%dx%d %d 帧 → %dx%d', (w, h, frames, sw, sh) => {
        expect(gifSheetDims(w, h, frames)).toEqual({ w: sw, h: sh });
    });

    it('frame_count 缺省按 9 帧', () => {
        expect(gifFrameCount({})).toBe(9);
        expect(gifFrameCount({ frame_count: '4' })).toBe(4);
    });
});

describe('gifUpstreamDims', () => {
    it.each([
        [512, 512, 816, 816],
        [512, 768, 672, 992],
        [256, 256, 816, 816],
    ])('%dx%d 低于下限 → 同比放大到 %dx%d', (w, h, upW, upH) => {
        expect(gifUpstreamDims({ w, h })).toEqual({ w: upW, h: upH });
    });
    it('达到下限的尺寸原样发', () => {
        expect(gifUpstreamDims({ w: 816, h: 816 })).toEqual({ w: 816, h: 816 });
    });
});

describe('gpt26ParamError', () => {
    const gif = (extra: Record<string, string>) => gpt26ParamError({ output_format: 'gif', ...extra }, false);

    it('svg 立即拒,param 指向 output_format', () => {
        expect(gpt26ParamError({ output_format: 'SVG' }, false)).toMatchObject({
            param: 'output_format',
            code: 'invalid_value',
        });
    });
    it.each([
        [{ frame_count: '1' }, 'frame_count'],
        [{ frame_count: '17' }, 'frame_count'],
        [{ frame_count: '2.5' }, 'frame_count'],
        [{ frame_duration_ms: '10' }, 'frame_duration_ms'],
        [{ output_compression: '50' }, 'output_compression'],
        [{ background: 'transparent' }, 'background'],
        [{ complexity: 'bogus' }, 'complexity'],
    ])('%j → 400 param=%s', (extra, param) => {
        expect(gif(extra)?.param).toBe(param);
    });
    it('GIF 不收蒙版', () => {
        expect(gpt26ParamError({ output_format: 'gif' }, true)?.param).toBe('mask');
    });
    it('改图出 GIF:frame_count 2-9、frame_duration_ms 放行(本地处理),10-16 说明改图上限', () => {
        expect(gpt26ParamError({ output_format: 'gif', frame_count: '3' }, false, true)).toBeNull();
        expect(gpt26ParamError({ output_format: 'gif', frame_count: '9' }, false, true)).toBeNull();
        expect(gpt26ParamError({ output_format: 'gif', frame_duration_ms: '100' }, false, true)).toBeNull();
        expect(gpt26ParamError({ output_format: 'gif' }, false, true)).toBeNull();
        expect(gpt26ParamError({ output_format: 'gif', frame_count: '12' }, false, true)).toEqual({
            detail: "Invalid 'frame_count' for GIF output from image edits. Received 12. Use an integer from 2 to 9, or omit 'frame_count' to use 9.",
            param: 'frame_count',
            code: 'invalid_value',
        });
        // 文生图不受改图上限影响;越过官方 2-16 仍是官方文案
        expect(gpt26ParamError({ output_format: 'gif', frame_count: '12' }, false, false)).toBeNull();
        expect(gpt26ParamError({ output_format: 'gif', frame_count: '17' }, false, true)?.detail).toMatch(
            /^Invalid 'frame_count' for GIF output\. Received 17/,
        );
        expect(gpt26ParamError({ output_format: 'gif', frame_duration_ms: '10' }, false, true)?.code).toBe(
            'integer_below_min_value',
        );
    });
    it('合法组合放行;帧时长没有上限(上游实测 3000ms 通过)', () => {
        expect(gif({ frame_count: '16', frame_duration_ms: '3000', complexity: 'low' })).toBeNull();
    });
    it('非 GIF 的 compression / 透明背景不归这里管', () => {
        expect(gpt26ParamError({ output_format: 'webp', output_compression: '50' }, false)).toBeNull();
        expect(gpt26ParamError({ background: 'transparent' }, false)).toBeNull();
    });
});

describe('pruneGpt26Extras', () => {
    const extras = { output_format: 'gif', frame_count: '4', frame_duration_ms: '100', complexity: 'low' };
    it('2.6 GIF 全留', () => {
        expect(pruneGpt26Extras(extras, true)).toEqual(extras);
    });
    it('2.6 非 GIF 去掉帧参数,保留 complexity', () => {
        expect(pruneGpt26Extras({ ...extras, output_format: 'png' }, true)).toEqual({
            output_format: 'png',
            complexity: 'low',
        });
    });
    it('非 2.6 模型一个都不发上游', () => {
        expect(pruneGpt26Extras(extras, false)).toEqual({ output_format: 'gif' });
    });
});

describe('改图 GIF 帧参数本地处理', () => {
    it('takeEditsGifFrameParams:帧参数不发上游,交给本地', () => {
        const extras = { output_format: 'gif', frame_count: '3', frame_duration_ms: '100', complexity: 'low' };
        expect(takeEditsGifFrameParams(extras)).toEqual({
            upstreamExtras: { output_format: 'gif', complexity: 'low' },
            retime: { frames: 3, durationMs: 100 },
        });
        expect(takeEditsGifFrameParams({ output_format: 'gif', frame_duration_ms: '50' }).retime).toEqual({
            frames: null,
            durationMs: 50,
        });
        const none = { output_format: 'gif' };
        expect(takeEditsGifFrameParams(none)).toEqual({ upstreamExtras: none, retime: null });
    });
    it.each([
        [9, 3, [0, 3, 6]],
        [9, 2, [0, 4]],
        [9, 4, [0, 2, 4, 6]],
        [9, 9, [0, 1, 2, 3, 4, 5, 6, 7, 8]],
        [9, 12, [0, 1, 2, 3, 4, 5, 6, 7, 8]],
    ])('pickFrameIndices(%i, %i) = %j', (total, n, want) => {
        expect(pickFrameIndices(total, n)).toEqual(want);
    });
    it('retimeGifB64 抽帧 + 改时长:9 帧取 3 帧,取的是第 0/3/6 帧', async () => {
        const b64 = (await animatedGif(32, 9, 200)).toString('base64');
        const out = await retimeGifB64(b64, { frames: 3, durationMs: 100 });
        expect(await framesOf(out)).toEqual({ pages: 3, delay: [100, 100, 100], w: 32, h: 32 });
        const reds = await Promise.all(
            [0, 1, 2].map(async (page) => {
                const { data } = await sharp(Buffer.from(out, 'base64'), { page })
                    .raw()
                    .toBuffer({ resolveWithObject: true });
                return data[0];
            }),
        );
        // animatedGif 第 i 帧 r = 25·i → 0 / 75 / 150(GIF 调色板量化允许小误差)
        reds.forEach((r, k) => expect(Math.abs(r - [0, 75, 150][k])).toBeLessThanOrEqual(8));
    });
    it('只改时长:帧数不变;只抽帧:时长取官方默认 200', async () => {
        const b64 = (await animatedGif(32, 9, 200)).toString('base64');
        expect(await framesOf(await retimeGifB64(b64, { frames: null, durationMs: 50 }))).toMatchObject({
            pages: 9,
            delay: Array(9).fill(50),
        });
        expect(await framesOf(await retimeGifB64(b64, { frames: 4, durationMs: null }))).toMatchObject({
            pages: 4,
            delay: [200, 200, 200, 200],
        });
    });
    it('不是 GIF / 单帧 → 原样', async () => {
        expect(await retimeGifB64('iVBORw0KGgo=', { frames: 3, durationMs: 100 })).toBe('iVBORw0KGgo=');
        const single = (
            await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } })
                .gif()
                .toBuffer()
        ).toString('base64');
        expect(await retimeGifB64(single, { frames: 3, durationMs: 100 })).toBe(single);
    });
});

describe('GIF 字节', () => {
    it('imageDimensions / sniffOutputFormat 认 GIF', async () => {
        const buf = await animatedGif(32, 2, 100);
        expect(gifDimensions(buf)).toEqual({ w: 32, h: 32 });
        expect(imageDimensions(buf)).toEqual({ w: 32, h: 32 });
        expect(sniffOutputFormat(buf)).toBe('gif');
    });
    it('resizeGifB64 缩到目标尺寸,帧数和帧时长不变', async () => {
        const b64 = (await animatedGif(64, 4, 100)).toString('base64');
        const out = await resizeGifB64(b64, { w: 32, h: 32 });
        expect(await framesOf(out)).toEqual({ pages: 4, delay: [100, 100, 100, 100], w: 32, h: 32 });
    });
    it('已是目标尺寸 / 不是 GIF → 原样', async () => {
        const b64 = (await animatedGif(32, 2, 100)).toString('base64');
        expect(await resizeGifB64(b64, { w: 32, h: 32 })).toBe(b64);
        expect(await resizeGifB64('iVBORw0KGgo=', { w: 32, h: 32 })).toBe('iVBORw0KGgo=');
    });
    it('background=opaque 不压平动图', async () => {
        const b64 = (await animatedGif(32, 3, 100)).toString('base64');
        expect(await resolveOutputBackground(b64, 'opaque')).toEqual({ b64, background: 'opaque' });
    });
});

describe('适配器 GIF 全流程', () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    const post = (provider: string, model: string, body: Record<string, unknown>) =>
        handleAdapter25Image(
            new NextRequest(`http://portal.test/image-adapter25/${provider}/v1/images/generations`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer sk-upstream-test' },
                body: JSON.stringify({ model, prompt: 'x', output_format: 'gif', quality: 'low', ...body }),
            }),
            'generations',
            provider,
        );
    const upstreamReturns = (b64: string) =>
        fetchMock.mockImplementation(
            async () =>
                new Response(JSON.stringify({ created: 1, data: [{ b64_json: b64 }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
    const sent = () => JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;

    it('帧参数以整数发上游,512×512 放大发出、缩回交付,回显 gif 并按交付尺寸计费', async () => {
        upstreamReturns((await animatedGif(816, 4, 100)).toString('base64'));
        const res = await post('ztyunjuan26', 'gpt-image-2.6-flare', {
            size: '512x512',
            frame_count: 4,
            frame_duration_ms: 100,
            complexity: 'low',
        });
        expect(res.status).toBe(200);
        expect(sent()).toMatchObject({
            size: '816x816',
            frame_count: 4,
            frame_duration_ms: 100,
            complexity: 'low',
            output_format: 'gif',
        });
        const j = (await res.json()) as {
            size: string;
            output_format: string;
            background: string;
            data: Array<{ b64_json: string }>;
        };
        expect(j).toMatchObject({ size: '512x512', output_format: 'gif', background: 'opaque' });
        expect(await framesOf(j.data[0].b64_json)).toMatchObject({ pages: 4, w: 512, h: 512 });
    });

    it('缺省 size 按 512×512:上游收 816×816(不把 1024² 的 auto 发上游)', async () => {
        upstreamReturns((await animatedGif(816, 2, 200)).toString('base64'));
        const res = await post('wetokenasia26', 'gpt-image-2.6-flare', {});
        expect(res.status).toBe(200);
        expect(sent().size).toBe('816x816');
        expect(((await res.json()) as { size: string }).size).toBe('512x512');
    });

    it('上游拼图放不下 → 终态 400,param=size,不 failover', async () => {
        fetchMock.mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({
                        error: {
                            message:
                                "Bad request to openai: No supported sheet fits 4 GIF frames at size '1024x1024'. Invalid size '4096x2048'.",
                            type: 'invalid_request_error',
                        },
                    }),
                    { status: 400, headers: { 'content-type': 'application/json' } },
                ),
        );
        const res = await post('ztyunjuan26', 'gpt-image-2.6-flare', { size: '1024x1024', frame_count: 4 });
        expect(res.status).toBe(400);
        const { error } = (await res.json()) as { error: { message: string; param: string } };
        expect(error.param).toBe('size');
        expect(error.message).toBe('No supported sheet fits 4 GIF frames at the requested size.');
    });

    const postEdit = async (provider: string, fields: Record<string, string>) => {
        const form = new FormData();
        for (const [k, v] of Object.entries({
            model: 'gpt-image-2.6-flare',
            prompt: 'x',
            output_format: 'gif',
            quality: 'low',
            ...fields,
        }))
            form.append(k, v);
        const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#c33' } })
            .png()
            .toBuffer();
        form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'i.png');
        return handleAdapter25Image(
            new NextRequest(`http://portal.test/image-adapter25/${provider}/v1/images/edits`, {
                method: 'POST',
                headers: { authorization: 'Bearer sk-upstream-test' },
                body: form,
            }),
            'edits',
            provider,
        );
    };

    it.each(['ztyunjuan26', 'wetokenasia26'])(
        '%s 改图 GIF:帧参数不发上游,本地抽成 3 帧 100ms,按 3 帧拼图计费',
        async (provider) => {
            upstreamReturns((await animatedGif(816, 9, 200)).toString('base64'));
            const res = await postEdit(provider, { size: '512x512', frame_count: '3', frame_duration_ms: '100' });
            expect(res.status).toBe(200);
            const f = fetchMock.mock.calls[0][1]?.body as FormData;
            expect(f.get('frame_count')).toBeNull();
            expect(f.get('frame_duration_ms')).toBeNull();
            expect(f.get('output_format')).toBe('gif');
            expect(f.get('size')).toBe('816x816');
            const j = (await res.json()) as {
                size: string;
                output_format: string;
                usage: { output_tokens: number };
                data: Array<{ b64_json: string }>;
            };
            expect(j).toMatchObject({ size: '512x512', output_format: 'gif' });
            expect(await framesOf(j.data[0].b64_json)).toEqual({ pages: 3, delay: [100, 100, 100], w: 512, h: 512 });
            expect(j.usage.output_tokens).toBe(555); // 512² low,2-8 帧拼 4×2,与官方一致
        },
    );

    it('改图 GIF 不带帧参数:上游的 9 帧原样交付', async () => {
        upstreamReturns((await animatedGif(816, 9, 200)).toString('base64'));
        const res = await postEdit('ztyunjuan26', { size: '816x816' });
        const j = (await res.json()) as { data: Array<{ b64_json: string }> };
        expect(await framesOf(j.data[0].b64_json)).toMatchObject({ pages: 9, w: 816, h: 816 });
    });

    it('改图 GIF frame_count=12 → 400 说明改图上限 9,不打上游', async () => {
        const res = await postEdit('ztyunjuan26', { size: '512x512', frame_count: '12' });
        expect(res.status).toBe(400);
        const { error } = (await res.json()) as { error: { message: string; param: string } };
        expect(error.param).toBe('frame_count');
        expect(error.message).toContain('from 2 to 9');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('svg 立即 400,不打上游', async () => {
        const res = await post('ztyunjuan26', 'gpt-image-2.6-flare', { output_format: 'svg', size: '1024x1024' });
        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('2.5 模型不带 2.6 字段,尺寸也不改', async () => {
        upstreamReturns((await animatedGif(1024, 2, 200)).toString('base64'));
        await post('wetokenasia25', 'gpt-image-2.5-flare', { size: '1024x1024', frame_count: 4, complexity: 'low' });
        const body = sent();
        expect(body.frame_count).toBeUndefined();
        expect(body.complexity).toBeUndefined();
        expect(body.size).toBe('1024x1024');
    });
});
