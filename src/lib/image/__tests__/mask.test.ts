import { describe, expect, it } from 'vitest';
import { jsonMaskShapeError, maskDimensionError, multipartMaskShapeError } from '../mask';

describe('jsonMaskShapeError(2026-11-02 客户:非法 mask 一律 200 出图)', () => {
    it.each([undefined, null, '', 'data:image/png;base64,AAAA', 'https://x.test/m.png'])(
        '未传 / 字符串扩展 %s → 合法',
        (v) => {
            expect(jsonMaskShapeError(v)).toBeNull();
        },
    );

    it.each([
        { image_url: 'data:image/png;base64,AAAA' },
        { file_id: 'file-abc' },
        { image_url: { url: 'https://x.test/m.png' } }, // chat 风格兼容
        { url: 'https://x.test/m.png' }, // 自家扩展
    ])('官方 / 兼容对象形 %j → 合法', (v) => {
        expect(jsonMaskShapeError(v)).toBeNull();
    });

    it('mask: {} → 400 恰好一个', () => {
        expect(jsonMaskShapeError({})).toEqual({
            message: "Invalid 'mask': provide exactly one of image_url or file_id.",
            code: 'invalid_value',
        });
    });

    it('image_url + file_id 同时给 → 400 恰好一个', () => {
        expect(jsonMaskShapeError({ image_url: 'a', file_id: 'b' })?.code).toBe('invalid_value');
    });

    it('数字 file_id → 官方类型错文案', () => {
        expect(jsonMaskShapeError({ file_id: 123 })).toEqual({
            message: "Invalid type for 'mask.file_id': expected a string, but got an integer instead.",
            code: 'invalid_type',
        });
    });

    it('image_url 非字符串 / 空串 → 400', () => {
        expect(jsonMaskShapeError({ image_url: 42 })?.message).toBe(
            "Invalid type for 'mask.image_url': expected a string, but got an integer instead.",
        );
        expect(jsonMaskShapeError({ image_url: '  ' })?.message).toBe(
            "Invalid 'mask.image_url': expected a non-empty string.",
        );
        expect(jsonMaskShapeError({ image_url: { url: 1 } })?.code).toBe('invalid_type');
    });

    it('数组 / 数字 / 布尔 → 期望对象', () => {
        expect(jsonMaskShapeError([{ image_url: 'a' }])?.message).toContain('but got an array instead');
        expect(jsonMaskShapeError(1)?.message).toContain("Invalid type for 'mask': expected an object");
        expect(jsonMaskShapeError(true)?.code).toBe('invalid_type');
    });
});

describe('multipartMaskShapeError', () => {
    it('未传 / 空字段 / 非空文件 → 合法', () => {
        expect(multipartMaskShapeError(null)).toBeNull();
        expect(multipartMaskShapeError('')).toBeNull();
        expect(multipartMaskShapeError(new File([new Uint8Array([1])], 'm.png'))).toBeNull();
    });
    it('文本字段 → 期望文件;空文件 → 400', () => {
        expect(multipartMaskShapeError('{"file_id":1}')?.message).toBe(
            "Invalid type for 'mask': expected a file, but got a string instead.",
        );
        expect(multipartMaskShapeError(new File([], 'm.png'))?.message).toBe("Invalid 'mask': file is empty.");
    });
});

describe('maskDimensionError', () => {
    it('尺寸一致 / 任一读不出 → 不判', () => {
        expect(maskDimensionError({ w: 1024, h: 1024 }, { w: 1024, h: 1024 })).toBeNull();
        expect(maskDimensionError(null, { w: 1024, h: 1024 })).toBeNull();
        expect(maskDimensionError({ w: 512, h: 512 }, null)).toBeNull();
    });
    it('不一致 → 400 文案带两边尺寸', () => {
        expect(maskDimensionError({ w: 512, h: 512 }, { w: 1024, h: 1536 })).toBe(
            'Invalid mask image: mask must have the same dimensions as the image (1024x1536), got 512x512.',
        );
    });
});
