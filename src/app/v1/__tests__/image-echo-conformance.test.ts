/**
 * gpt-image 响应回显官方枚举一致性(客户 2026-08-27 反馈:auto/standard 非官方标准,
 * 应归一成 low;output_format 回显应与实际字节一致)。
 */
import { describe, it, expect } from 'vitest';
import {
    normalizeEchoQuality,
    normalizeEchoBackground,
    normalizeEchoOutputFormat,
    sniffImageFormat,
} from '../[...path]/route';

describe('normalizeEchoQuality — 官方枚举 low/medium/high,auto/standard→low', () => {
    it.each([
        ['auto', 'low'],
        ['AUTO', 'low'],
        ['standard', 'low'],
        ['', 'low'],
        ['hd', 'low'],
        ['未知值', 'low'],
        ['low', 'low'],
        ['medium', 'medium'],
        ['high', 'high'],
        ['  High  ', 'high'],
    ])('gpt-image 模型:%s → %s', (input, expected) => {
        expect(normalizeEchoQuality(input, true)).toBe(expected);
    });
    it('非 gpt-image 模型缺省不回显', () => {
        expect(normalizeEchoQuality('auto', false)).toBe('');
        expect(normalizeEchoQuality('', false)).toBe('');
        expect(normalizeEchoQuality('high', false)).toBe('high'); // 有效值仍回显
    });
});

describe('normalizeEchoBackground — opaque/transparent,非法不回显', () => {
    it.each([
        ['transparent', 'transparent'],
        ['opaque', 'opaque'],
        ['auto', 'opaque'],
        ['', 'opaque'],
        ['weird', ''], // 非法值不鹦鹉学舌
    ])('gpt-image:%s → %s', (input, expected) => {
        expect(normalizeEchoBackground(input, true)).toBe(expected);
    });
});

describe('normalizeEchoOutputFormat — png/jpeg/webp,jpg→jpeg', () => {
    it.each([
        ['png', 'png'],
        ['jpeg', 'jpeg'],
        ['jpg', 'jpeg'],
        ['webp', 'webp'],
        ['', 'png'],
        ['gif', 'png'],
    ])('gpt-image:%s → %s', (input, expected) => {
        expect(normalizeEchoOutputFormat(input, true)).toBe(expected);
    });
});

describe('sniffImageFormat — 按返回图实际首字节判定(消解请求/字节不符)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64');
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]).toString('base64');
    const webp = Buffer.concat([
        Buffer.from('RIFF', 'latin1'),
        Buffer.from([0, 0, 0, 0]),
        Buffer.from('WEBP', 'latin1'),
    ]).toString('base64');
    it('PNG 字节 → png(即便请求声称 webp)', () => {
        expect(sniffImageFormat([{ b64_json: png }])).toBe('png');
    });
    it('JPEG 字节 → jpeg', () => {
        expect(sniffImageFormat([{ b64_json: jpeg }])).toBe('jpeg');
    });
    it('WebP 字节 → webp', () => {
        expect(sniffImageFormat([{ b64_json: webp }])).toBe('webp');
    });
    it('URL 模式(无 b64_json)→ 空,退回请求侧归一', () => {
        expect(sniffImageFormat([{ url: 'https://x/y.png' }])).toBe('');
        expect(sniffImageFormat([])).toBe('');
    });
});
