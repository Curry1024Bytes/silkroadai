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
        // 旧 asset 流(fast-260128 档)
        if (u.endsWith('/v1/asset-groups')) return json({ id: 'grp1' });
        if (u.endsWith('/v1/assets/get')) return json({ status: 'completed' });
        if (u.endsWith('/v1/assets'))
            return json({ id: `asset_${Math.random().toString(36).slice(2, 8)}`, task_id: null });
        // 新 asset 流(hc 档):GET /v1/sd/assets/{id} → data.Status;POST /v1/sd/assets → data.Id
        if (/\/v1\/sd\/assets\/[^/]+$/.test(u)) return json({ data: { Status: 'Active' } });
        if (u.endsWith('/v1/sd/assets'))
            return json({ data: { Id: `asset_${Math.random().toString(36).slice(2, 8)}` } });
        if (u.endsWith('/v1/video/generate')) return json({ task: { id: 'task_abc' } });
        // 非上游 URL = 客户图床/视频 → 返回字节(供 re-host fetch);按扩展名给 content-type
        const ct = /\.mp4(\?|$)/i.test(u) ? 'video/mp4' : 'image/jpeg';
        return new Response(Buffer.from([0x00, 0x00, 0x00, 0x18]), { status: 200, headers: { 'content-type': ct } });
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
        // 720p-ref → hc → 新 /v1/sd/assets 流;喂给上游的是我们 R2 链接(字段 URL),不是客户原 URL
        const assetCall = mockFetch.mock.calls.find((c) => String(c[0]).endsWith('/v1/sd/assets'));
        const sentUrl = JSON.parse(String((assetCall![1] as RequestInit).body)).URL as string;
        expect(sentUrl.startsWith('https://images.silkroadai.io/seedance-ref/')).toBe(true);
        expect(sentUrl).not.toContain('cloudflarestorage');
    });

    it('fast 档(→ fast-260128)走【旧】asset 流(/v1/asset-groups + /v1/assets),不走 /v1/sd/assets', async () => {
        // hc 与 fast-260128 的 asset 存储互不相认,故 submitVideo 按 map.svc 分流:fast → 旧 API
        const res = await submitVideo(
            makeReq({ model: 'dreamina-seedance-2-0-fast-720p-ref', prompt: 'x', image: 'https://h/a.jpg' }),
        );
        expect(res.status).toBe(200);
        expect(mockFetch.mock.calls.some((c) => String(c[0]).endsWith('/v1/asset-groups'))).toBe(true);
        expect(mockFetch.mock.calls.some((c) => String(c[0]).endsWith('/v1/assets'))).toBe(true);
        expect(mockFetch.mock.calls.some((c) => String(c[0]).endsWith('/v1/sd/assets'))).toBe(false);
        const content = upstreamBody('/v1/video/generate').content as Array<{
            type: string;
            image_url?: { url: string };
        }>;
        expect(String(content.find((c) => c.type === 'image_url')?.image_url?.url)).toMatch(/^asset:\/\//);
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

    it('reference_videos → 转存 R2 → 上传 asset_type=Video → content video_url asset://(走 asset 流)', async () => {
        const res = await submitVideo(
            makeReq({
                model: 'dreamina-seedance-2-0-720p-ref',
                prompt: '运镜参考 @Video1',
                reference_videos: ['https://customer.example/clip.mp4?sig=x'],
            }),
        );
        expect(res.status).toBe(200);
        // 客户视频 URL 被 re-host(fetch)→ 转存我们 R2
        expect(mockFetch.mock.calls.some((c) => String(c[0]) === 'https://customer.example/clip.mp4?sig=x')).toBe(true);
        // 720p-ref → hc → 视频走新 /v1/sd/assets 上传,AssetType=Video,URL 是我们 R2 干净链接
        const assetCall = mockFetch.mock.calls.find((c) => String(c[0]).endsWith('/v1/sd/assets'));
        const assetBody = JSON.parse(String((assetCall![1] as RequestInit).body));
        expect(assetBody.AssetType).toBe('Video');
        expect(String(assetBody.URL).startsWith('https://images.silkroadai.io/seedance-ref/')).toBe(true);
        // content 含 video_url + role reference_video,url 是 asset://(非直链)
        const content = upstreamBody('/v1/video/generate').content as Array<{
            type: string;
            role?: string;
            video_url?: { url: string };
        }>;
        const v = content.find((c) => c.type === 'video_url');
        expect(v?.role).toBe('reference_video');
        expect(String(v?.video_url?.url)).toMatch(/^asset:\/\//);
    });

    it('文生(非 -ref)模型带参考视频 → 400 text-only', async () => {
        const res = await submitVideo(
            makeReq({ model: 'dreamina-seedance-2-0-720p', prompt: 'x', reference_videos: ['https://h/c.mp4'] }),
        );
        expect(res.status).toBe(400);
    });

    it('上游多层嵌套错误 → 透出最具体真因(不再 [object Object])', async () => {
        // 复刻 service-inference.ai 实际形态:error.message 里再塞一层转义 JSON,内含审核码
        const innermost = JSON.stringify({
            error: {
                code: 'InputTextSensitiveContentDetected',
                message: 'The request failed because the input text may contain sensitive information',
            },
        });
        const mid = JSON.stringify({ code: 'fail_to_fetch_task', message: innermost });
        const upstreamErr = JSON.stringify({
            error: { message: `Failed to submit video generation job: Upstream submit failed (400): ${mid}` },
        });
        mockFetch.mockImplementation(async (url: string) => {
            if (String(url).endsWith('/v1/video/generate'))
                return new Response(upstreamErr, { status: 400, headers: { 'content-type': 'application/json' } });
            return json({});
        });
        const res = await submitVideo(makeReq({ model: 'dreamina-seedance-2-0-720p', prompt: '某敏感提示词' }));
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { message: string } };
        expect(body.error.message).toContain('InputTextSensitiveContentDetected');
        expect(body.error.message).toContain('sensitive information');
        expect(body.error.message).not.toContain('[object Object]');
    });

    it('参考图被上游 asset 拒(Asset provider error)→ 报错补上图片尺寸,给可懂原因', async () => {
        // 最小 JPEG:SOF0 编码 438×320(短边 320,上游会拒)
        const smallJpeg = Buffer.from([
            0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x40, 0x01, 0xb6, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]);
        mockFetch.mockImplementation(async (url: string) => {
            const u = String(url);
            // 720p-ref → hc → 新 /v1/sd/assets 流;POST 直接回 Asset provider error
            if (u.endsWith('/v1/sd/assets'))
                return new Response(
                    JSON.stringify({ error: { message: 'Asset provider error', type: 'proxy_error' } }),
                    {
                        status: 400,
                        headers: { 'content-type': 'application/json' },
                    },
                );
            if (u.endsWith('/v1/video/generate')) return json({ task: { id: 't' } });
            // 客户图 URL(re-host)+ R2 url(量尺寸)都返回这张小 JPEG
            return new Response(smallJpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
        });
        const res = await submitVideo(
            makeReq({ model: 'dreamina-seedance-2-0-720p-ref', prompt: 'x', image: 'https://cust/small.jpg' }),
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { message: string } };
        expect(body.error.message).toContain('438×320'); // 尺寸补进错误
        expect(body.error.message).toContain('参考图');
        expect(body.error.message).not.toContain('[object Object]');
    });

    it('CreateAsset 账号限流(AccountFlowLimitExceeded / 1033)→ 退避重试后成功', async () => {
        let nPost = 0;
        mockFetch.mockImplementation(async (url: string) => {
            const u = String(url);
            if (u.endsWith('/v1/sd/assets')) {
                // POST create:第 1 次回账号流控 400,之后成功
                nPost++;
                if (nPost === 1)
                    return new Response(
                        JSON.stringify({
                            success: false,
                            message:
                                'CreateAsset failed: status_code=1033 status_msg=system error, upstream CreateAsset failed: AccountFlowLimitExceeded',
                        }),
                        { status: 400, headers: { 'content-type': 'application/json' } },
                    );
                return json({ data: { Id: 'asset_ok' } });
            }
            if (/\/v1\/sd\/assets\/[^/]+$/.test(u)) return json({ data: { Status: 'Active' } });
            if (u.endsWith('/v1/video/generate')) return json({ task: { id: 't' } });
            return new Response(Buffer.from([0x00, 0x00, 0x00, 0x18]), {
                status: 200,
                headers: { 'content-type': 'image/jpeg' },
            });
        });
        const res = await submitVideo(
            makeReq({ model: 'dreamina-seedance-2-0-480p-ref', prompt: 'x', image: 'https://h/a.jpg' }),
        );
        expect(res.status).toBe(200); // 重试后成功
        expect(nPost).toBeGreaterThanOrEqual(2); // 第 1 次限流、第 2 次成功
    }, 15000);
});
