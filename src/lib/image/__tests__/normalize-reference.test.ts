/**
 * 参考图格式归一(2026-10-09,智象未来 conformance 报告 A12-FMT-BMP / A12-FMT-HEIF)。
 * fixture 全部由 ImageMagick / sips 真实生成(6×4 red→blue 垂直渐变),像素真值取自
 * `magick x.bmp -depth 8 rgb:-`:首像素 (255,0,0)、末像素 (0,0,255)。
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
    bmpToPng,
    decodeBmp,
    isBmp,
    normalizeHeifBrand,
    normalizeReferenceImage,
    readFtyp,
} from '../normalize-reference';

const b64 = (s: string) => Buffer.from(s, 'base64');

// `magick -size 6x4 gradient:red-blue -depth 8 BMP3:g24.bmp` → 40 字节头、24-bit、BI_RGB、自底向上。
// ImageMagick identify 给的名字就是 `BMP3` —— 上游拒收的那一族。
const BMP3_24 = b64(
    'Qk2GAAAAAAAAADYAAAAoAAAABgAAAAQAAAABABgAAAAAAFAAAAAAAAAAAAAAAAAAAAAAAAAA/wAA/wAA/wAA/wAA/wAA/wAAAACqAFWqAFWqAFWqAFWqAFWqAFUAAFUAqlUAqlUAqlUAqlUAqlUAqgAAAAD/AAD/AAD/AAD/AAD/AAD/AAA=',
);
// `… -type palette -colors 8 BMP3:` → 4-bit 调色板。
const BMP3_PAL4 = b64(
    'Qk2GAAAAAAAAAHYAAAAoAAAABgAAAAQAAAABAAQAAAAAABAAAAAAAAAAAAAAABAAAAAQAAAAAAD/AFUAqgCqAFUA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADMzMwAiIiIAERERAAAAAAA=',
);
// `… -alpha set -channel A -evaluate set 50% BMP:` → 124 字节 V5 头、32-bit、BI_BITFIELDS、带 alpha 掩码。
const BMP5_32A = b64(
    'Qk3qAAAAAAAAAIoAAAB8AAAABgAAAAQAAAABACAAAwAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAD/AAD/AAAAAAAA/0JHUnOPwvUoUbgeFR6F6wEzMzMTZmZmJmZmZgaZmZkJPQrXAyhcjzIAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAA/wAAgP8AAID/AACA/wAAgP8AAID/AACAqgBVgKoAVYCqAFWAqgBVgKoAVYCqAFWAVQCqgFUAqoBVAKqAVQCqgFUAqoBVAKqAAAD/gAAA/4AAAP+AAAD/gAAA/4AAAP+A',
);
// `… -compress RLE -type palette BMP3:` → RLE8(compression=1),故意不解。
const BMP3_RLE8 = b64(
    'Qk1OBAAAAAAAADYEAAAoAAAABgAAAAQAAAABAAgAAQAAABgAAAAAAAAAAAAAAAABAAAAAQAAAAD/AFUAqgCqAFUA/wAA' + 'A'.repeat(1300),
);
// sips 写的 heic(major_brand=heix)再把 8..12 改成字面 `heif` —— 报告 A12-FMT-HEIF 的 fixture 构造法。
const HEIF_BAD_BRAND = b64(
    'AAAAJGZ0eXBoZWlmAAAAAG1pZjFNaVByTWlIQW1pYWZoZWl4AAABem1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAANppcHJwAAAAumlwY28AAAATY29scm5jbHgAAgACAAaAAAAAFGlzcGUAAAAAAAAAQAAAAEAAAAAJaXJvdAAAAAAQcGl4aQAAAAADCgoKAAAAcmh2Y0MBAiAAAACwAAAAAAAe8AD8/fr6AAALA6AAAQAYQAEMAf//AiAAAAMAsAAAAwAAAwAeFwJAoQABACNCAQECIAAAAwCwAAADAAADAB6gFCBBwY7YgXuRZVNwICBgCKIAAQAJRAHAYJyyEBTJAAAAGGlwbWEAAAAAAAAAAQABBYECBIWDAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAAa4AAAAzAAAAAW1kYXQAAAAAAAAAQwAAAC8oAa+jQXfk+F/tnNv/+of9//NQp76dEUP82n+R+Hr//8brT2B79Flc1BBuxnav4A==',
);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function firstLast(d: Buffer, ch: number) {
    return { first: [...d.subarray(0, 3)], last: [...d.subarray(d.length - ch, d.length - ch + 3)] };
}

describe('decodeBmp(dep-free)', () => {
    it('40 字节头 24-bit(ImageMagick 叫 BMP3)→ RGB 自顶向下,像素与 magick 真值一致', () => {
        const d = decodeBmp(BMP3_24)!;
        expect(d).toMatchObject({ width: 6, height: 4, channels: 3 });
        expect(d.data.length).toBe(6 * 4 * 3);
        expect(firstLast(d.data, 3)).toEqual({ first: [255, 0, 0], last: [0, 0, 255] });
    });

    it('4-bit 调色板', () => {
        const d = decodeBmp(BMP3_PAL4)!;
        expect(d).toMatchObject({ width: 6, height: 4, channels: 3 });
        expect(firstLast(d.data, 3)).toEqual({ first: [255, 0, 0], last: [0, 0, 255] });
    });

    it('V5 头 32-bit BI_BITFIELDS 带 alpha 掩码 → RGBA,alpha 取掩码值', () => {
        const d = decodeBmp(BMP5_32A)!;
        expect(d).toMatchObject({ width: 6, height: 4, channels: 4 });
        expect(firstLast(d.data, 4)).toEqual({ first: [255, 0, 0], last: [0, 0, 255] });
        expect(d.data[3]).toBe(128); // -evaluate set 50%
    });

    it('自顶向下(负高)→ 行序不翻', () => {
        const td = Buffer.from(BMP3_24);
        td.writeInt32LE(-4, 22);
        const d = decodeBmp(td)!;
        expect(firstLast(d.data, 3)).toEqual({ first: [0, 0, 255], last: [255, 0, 0] });
    });

    it('RLE 压缩 / 像素越界 / 头部异常 / 巨幅尺寸 → null(不猜,交上游)', () => {
        expect(decodeBmp(BMP3_RLE8)).toBeNull();
        expect(decodeBmp(BMP3_24.subarray(0, 80))).toBeNull(); // 截断
        const bad = Buffer.from(BMP3_24);
        bad.writeUInt32LE(99, 14); // 非法 DIB 大小(99 > 文件剩余)
        expect(decodeBmp(bad)).toBeNull();
        const huge = Buffer.from(BMP3_24);
        huge.writeInt32LE(100_000, 18);
        expect(decodeBmp(huge)).toBeNull();
        expect(decodeBmp(Buffer.from('not a bmp at all'))).toBeNull();
        expect(isBmp(PNG_SIG)).toBe(false);
    });
});

describe('bmpToPng', () => {
    it('BMP3 → 真 PNG(sharp 可解,尺寸一致)', async () => {
        const r = await bmpToPng(BMP3_24);
        expect(r).not.toBeNull();
        expect(r!.png.subarray(0, 8).equals(PNG_SIG)).toBe(true);
        const meta = await sharp(r!.png).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual(['png', 6, 4]);
    });
    it('解不了的 → null', async () => {
        expect(await bmpToPng(BMP3_RLE8)).toBeNull();
    });
});

describe('HEIF ftyp 品牌', () => {
    it('readFtyp:major + compatible', () => {
        expect(readFtyp(HEIF_BAD_BRAND)).toEqual({
            major: 'heif',
            compatible: ['mif1', 'MiPr', 'MiHA', 'miaf', 'heix'],
        });
        expect(readFtyp(PNG_SIG)).toBeNull();
    });

    it('major_brand 未注册(字面 heif)但 compatible 含 heix → 回写 major=heix,mime image/heic,像素字节不动', () => {
        const r = normalizeHeifBrand(HEIF_BAD_BRAND)!;
        expect(r.rewritten).toBe('heix');
        expect(r.mime).toBe('image/heic');
        expect(r.buf.toString('latin1', 8, 12)).toBe('heix');
        expect(r.buf.subarray(12).equals(HEIF_BAD_BRAND.subarray(12))).toBe(true);
        expect(HEIF_BAD_BRAND.toString('latin1', 8, 12)).toBe('heif'); // 入参不被改
    });

    it('major 已是注册品牌 → 不改字节,只给出 mime', () => {
        const ok = Buffer.from(HEIF_BAD_BRAND);
        ok.write('heic', 8, 4, 'latin1');
        const r = normalizeHeifBrand(ok)!;
        expect(r.rewritten).toBeNull();
        expect(r.buf).toBe(ok);
        expect(r.mime).toBe('image/heic');
        ok.write('mif1', 8, 4, 'latin1');
        expect(normalizeHeifBrand(ok)!.mime).toBe('image/heif');
    });

    it('mp4 / mov 视频也是 ftyp 开头,但不含 HEIF 品牌 → null(不碰)', () => {
        const mp4 = Buffer.concat([
            Buffer.from([0, 0, 0, 0x18]),
            Buffer.from('ftypisom', 'latin1'),
            Buffer.alloc(4),
            Buffer.from('isommp42', 'latin1'),
            Buffer.alloc(64),
        ]);
        expect(normalizeHeifBrand(mp4)).toBeNull();
    });
});

describe('normalizeReferenceImage(入口,永不抛)', () => {
    it('bmp 字节(不管自报 mime)→ png + image/png', async () => {
        const n = await normalizeReferenceImage(BMP3_24, 'image/bmp');
        expect(n.changed).toBe('bmp->png');
        expect(n.mime).toBe('image/png');
        expect(n.buf.subarray(0, 8).equals(PNG_SIG)).toBe(true);
        // 客户把 bmp 标成 image/png 也按字节识别
        expect((await normalizeReferenceImage(BMP3_24, 'image/png')).changed).toBe('bmp->png');
    });

    it('heif 坏品牌 → 改头 + image/heic', async () => {
        const n = await normalizeReferenceImage(HEIF_BAD_BRAND, 'image/heif');
        expect(n.changed).toBe('heif-brand');
        expect(n.mime).toBe('image/heic');
        expect(n.buf.toString('latin1', 8, 12)).toBe('heix');
    });

    it('png / 解不了的 bmp / 垃圾字节 → 原样返回,mime 原样', async () => {
        const png = await normalizeReferenceImage(PNG_SIG, 'image/png');
        expect(png).toEqual({ buf: PNG_SIG, mime: 'image/png', changed: null });
        const rle = await normalizeReferenceImage(BMP3_RLE8, 'image/bmp');
        expect(rle).toEqual({ buf: BMP3_RLE8, mime: 'image/bmp', changed: null });
        const junk = Buffer.from('hello');
        expect(await normalizeReferenceImage(junk, 'image/jpeg')).toEqual({
            buf: junk,
            mime: 'image/jpeg',
            changed: null,
        });
        expect(await normalizeReferenceImage(Buffer.alloc(0), 'image/jpeg')).toMatchObject({ changed: null });
    });
});
