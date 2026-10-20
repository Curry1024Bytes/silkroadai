import { describe, it, expect, beforeEach } from 'vitest';
import {
    placeholderSpecFromRequest,
    placeholderKey,
    getStreamPlaceholderB64,
    warmStreamPlaceholders,
    WARM_SIZES,
    _placeholderCacheSize,
    _resetPlaceholderCache,
} from '@/lib/image/stream-placeholder';

async function meta(b64: string) {
    const sharp = (await import('sharp')).default;
    const m = await sharp(Buffer.from(b64, 'base64')).metadata();
    return { w: m.width, h: m.height, format: m.format, alpha: m.hasAlpha };
}

describe('stream-placeholder:规格推导', () => {
    it('WxH / 格式 / 透明 按请求字段;auto / 空 / 非法 → 1024²;jpeg 不认透明;超界钳位', () => {
        expect(placeholderSpecFromRequest('1536x1024', 'png', '')).toEqual({
            w: 1536,
            h: 1024,
            format: 'png',
            transparent: false,
        });
        expect(placeholderSpecFromRequest('auto', 'webp', 'transparent')).toEqual({
            w: 1024,
            h: 1024,
            format: 'webp',
            transparent: true,
        });
        expect(placeholderSpecFromRequest('', 'JPG', 'transparent')).toEqual({
            w: 1024,
            h: 1024,
            format: 'jpeg',
            transparent: false,
        });
        expect(placeholderSpecFromRequest('16:9', undefined, undefined)).toEqual({
            w: 1024,
            h: 1024,
            format: 'png',
            transparent: false,
        });
        expect(placeholderSpecFromRequest('8000x8', '', '')).toEqual({
            w: 3840,
            h: 16,
            format: 'png',
            transparent: false,
        });
        expect(placeholderKey({ w: 1, h: 2, format: 'webp', transparent: true })).toBe('1x2:webp:a');
    });
});

describe('stream-placeholder:生成 + 缓存', () => {
    beforeEach(() => _resetPlaceholderCache());

    it('png 不透明:像素 = 请求尺寸,无 alpha;同规格第二次命中同一 promise;体积小(4K < 200KB)', async () => {
        const a = await getStreamPlaceholderB64({ w: 3840, h: 2160, format: 'png', transparent: false });
        expect(a).toBeTruthy();
        expect(await meta(a!)).toEqual({ w: 3840, h: 2160, format: 'png', alpha: false });
        expect(Buffer.from(a!, 'base64').length).toBeLessThan(200 * 1024);
        const p1 = getStreamPlaceholderB64({ w: 3840, h: 2160, format: 'png', transparent: false });
        const p2 = getStreamPlaceholderB64({ w: 3840, h: 2160, format: 'png', transparent: false });
        expect(p1).toBe(p2);
        expect(_placeholderCacheSize()).toBe(1);
    });

    it('透明 png 真带 alpha;jpeg / webp 真交付对应格式', async () => {
        const t = await getStreamPlaceholderB64({ w: 512, h: 512, format: 'png', transparent: true });
        expect(await meta(t!)).toEqual({ w: 512, h: 512, format: 'png', alpha: true });
        const j = await getStreamPlaceholderB64({ w: 512, h: 256, format: 'jpeg', transparent: false });
        expect((await meta(j!)).format).toBe('jpeg');
        const wp = await getStreamPlaceholderB64({ w: 256, h: 512, format: 'webp', transparent: true });
        expect(await meta(wp!)).toMatchObject({ w: 256, h: 512, format: 'webp', alpha: true });
        expect(_placeholderCacheSize()).toBe(3);
    });

    it('预热:常用尺寸 + 透明 1024² 进缓存,重复调用不重复做', async () => {
        warmStreamPlaceholders();
        warmStreamPlaceholders();
        expect(_placeholderCacheSize()).toBe(WARM_SIZES.length + 1);
        await Promise.all(
            WARM_SIZES.map(([w, h]) => getStreamPlaceholderB64({ w, h, format: 'png', transparent: false })),
        );
        expect(_placeholderCacheSize()).toBe(WARM_SIZES.length + 1);
    });
});
