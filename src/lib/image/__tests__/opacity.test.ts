import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { hasTransparentPixels, resolveOutputBackground } from '../opacity';

/** w×h 图,上 transparentRows 行 alpha=0,其余不透明。 */
async function rgbaPng(w: number, h: number, transparentRows: number): Promise<Buffer> {
    const raw = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            raw[i] = 70;
            raw[i + 1] = 130;
            raw[i + 2] = 180;
            raw[i + 3] = y < transparentRows ? 0 : 255;
        }
    return sharp(raw, { raw: { width: w, height: h, channels: 4 } })
        .png()
        .toBuffer();
}

const rgbPng = () =>
    sharp({ create: { width: 30, height: 30, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .png()
        .toBuffer();

describe('hasTransparentPixels', () => {
    it('RGB PNG / JPEG → false(快路不解码)', async () => {
        expect(await hasTransparentPixels(await rgbPng())).toBe(false);
        const jpeg = await sharp(await rgbPng())
            .jpeg()
            .toBuffer();
        expect(await hasTransparentPixels(jpeg)).toBe(false);
    });
    it('RGBA PNG 全不透明 → false;1/3 透明 → true', async () => {
        expect(await hasTransparentPixels(await rgbaPng(30, 30, 0))).toBe(false);
        expect(await hasTransparentPixels(await rgbaPng(30, 30, 10))).toBe(true);
    });
    it('透明 WebP → true;读不出 → null', async () => {
        const webp = await sharp(await rgbaPng(30, 30, 10))
            .webp({ lossless: true })
            .toBuffer();
        expect(await hasTransparentPixels(webp)).toBe(true);
        expect(await hasTransparentPixels(Buffer.from('not an image'))).toBeNull();
    });
});

describe('resolveOutputBackground(2026-11-02 客户:声明 opaque、PNG 却 1/3 透明)', () => {
    it('请求 opaque + 图带透明 → 白底压平,回显 opaque', async () => {
        const src = (await rgbaPng(30, 30, 10)).toString('base64');
        const r = await resolveOutputBackground(src, 'opaque');
        expect(r.background).toBe('opaque');
        expect(r.b64).not.toBe(src);
        const out = Buffer.from(r.b64, 'base64');
        expect(await hasTransparentPixels(out)).toBe(false);
        const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
        expect([data[0], data[1], data[2]]).toEqual([255, 255, 255]); // 原透明区 → 白
    });
    it('请求 auto / 缺省 + 图带透明 → 原图不动,如实回显 transparent', async () => {
        const src = (await rgbaPng(30, 30, 10)).toString('base64');
        for (const want of ['', 'auto', 'AUTO']) {
            expect(await resolveOutputBackground(src, want)).toEqual({ b64: src, background: 'transparent' });
        }
    });
    it('不透明图 → 原图 + opaque;请求 transparent → 原样 transparent', async () => {
        const opaque = (await rgbPng()).toString('base64');
        expect(await resolveOutputBackground(opaque, 'opaque')).toEqual({ b64: opaque, background: 'opaque' });
        expect(await resolveOutputBackground(opaque, '')).toEqual({ b64: opaque, background: 'opaque' });
        expect(await resolveOutputBackground(opaque, 'transparent')).toEqual({
            b64: opaque,
            background: 'transparent',
        });
    });
});
