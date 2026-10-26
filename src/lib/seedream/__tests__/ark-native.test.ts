import { describe, it, expect, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { handleArkSeedreamImages, isArkImagesPath, resolveArkSeedreamModel, type V1ImagesHandler } from '../ark-native';

function req(body: unknown, search = ''): NextRequest {
    return new NextRequest(`https://ai.silkroadai.io/api/v3/images/generations${search}`, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-cust', 'content-type': 'application/json', 'content-length': '999' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

describe('seedream 方舟原生路径', () => {
    it('isArkImagesPath:只认 POST /images/generations(容忍尾斜杠)', () => {
        expect(isArkImagesPath('POST', '/images/generations')).toBe(true);
        expect(isArkImagesPath('POST', '/images/generations/')).toBe(true);
        expect(isArkImagesPath('GET', '/images/generations')).toBe(false);
        expect(isArkImagesPath('POST', '/contents/generations/tasks')).toBe(false);
    });

    it('官方模型 ID / 对客名 → 规范名,大小写宽容;其余 null', () => {
        expect(resolveArkSeedreamModel('doubao-seedream-5-0-pro-260628')).toBe('seedream-5-0-pro');
        expect(resolveArkSeedreamModel('dola-seedream-5-0-pro-260628-ep')).toBe('seedream-5-0-pro');
        expect(resolveArkSeedreamModel(' Seedream-5-0-Pro ')).toBe('seedream-5-0-pro');
        expect(resolveArkSeedreamModel('doubao-seedream-5-0-flash-260915')).toBe('seedream-5-0-flash');
        expect(resolveArkSeedreamModel('dola-seedream-5-0-flash-260915')).toBe('seedream-5-0-flash');
        expect(resolveArkSeedreamModel('seedream-4-5-251128')).toBeNull();
        expect(resolveArkSeedreamModel(undefined)).toBeNull();
    });

    it('未知模型 → 404 不转发;stream=true → 400 不转发;坏 JSON → 400', async () => {
        const v1 = vi.fn();
        const r1 = await handleArkSeedreamImages(req({ model: 'gpt-image-2', prompt: 'x' }), v1);
        expect(r1.status).toBe(404);
        expect(((await r1.json()) as { error: { param: string } }).error.param).toBe('model');
        const r2 = await handleArkSeedreamImages(req({ model: 'seedream-5-0-flash', prompt: 'x', stream: true }), v1);
        expect(r2.status).toBe(400);
        expect((await handleArkSeedreamImages(req('{bad'), v1)).status).toBe(400);
        expect(v1).not.toHaveBeenCalled();
    });

    it('转发到 /v1/images/generations:model 换规范名、其余字段原样、鉴权头保留;回程 model 回显客户传入名', async () => {
        const v1 = vi.fn<V1ImagesHandler>(async () =>
            NextResponse.json(
                {
                    created: 1,
                    model: 'seedream-5-0-pro',
                    data: [{ url: 'https://images.silkroadai.io/gen/x', size: '2048x2048' }],
                    usage: { output_tokens: 153000, total_tokens: 153000, generated_images: 1 },
                },
                { headers: { 'x-silkroadai-test': '1' } },
            ),
        );
        const res = await handleArkSeedreamImages(
            req(
                {
                    model: 'doubao-seedream-5-0-pro-260628',
                    prompt: 'apple',
                    image: ['https://e.com/a.png'],
                    size: '2K',
                    watermark: false,
                    sequential_image_generation: 'disabled',
                    stream: false,
                },
                '?strict=1',
            ),
            v1,
        );
        expect(res.status).toBe(200);
        const fwd = v1.mock.calls[0][0];
        expect(fwd.nextUrl.pathname).toBe('/v1/images/generations');
        expect(fwd.nextUrl.search).toBe('?strict=1');
        expect(fwd.headers.get('authorization')).toBe('Bearer sk-cust');
        expect(fwd.headers.get('content-length')).not.toBe('999');
        const sent = (await fwd.json()) as Record<string, unknown>;
        expect(sent).toEqual({
            model: 'seedream-5-0-pro',
            prompt: 'apple',
            image: ['https://e.com/a.png'],
            size: '2K',
            watermark: false,
            sequential_image_generation: 'disabled',
        });
        const j = (await res.json()) as { model: string; data: unknown[]; usage: Record<string, number> };
        expect(j.model).toBe('doubao-seedream-5-0-pro-260628');
        expect(j.data).toHaveLength(1);
        expect(j.usage.total_tokens).toBe(153000);
        expect(res.headers.get('x-silkroadai-test')).toBe('1');
    });

    it('上游错误原样返回(状态码 + 体不改写)', async () => {
        const v1 = vi.fn(async () =>
            NextResponse.json({ error: { code: 'insufficient_user_quota', message: 'no quota' } }, { status: 403 }),
        );
        const res = await handleArkSeedreamImages(req({ model: 'seedream-5-0-flash', prompt: 'x' }), v1);
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('insufficient_user_quota');
    });
});
