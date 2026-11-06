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
    gptImage26SvgError,
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
    it('gpt-image-2.6:走 5 档枚举,xhigh / max 回显请求档(适配器用 high 出图)', () => {
        expect(normalizeEchoQuality('xhigh', true, true)).toBe('xhigh');
        expect(normalizeEchoQuality('MAX', true, true)).toBe('max');
        expect(normalizeEchoQuality('medium', true, true)).toBe('medium');
        expect(normalizeEchoQuality('auto', true, true)).toBe('low');
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
        ['gif', 'gif'],
        ['', 'png'],
        ['bmp', 'png'],
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
    it('GIF 字节 → gif', () => {
        expect(sniffImageFormat([{ b64_json: Buffer.from('GIF89a').toString('base64') }])).toBe('gif');
    });
    it('URL 模式(无 b64_json)→ 空,退回请求侧归一', () => {
        expect(sniffImageFormat([{ url: 'https://x/y.png' }])).toBe('');
        expect(sniffImageFormat([])).toBe('');
    });
});

describe('normalizeEchoQuality — gpt-image-2.5 tier5 门控(xhigh/max 只对 2.5 放行)', () => {
    it.each([
        ['xhigh', true, 'xhigh'],
        ['max', true, 'max'],
        ['MAX', true, 'max'],
        ['xhigh', false, 'low'], // 2.0 不认 → 归一 low(与 2.0 适配器计费口径一致)
        ['max', false, 'low'],
        ['auto', true, 'low'], // 2.5 的 auto 同样归一 low(上游按 196 计)
        ['high', true, 'high'],
    ])('%s tier5=%s → %s', (input, tier5, expected) => {
        expect(normalizeEchoQuality(input, true, tier5)).toBe(expected);
    });
});

describe('2.6 SVG 回显与校验', () => {
    const svgB64 = (text: string) => Buffer.from(text).toString('base64');

    it.each([
        ['<svg viewBox="0 0 8 8" xmlns="http://www.w3.org/2000/svg"></svg>'],
        ['<?xml version="1.0" encoding="UTF-8"?>\n<svg width="8"></svg>'],
        ['<!-- made by a model -->\n<svg></svg>'],
        ['﻿  <svg>\n</svg>'],
    ])('sniffImageFormat 认出 SVG 文本:%s', (text) => {
        expect(sniffImageFormat([{ b64_json: svgB64(text) }])).toBe('svg');
    });

    it('普通 XML 和 HTML 不算 SVG', () => {
        expect(sniffImageFormat([{ b64_json: svgB64('<?xml version="1.0"?><note/>') }])).toBe('');
        expect(sniffImageFormat([{ b64_json: svgB64('<html><svg></svg></html>') }])).toBe('');
    });

    it('读不到字节时按请求回显 svg', () => {
        expect(normalizeEchoOutputFormat('svg', true)).toBe('svg');
    });

    const ok = { svg: { model: 'gpt-5.5' }, n: undefined, stream: false, outputCompression: undefined };

    it('合法入参通过', () => {
        expect(gptImage26SvgError(ok)).toBeNull();
        expect(gptImage26SvgError({ ...ok, n: 1 })).toBeNull();
        expect(gptImage26SvgError({ ...ok, n: '1' })).toBeNull();
    });

    it.each([
        [{ ...ok, svg: undefined }, 'svg.model', 'missing_required_parameter'],
        [{ ...ok, svg: {} }, 'svg.model', 'missing_required_parameter'],
        [{ ...ok, svg: { model: '  ' } }, 'svg.model', 'missing_required_parameter'],
        [{ ...ok, svg: 'gpt-5.5' }, 'svg', 'invalid_type'],
        [{ ...ok, n: 2 }, 'n', 'invalid_value'],
        [{ ...ok, stream: true }, 'stream', 'invalid_value'],
        [{ ...ok, outputCompression: 50 }, 'output_compression', 'invalid_value'],
    ])('非法入参 400:%#', (params, param, code) => {
        expect(gptImage26SvgError(params)).toMatchObject({ param, code });
    });
});
