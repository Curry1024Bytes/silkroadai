/**
 * Seedance 海外满血 适配器单测 —— 重点覆盖 2026-06-25 参考图修复 + 文档字段对齐:
 *  1. 客户 http 图床 URL → 先转存我们 R2,喂给上游 /v1/assets 的是干净 R2 链接(根治 "Asset provider error")
 *  2. 文档字段 reference_image_urls / image_url 被识别(不再误报 requires image)
 *  3. seconds(字符串)作为 duration 别名
 *  4. video_config.reference_mode = start_end → 角色 first_frame + last_frame
 *  5. data URL 仍转存 R2(回归)
 *  6. 文生(非 -ref)模型带图 → 400 text-only
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockUploadImage = vi.fn(
    async (key: string, _body?: Buffer, _ct?: string) => `https://images.silkroadai.io/${key}`,
);
vi.mock('@/lib/r2/client', () => ({
    uploadImage: (key: string, body: Buffer, ct?: string) => mockUploadImage(key, body, ct),
}));

import { submitVideo } from '../adapter';

const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const mockFetch = vi.fn();
beforeEach(() => {
    vi.clearAllMocks();
    // 上游 service-inference.ai 各端点;非上游 URL = 客户图床 → 返回图片字节(供 re-host fetch)
    mockFetch.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.endsWith('/v1/asset-groups')) return json({ id: 'grp1' });
        if (u.endsWith('/v1/assets/get')) return json({ status: 'completed' });
        if (u.endsWith('/v1/assets'))
            return json({ id: `asset_${Math.random().toString(36).slice(2, 8)}`, task_id: null });
        if (u.endsWith('/v1/video/generate')) return json({ task: { id: 'task_abc' } });
        return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
        });
    });
    global.fetch = mockFetch as typeof fetch;
});

function makeReq(body: unknown, auth = 'Bearer sk-inf-test'): NextRequest {
    return new NextRequest('https://ai.silkroadai.io/seedance-adapter/v1/videos', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify(body),
    });
}

/** 取打到上游某端点的请求体(JSON)。 */
function upstreamBody(pathSuffix: string): Record<string, unknown> {
    const call = mockFetch.mock.calls.find((c) => String(c[0]).endsWith(pathSuffix));
    if (!call) throw new Error(`no upstream call to ${pathSuffix}`);
    return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
}

describe('seedance overseas adapter — 参考图 http URL 转存 R2', () => {
    it('客户 http 图床 URL 不直接喂上游,先转存我们 R2', async () => {
        const customerUrl = 'https://liaobots.abc.r2.cloudflarestorage.com/prod/ref-01.jpg?X-Amz-Signature=deadbeef';
        const res = await submitVideo(
            makeReq({ model: 'dreamina-seedance-2-0-720p-ref', prompt: '动起来', image: customerUrl, duration: 5 }),
        );
        expect(res.status).toBe(200);
        // 客户 URL 被 fetch(re-host)
        expect(mockFetch.mock.calls.some((c) => String(c[0]) === customerUrl)).toBe(true);
        // 上传我们 R2(无扩展名 key)
        expect(mockUploadImage).toHaveBeenCalled();
        expect(mockUploadImage.mock.calls[0][0]).toMatch(/^seedance-ref\//);
        // 喂给上游 /v1/assets 的是我们 R2 链接,不是客户原 URL
        const assetCall = mockFetch.mock.calls.find((c) => String(c[0]).endsWith('/v1/assets'));
        const sentUrl = JSON.parse(String((assetCall![1] as RequestInit).body)).url as string;
        expect(sentUrl.startsWith('https://images.silkroadai.io/seedance-ref/')).toBe(true);
        expect(sentUrl).not.toContain('cloudflarestorage');
    });

    it('reference_image_urls + seconds(字符串)被识别', async () => {
        const res = await submitVideo(
            makeReq({
                model: 'dreamina-seedance-2-0-720p-ref',
                prompt: 'x',
                reference_image_urls: ['https://host.example/a.jpg'],
                seconds: '8',
            }),
        );
        expect(res.status).toBe(200);
        expect(upstreamBody('/v1/video/generate').duration).toBe(8); // seconds → duration
    });

    it('video_config.reference_mode=start_end → 角色 first_frame + last_frame', async () => {
        await submitVideo(
            makeReq({
                model: 'dreamina-seedance-2-0-720p-ref',
                prompt: 'x',
                reference_image_urls: ['https://h/a.jpg', 'https://h/b.jpg'],
                video_config: { reference_mode: 'start_end' },
            }),
        );
        const content = upstreamBody('/v1/video/generate').content as Array<{ type: string; role?: string }>;
        const roles = content.filter((c) => c.type === 'image_url').map((c) => c.role);
        expect(roles).toEqual(['first_frame', 'last_frame']);
    });

    it('data URL 仍转存 R2(回归)', async () => {
        const res = await submitVideo(
            makeReq({
                model: 'dreamina-seedance-2-0-720p-ref',
                prompt: 'x',
                image: 'data:image/png;base64,iVBORw0KGgo=',
            }),
        );
        expect(res.status).toBe(200);
        expect(mockUploadImage).toHaveBeenCalled();
    });

    it('文生(非 -ref)模型带图 → 400 text-only', async () => {
        const res = await submitVideo(
            makeReq({ model: 'dreamina-seedance-2-0-720p', prompt: 'x', image: 'https://h/a.jpg' }),
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { message: string } };
        expect(body.error.message).toContain('text-only');
    });
});
