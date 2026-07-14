/**
 * Seedance 国内企业级端口 适配器单测(火山方舟 / token.xinhankr.com)。
 * 覆盖:档位→上游单模型+resolution 映射、参考模式门控(防串档)、data URL 转 R2、
 * duration/ratio 归一、提交/轮询信封、成片转存 R2、model/prompt 校验。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockUploadImage = vi.fn(
    async (key: string, _body?: Buffer, _ct?: string) => `https://images.silkroadai.io/${key}`,
);
vi.mock('@/lib/r2/client', () => ({
    uploadImage: (key: string, body: Buffer, ct?: string) => mockUploadImage(key, body, ct),
}));

import { submitVideo, pollVideo } from '../cn-adapter';

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
            return json({ id: 'cgt-test-1', task_id: 'cgt-test-1', object: 'video.generation', status: 'pending' });
        }
        if (/\/v1\/video\/generations\/[^/]+$/.test(u) && method === 'GET') {
            return json({
                id: 'cgt-test-1',
                status: 'completed',
                data: [{ url: `${UP}/out/generated.mp4?auth_key=xyz` }],
                usage: { total_tokens: 50638 },
            });
        }
        // 其余(客户图床 / 成片下载)→ 返回字节
        return new Response(Buffer.from([0x00, 0x00, 0x00, 0x18]), {
            status: 200,
            headers: { 'content-type': /\.mp4/i.test(u) ? 'video/mp4' : 'image/jpeg' },
        });
    });
    global.fetch = mockFetch as typeof fetch;
});

function makeReq(body: unknown, auth = 'Bearer sk-9066test'): NextRequest {
    return new NextRequest('https://ai.silkroadai.io/seedance-cn-adapter/v1/videos', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify(body),
    });
}
function pollReq(auth = 'Bearer sk-9066test'): NextRequest {
    return new NextRequest('https://ai.silkroadai.io/seedance-cn-adapter/v1/videos/cgt-test-1', {
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

describe('seedance-cn adapter submit', () => {
    it('文生(无参考档):映射到上游单模型 + resolution,不带 images', async () => {
        const res = await submitVideo(makeReq({ model: 'artsdance2.0-pro-1080p', prompt: '一只猫在雪地里' }));
        expect(res.status).toBe(200);
        const j = (await res.json()) as Record<string, unknown>;
        expect(j.task_id).toBe('cgt-test-1');
        expect(j.model).toBe('artsdance2.0-pro-1080p');
        const b = submitBody();
        expect(b.model).toBe('artsdance2.0-pro-260701');
        expect(b.resolution).toBe('1080p');
        expect(b.images).toBeUndefined();
        expect(b.generate_audio).toBe(true);
    });

    it('未知模型 → 400 model_not_found', async () => {
        const res = await submitVideo(makeReq({ model: 'artsdance2.0-pro-8k', prompt: 'x' }));
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('model_not_found');
    });

    it('缺 prompt → 400', async () => {
        const res = await submitVideo(makeReq({ model: 'artsdance2.0-pro-720p' }));
        expect(res.status).toBe(400);
    });

    it('无参考档带图 → 400 text-only(防串便宜档)', async () => {
        const res = await submitVideo(
            makeReq({ model: 'artsdance2.0-pro-720p', prompt: 'x', image: 'https://img/a.png' }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/text-only/);
    });

    it('参考档不带任何输入 → 400 requires reference', async () => {
        const res = await submitVideo(makeReq({ model: 'artsdance2.0-pro-720p-ref', prompt: 'x' }));
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/requires a reference/);
    });

    it('参考档 data URL 图 → 转存 R2 + role=reference_image', async () => {
        const dataUrl = 'data:image/png;base64,aGVsbG8=';
        const res = await submitVideo(
            makeReq({ model: 'artsdance2.0-pro-2k-ref', prompt: '参考图生视频', image_url: dataUrl }),
        );
        expect(res.status).toBe(200);
        expect(mockUploadImage).toHaveBeenCalled();
        const b = submitBody();
        expect(b.resolution).toBe('2k');
        const images = b.images as Array<{ url: string; role: string }>;
        expect(images).toHaveLength(1);
        expect(images[0].role).toBe('reference_image');
        expect(images[0].url).toMatch(/^https:\/\/images\.silkroadai\.io\/seedance-cn-ref\//);
    });

    it('参考档 http 图直链 → 原样透传上游(不转存)', async () => {
        const res = await submitVideo(
            makeReq({ model: 'artsdance2.0-pro-720p-ref', prompt: 'x', image: 'https://cdn/a.png' }),
        );
        expect(res.status).toBe(200);
        const images = submitBody().images as Array<{ url: string; role: string }>;
        expect(images[0].url).toBe('https://cdn/a.png');
    });

    it('reference_mode start_end → 首尾帧角色', async () => {
        const res = await submitVideo(
            makeReq({
                model: 'artsdance2.0-pro-720p-ref',
                prompt: 'x',
                images: ['https://cdn/1.png', 'https://cdn/2.png'],
                video_config: { reference_mode: 'start_end' },
            }),
        );
        expect(res.status).toBe(200);
        const images = submitBody().images as Array<{ url: string; role: string }>;
        expect(images.map((i) => i.role)).toEqual(['first_frame', 'last_frame']);
    });

    it('参考音频:ref 档 + 图 + audio_url → 上游带 audios', async () => {
        const res = await submitVideo(
            makeReq({
                model: 'artsdance2.0-pro-720p-ref',
                prompt: '让画中人跟着音乐节奏点头',
                image: 'https://cdn/a.png',
                audio_url: 'https://cdn/track.mp3',
            }),
        );
        expect(res.status).toBe(200);
        const b = submitBody();
        expect((b.images as unknown[]).length).toBe(1);
        expect(b.audios).toEqual(['https://cdn/track.mp3']);
    });

    it('音频但没图 → 400(音频需配 ≥1 图)', async () => {
        const res = await submitVideo(
            makeReq({ model: 'artsdance2.0-pro-720p-ref', prompt: 'x', audio_url: 'https://cdn/track.mp3' }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/audio requires/);
    });

    it('duration 归一到 5/10;ratio 白名单外回落 16:9;generate_audio:false 关', async () => {
        await submitVideo(
            makeReq({
                model: 'artsdance2.0-pro-720p',
                prompt: 'x',
                duration: 10,
                ratio: '7:3',
                generate_audio: false,
            }),
        );
        const b = submitBody();
        expect(b.duration).toBe(10);
        expect(b.ratio).toBe('16:9');
        expect(b.generate_audio).toBe(false);
    });

    it('XHK_KEY 配置时精确校验:错 key → 401', async () => {
        const prev = process.env.SEEDANCE_XHK_KEY;
        process.env.SEEDANCE_XHK_KEY = 'sk-correct';
        try {
            const res = await submitVideo(makeReq({ model: 'artsdance2.0-pro-720p', prompt: 'x' }, 'Bearer sk-wrong'));
            expect(res.status).toBe(401);
        } finally {
            if (prev === undefined) delete process.env.SEEDANCE_XHK_KEY;
            else process.env.SEEDANCE_XHK_KEY = prev;
        }
    });
});

describe('seedance-cn adapter poll', () => {
    it('完成 → 直接返回火山原始直链(不转存 R2)', async () => {
        const res = await pollVideo(pollReq(), 'cgt-test-1');
        expect(res.status).toBe(200);
        const j = (await res.json()) as Record<string, unknown>;
        expect(j.status).toBe('completed');
        // 成片不落 R2:video_url = 上游火山直链原样
        expect(mockUploadImage).not.toHaveBeenCalled();
        expect(j.video_url).toBe(`${UP}/out/generated.mp4?auth_key=xyz`);
        expect(j.url).toBe(j.video_url);
    });
});
