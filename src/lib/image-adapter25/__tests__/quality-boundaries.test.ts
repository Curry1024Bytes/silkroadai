import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { handleAdapter25Image, type ImageMode } from '../adapter';
import { handleAdapter25Request } from '../entrypoint';

const fetchMock = vi.fn();
beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

function request(mode: ImageMode, format: 'json' | 'multipart') {
    const url = `http://portal.test/image-adapter25/wetokenasia25/v1/images/${mode}`;
    const fields = { model: 'gpt-image-2.5-flare', prompt: 'fixture', quality: ' ULTRA ', size: '1024x1024' };
    if (format === 'json') {
        const jsonFields =
            mode === 'edits'
                ? {
                      ...fields,
                      images: [{ image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }],
                  }
                : fields;
        return new NextRequest(url, {
            method: 'POST',
            headers: { authorization: 'Bearer fixture-only', 'content-type': 'application/json' },
            body: JSON.stringify(jsonFields),
        });
    }
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    if (mode === 'edits') form.set('image', new Blob(['fixture'], { type: 'image/png' }), 'fixture.png');
    return new NextRequest(url, { method: 'POST', headers: { authorization: 'Bearer fixture-only' }, body: form });
}

describe('Image 2.5 参数拒绝与生产开关边界', () => {
    it.each([
        ['generations', 'json'],
        ['generations', 'multipart'],
        ['edits', 'json'],
        ['edits', 'multipart'],
    ] as const)('%s / %s 的非法 quality 均在外部调用前返回 400', async (mode, format) => {
        const res = await handleAdapter25Image(request(mode, format), mode, 'wetokenasia25');
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: { code: 'invalid_request', param: 'quality' } });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('功能关闭时仍由开关先返回 503，不解析请求或调用外部服务', async () => {
        vi.stubEnv('PORTAL_IMAGE_ADAPTER25_ENABLED', 'false');
        const req = request('generations', 'json');
        const read = vi.spyOn(req, 'json');
        const res = await handleAdapter25Request(req, 'generations', 'wetokenasia25');
        expect(res.status).toBe(503);
        expect(read).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
