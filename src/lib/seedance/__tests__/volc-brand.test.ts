/** 火山形视频 URL 品牌化:env 双开关 inert 默认 + 幂等转存 + 失败回退。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { objectExists, uploadImage } = vi.hoisted(() => ({
    objectExists: vi.fn(),
    uploadImage: vi.fn(),
}));
vi.mock('@/lib/r2/client', () => ({ objectExists, uploadImage }));

import { buildBrandedVolcUrl, isVolcBrandUser, maybeBrandVideoUrl, volcBrandHost, volcBrandKey } from '../volc-brand';

const HOST = 'ark-acg-cn-beijing.tos-cn-beijing.volces.com.silkroadai.io';
const USER = 'user-abc';
const TASK = 'cgt-20260812-xyz';
const UPSTREAM = 'https://x.volcvideo.com/real/low.mp4?sig=1';

const origFetch = globalThis.fetch;
beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SEEDANCE_VOLC_BRAND_HOST;
    delete process.env.SEEDANCE_VOLC_BRAND_USER_IDS;
});
afterEach(() => {
    globalThis.fetch = origFetch;
});

describe('env 双开关 / inert 默认', () => {
    it('host 未设 → volcBrandHost null,maybeBrand 返 null(不查库不下载)', async () => {
        const r = await maybeBrandVideoUrl({ userId: USER, taskId: TASK, upstreamUrl: UPSTREAM });
        expect(volcBrandHost()).toBeNull();
        expect(r).toBeNull();
        expect(objectExists).not.toHaveBeenCalled();
    });

    it('host 设了但客户不在白名单 → null', async () => {
        process.env.SEEDANCE_VOLC_BRAND_HOST = HOST;
        process.env.SEEDANCE_VOLC_BRAND_USER_IDS = 'someone-else,other';
        expect(isVolcBrandUser(USER)).toBe(false);
        expect(await maybeBrandVideoUrl({ userId: USER, taskId: TASK, upstreamUrl: UPSTREAM })).toBeNull();
        expect(objectExists).not.toHaveBeenCalled();
    });

    it('host + 白名单命中 → isVolcBrandUser true;host 前缀协议/斜杠归一', () => {
        process.env.SEEDANCE_VOLC_BRAND_HOST = `https://${HOST}/`;
        process.env.SEEDANCE_VOLC_BRAND_USER_IDS = `foo, ${USER} ,bar`;
        expect(volcBrandHost()).toBe(HOST);
        expect(isVolcBrandUser(USER)).toBe(true);
    });
});

describe('maybeBrandVideoUrl 转存 + 幂等 + 回退', () => {
    beforeEach(() => {
        process.env.SEEDANCE_VOLC_BRAND_HOST = HOST;
        process.env.SEEDANCE_VOLC_BRAND_USER_IDS = USER;
    });

    it('对象已存在 → 跳过下载/上传,直接返火山形 URL', async () => {
        objectExists.mockResolvedValue(true);
        const url = await maybeBrandVideoUrl({ userId: USER, taskId: TASK, upstreamUrl: UPSTREAM });
        expect(uploadImage).not.toHaveBeenCalled();
        expect(url).toBe(buildBrandedVolcUrl(HOST, TASK));
        expect(url).toContain(`https://${HOST}/doubao-seedance-2-0/${TASK}.mp4?`);
        expect(url).toContain('X-Tos-Algorithm=TOS4-HMAC-SHA256');
    });

    it('对象不存在 → 下载上游 + 上传 R2(key 确定性)+ 返火山形 URL', async () => {
        objectExists.mockResolvedValue(false);
        uploadImage.mockResolvedValue('https://images.silkroadai.io/' + volcBrandKey(TASK));
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            headers: new Headers({ 'content-length': '1510480', 'content-type': 'video/mp4' }),
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }) as unknown as typeof fetch;
        const url = await maybeBrandVideoUrl({ userId: USER, taskId: TASK, upstreamUrl: UPSTREAM });
        expect(globalThis.fetch).toHaveBeenCalledWith(
            UPSTREAM,
            expect.objectContaining({ headers: expect.any(Object) }),
        );
        expect(uploadImage).toHaveBeenCalledWith(volcBrandKey(TASK), expect.any(Buffer), 'video/mp4');
        expect(url).toBe(buildBrandedVolcUrl(HOST, TASK));
    });

    it('上游下载失败(非 2xx)→ null 回退(不上传)', async () => {
        objectExists.mockResolvedValue(false);
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, headers: new Headers() }) as unknown as typeof fetch;
        expect(await maybeBrandVideoUrl({ userId: USER, taskId: TASK, upstreamUrl: UPSTREAM })).toBeNull();
        expect(uploadImage).not.toHaveBeenCalled();
    });

    it('>200MB → 不转存,null 回退', async () => {
        objectExists.mockResolvedValue(false);
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            headers: new Headers({ 'content-length': String(201 * 1024 * 1024) }),
            arrayBuffer: async () => new Uint8Array([1]).buffer,
        }) as unknown as typeof fetch;
        expect(await maybeBrandVideoUrl({ userId: USER, taskId: TASK, upstreamUrl: UPSTREAM })).toBeNull();
        expect(uploadImage).not.toHaveBeenCalled();
    });

    it('fetch 抛异常 → null 回退(不断流)', async () => {
        objectExists.mockResolvedValue(false);
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as unknown as typeof fetch;
        expect(await maybeBrandVideoUrl({ userId: USER, taskId: TASK, upstreamUrl: UPSTREAM })).toBeNull();
    });
});
