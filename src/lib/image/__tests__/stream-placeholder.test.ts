import { describe, it, expect, beforeEach } from 'vitest';
import { inspectApng } from '@/lib/image/apng';
import {
    PLACEHOLDER_FRAMES,
    placeholderRegion,
    placeholderSpecFromRequest,
    placeholderKey,
    getStreamPlaceholderB64,
    warmStreamPlaceholders,
    WARM_SIZES,
    _placeholderCacheSize,
    _resetPlaceholderCache,
    _placeholderResourceStats,
    PLACEHOLDER_MAX_RAW_BYTES,
} from '@/lib/image/stream-placeholder';

async function meta(b64: string) {
    const sharp = (await import('sharp')).default;
    const m = await sharp(Buffer.from(b64, 'base64'), { animated: true }).metadata();
    return { w: m.width, h: m.pageHeight ?? m.height, format: m.format, alpha: m.hasAlpha, pages: m.pages ?? 1 };
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

    it('png 不透明:APNG 12 帧,首帧整幅 = 请求尺寸,后续帧只盖转圈子矩形;同规格第二次命中同一 promise;4K < 300KB', async () => {
        const a = await getStreamPlaceholderB64({ w: 3840, h: 2160, format: 'png', transparent: false });
        expect(a).toBeTruthy();
        const buf = Buffer.from(a!, 'base64');
        expect(await meta(a!)).toMatchObject({ w: 3840, h: 2160, format: 'png' });
        const ap = inspectApng(buf)!;
        expect(ap.frames).toBe(PLACEHOLDER_FRAMES);
        expect(ap.loops).toBe(0);
        expect(ap.fctl).toHaveLength(PLACEHOLDER_FRAMES);
        expect(ap.fctl[0]).toMatchObject({ w: 3840, h: 2160, x: 0, y: 0, delayMs: 80 });
        const region = placeholderRegion(3840, 2160);
        for (const f of ap.fctl.slice(1))
            expect(f).toMatchObject({ w: region.width, h: region.height, x: region.left, y: region.top });
        expect(region.width * region.height).toBeLessThan(3840 * 2160 * 0.05);
        expect(buf.length).toBeLessThan(300 * 1024);
        const p1 = getStreamPlaceholderB64({ w: 3840, h: 2160, format: 'png', transparent: false });
        const p2 = getStreamPlaceholderB64({ w: 3840, h: 2160, format: 'png', transparent: false });
        expect(p1).toBe(p2);
        expect(_placeholderCacheSize()).toBe(1);
    });

    it('透明 png 真带 alpha 且仍是 APNG;jpeg 静态;webp 是 12 页动图且带 alpha;>2.5MP 的 webp 退回静态', async () => {
        const t = await getStreamPlaceholderB64({ w: 512, h: 512, format: 'png', transparent: true });
        expect(await meta(t!)).toMatchObject({ w: 512, h: 512, format: 'png', alpha: true });
        expect(inspectApng(Buffer.from(t!, 'base64'))!.frames).toBe(PLACEHOLDER_FRAMES);
        const j = await getStreamPlaceholderB64({ w: 512, h: 256, format: 'jpeg', transparent: false });
        expect((await meta(j!)).format).toBe('jpeg');
        const wp = await getStreamPlaceholderB64({ w: 256, h: 512, format: 'webp', transparent: true });
        expect(await meta(wp!)).toMatchObject({
            w: 256,
            h: 512,
            format: 'webp',
            alpha: true,
            pages: PLACEHOLDER_FRAMES,
        });
        const big = await getStreamPlaceholderB64({ w: 3840, h: 2160, format: 'webp', transparent: false });
        expect(await meta(big!)).toMatchObject({ w: 3840, h: 2160, format: 'webp', pages: 1 });
        expect(_placeholderCacheSize()).toBe(4);
    });

    it('预热:常用尺寸 + 透明 1024² 进缓存,重复调用不重复做', async () => {
        const first = warmStreamPlaceholders();
        expect(warmStreamPlaceholders()).toBe(first);
        expect(_placeholderResourceStats().active).toBeLessThanOrEqual(1);
        await first;
        await Promise.all(
            WARM_SIZES.map(([w, h]) => getStreamPlaceholderB64({ w, h, format: 'png', transparent: false })),
        );
        expect(_placeholderCacheSize()).toBe(WARM_SIZES.length + 1);
    });
    it('WebP raw animation exceeding the working buffer budget falls back to a real static frame', async () => {
        expect(1536 * 1024 * 4 * (PLACEHOLDER_FRAMES + 1)).toBeGreaterThan(PLACEHOLDER_MAX_RAW_BYTES);
        const image = await getStreamPlaceholderB64({ w: 1536, h: 1024, format: 'webp', transparent: true });
        expect(await meta(image!)).toMatchObject({ w: 1536, h: 1024, format: 'webp', alpha: true, pages: 1 });
    });
});
