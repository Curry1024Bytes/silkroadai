/**
 * MiniMax-H3 视频适配器单测(token.xinhankr.com)。
 * 覆盖:鉴权(sk- 前缀 / MINIMAX_XHK_KEY 精确)、model/prompt/duration/resolution 门控、
 * body 透传(ratio/watermark/首尾帧 role 保留)、data URL 转 R2、seconds 别名、
 * 提交/轮询信封、上游报错透传。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockUploadImage = vi.fn(
    async (key: string, _body?: Buffer, _ct?: string) => `https://images.silkroadai.io/${key}`,
);
vi.mock('@/lib/r2/client', () => ({
    uploadImage: (key: string, body: Buffer, ct?: string) => mockUploadImage(key, body, ct),
}));

import { submitVideo, pollVideo, isMinimaxVideoModel } from '../adapter';

const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const UP = 'https://token.xinhankr.com';
const mockFetch = vi.fn();
beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method || 'GET').toUpperCase();
        if (u === `${UP}/v1/video/generations` && method === 'POST') {
            return json({ id: 'video_task_minimax_001', task_id: 'video_task_minimax_001', status: 'pending' });
        }
        if (/\/v1\/video\/generations\/[^/]+$/.test(u) && method === 'GET') {
            return json({
                id: 'video_task_minimax_001',
                status: 'completed',
                data: [{ url: `${UP}/out/minimax_h3.mp4?auth_key=xyz` }],
            });
        }
        return new Response('not found', { status: 404 });
    });
    global.fetch = mockFetch as typeof fetch;
});
afterEach(() => {
    delete process.env.MINIMAX_XHK_KEY;
});

function makeReq(body: unknown, auth = 'Bearer sk-test-upstream-key'): NextRequest {
    return new NextRequest('https://ai.silkroadai.io/minimax-adapter/v1/videos', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify(body),
    });
}
function pollReq(auth = 'Bearer sk-test-upstream-key'): NextRequest {
    return new NextRequest('https://ai.silkroadai.io/minimax-adapter/v1/videos/video_task_minimax_001', {
        method: 'GET',
        headers: { authorization: auth },
    });
}
/** 取打到上游 submit 的请求体。 */
function submitBody(): Record<string, unknown> {
    const call = mockFetch.mock.calls.find(
        (c) => String(c[0]) === `${UP}/v1/video/generations` && (c[1] as RequestInit)?.method === 'POST',
    );
    if (!call) throw new Error('no upstream submit call');
    return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
}

const BASE = { model: 'MiniMax-H3', prompt: '史诗太空歌剧预告', resolution: '2K', duration: 5 };

describe('isMinimaxVideoModel', () => {
    it('大小写宽容命中,其余模型不命中', () => {
        expect(isMinimaxVideoModel('MiniMax-H3')).toBe(true);
        expect(isMinimaxVideoModel('minimax-h3')).toBe(true);
        expect(isMinimaxVideoModel('MiniMaxAI/MiniMax-M2.5')).toBe(false);
        expect(isMinimaxVideoModel('kling-v3')).toBe(false);
    });
});

describe('minimax adapter submit — 门控', () => {
    it('非 sk- 前缀鉴权 → 401,不打上游', async () => {
        const res = await submitVideo(makeReq(BASE, 'Bearer wrong'));
        expect(res.status).toBe(401);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('MINIMAX_XHK_KEY 配置后精确校验:错 key 401,对 key 放行', async () => {
        process.env.MINIMAX_XHK_KEY = 'sk-exact';
        expect((await submitVideo(makeReq(BASE, 'Bearer sk-other'))).status).toBe(401);
        expect((await submitVideo(makeReq(BASE, 'Bearer sk-exact'))).status).toBe(200);
    });

    it('未知 model → 400 model_not_found', async () => {
        const res = await submitVideo(makeReq({ ...BASE, model: 'MiniMax-H2' }));
        expect(res.status).toBe(400);
        const j = (await res.json()) as { error: { code: string } };
        expect(j.error.code).toBe('model_not_found');
    });

    it('缺 prompt → 400', async () => {
        const res = await submitVideo(makeReq({ ...BASE, prompt: undefined }));
        expect(res.status).toBe(400);
    });

    it('duration 缺失 / 非整数 / 越界 → 400(计费一致性,不回落)', async () => {
        for (const duration of [undefined, 4.5, 3, 16, 'x']) {
            const res = await submitVideo(makeReq({ ...BASE, duration }));
            expect(res.status).toBe(400);
        }
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('非法 resolution → 400;缺省回落 768P', async () => {
        expect((await submitVideo(makeReq({ ...BASE, resolution: '1080P' }))).status).toBe(400);
        expect((await submitVideo(makeReq({ ...BASE, resolution: undefined }))).status).toBe(200);
        expect(submitBody().resolution).toBe('768P');
    });
});

describe('minimax adapter submit — 透传', () => {
    it('happy path:规范 model/resolution、鉴权头原样带给上游、信封 queued', async () => {
        const res = await submitVideo(makeReq({ ...BASE, model: 'minimax-h3', resolution: '2k' }));
        expect(res.status).toBe(200);
        const j = (await res.json()) as Record<string, unknown>;
        expect(j.task_id).toBe('video_task_minimax_001');
        expect(j.status).toBe('queued');
        expect(j.model).toBe('MiniMax-H3');
        const b = submitBody();
        expect(b.model).toBe('MiniMax-H3');
        expect(b.resolution).toBe('2K');
        expect(b.duration).toBe(5);
        const call = mockFetch.mock.calls[0];
        const headers = (call[1] as RequestInit).headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer sk-test-upstream-key');
    });

    it('ratio / watermark / 首尾帧 role 对象原样透传', async () => {
        await submitVideo(
            makeReq({
                ...BASE,
                ratio: '16:9',
                aigc_watermark: true,
                images: [
                    { url: 'https://example.com/a.png', role: 'first_frame' },
                    { url: 'https://example.com/b.png', role: 'last_frame' },
                ],
            }),
        );
        const b = submitBody();
        expect(b.ratio).toBe('16:9');
        expect(b.aigc_watermark).toBe(true);
        expect(b.images).toEqual([
            { url: 'https://example.com/a.png', role: 'first_frame' },
            { url: 'https://example.com/b.png', role: 'last_frame' },
        ]);
    });

    it('seconds 别名 → duration,seconds 不透传', async () => {
        await submitVideo(makeReq({ ...BASE, duration: undefined, seconds: 6 }));
        const b = submitBody();
        expect(b.duration).toBe(6);
        expect('seconds' in b).toBe(false);
    });

    it('data URL 图片转存 R2,http(s) 原样;role 保留', async () => {
        const dataUrl = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`;
        await submitVideo(
            makeReq({
                ...BASE,
                images: [{ url: dataUrl, role: 'reference_image' }, 'https://example.com/keep.png'],
            }),
        );
        expect(mockUploadImage).toHaveBeenCalledTimes(1);
        const b = submitBody();
        const imgs = b.images as Array<unknown>;
        expect(imgs[0]).toMatchObject({ role: 'reference_image' });
        expect(String((imgs[0] as { url: string }).url)).toMatch(/^https:\/\/images\.silkroadai\.io\/minimax-input\//);
        expect(imgs[1]).toBe('https://example.com/keep.png');
    });

    it('上游报错(429)→ 状态码 + body 原样透传', async () => {
        mockFetch.mockImplementationOnce(async () =>
            json({ error: { message: 'insufficient balance', type: 'rate_limit_error' } }, 429),
        );
        const res = await submitVideo(makeReq(BASE));
        expect(res.status).toBe(429);
        const j = (await res.json()) as { error: { message: string } };
        expect(j.error.message).toBe('insufficient balance');
    });
});

describe('minimax adapter poll', () => {
    it('completed → video_url/url + progress 100', async () => {
        const res = await pollVideo(pollReq(), 'video_task_minimax_001');
        expect(res.status).toBe(200);
        const j = (await res.json()) as Record<string, unknown>;
        expect(j.status).toBe('completed');
        expect(j.progress).toBe(100);
        expect(j.video_url).toBe(`${UP}/out/minimax_h3.mp4?auth_key=xyz`);
        expect(j.url).toBe(j.video_url);
    });

    it('pending → queued;processing → in_progress', async () => {
        mockFetch.mockImplementationOnce(async () => json({ id: 't', status: 'pending' }));
        let j = (await (await pollVideo(pollReq(), 't')).json()) as Record<string, unknown>;
        expect(j.status).toBe('queued');
        mockFetch.mockImplementationOnce(async () => json({ id: 't', status: 'processing' }));
        j = (await (await pollVideo(pollReq(), 't')).json()) as Record<string, unknown>;
        expect(j.status).toBe('in_progress');
    });

    it('failed → fail_reason 带出,progress 100', async () => {
        mockFetch.mockImplementationOnce(async () =>
            json({ id: 't', status: 'failed', error: { message: 'content moderation rejected' } }),
        );
        const j = (await (await pollVideo(pollReq(), 't')).json()) as Record<string, unknown>;
        expect(j.status).toBe('failed');
        expect(j.fail_reason).toBe('content moderation rejected');
        expect(j.progress).toBe(100);
    });

    it('上游 404 → 状态码 + body 原样透传', async () => {
        mockFetch.mockImplementationOnce(async () => json({ error: { message: 'task not found' } }, 404));
        const res = await pollVideo(pollReq(), 'nope');
        expect(res.status).toBe(404);
    });
});
