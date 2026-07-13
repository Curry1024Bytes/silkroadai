import { describe, it, expect } from 'vitest';
import { stripAdobeImageMetadata, stripAdobeImageMetadataB64 } from '@/lib/proxy/image-metadata';

// ---- 合成 PNG / JPEG 夹具(CRC 用零占位:被剥函数的解析器只读 length,不校验 CRC)----
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4) /* crc */]);
}
function mkPng(...chunks: Buffer[]): Buffer {
    return Buffer.concat([PNG_MAGIC, ...chunks]);
}
function pngChunkTypes(buf: Buffer): string[] {
    const types: string[] = [];
    let off = 8;
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        types.push(buf.toString('latin1', off + 4, off + 8));
        const end = off + 12 + len;
        if (buf.toString('latin1', off + 4, off + 8) === 'IEND' || end > buf.length) break;
        off = end;
    }
    return types;
}

const IHDR = pngChunk('IHDR', Buffer.alloc(13, 7));
const IDAT = pngChunk('IDAT', Buffer.from('PIXELS-not-metadata-these-bytes-are-the-image'));
const IEND = pngChunk('IEND', Buffer.alloc(0));
// C2PA JUMBF(caBX)—— adobe firefly 版 vs microsoft(azure)版
const CABX_ADOBE = pngChunk(
    'caBX',
    Buffer.from(
        'jumbfc2pa...oclaim_generatormAdobe_Firefly...qcom.adobe.modelIdigpt-image...Adobe Systems Incorporated',
    ),
);
const CABX_MSFT = pngChunk('caBX', Buffer.from('jumbfc2pa...claim_generator Microsoft...azure openai...contentauth'));

function jpegSeg(marker: number, data: Buffer): Buffer {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(data.length + 2, 0);
    return Buffer.concat([Buffer.from([0xff, marker]), len, data]);
}
const SOI = Buffer.from([0xff, 0xd8]);
const APP0_JFIF = jpegSeg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'));
const SOS = Buffer.concat([
    Buffer.from([0xff, 0xda]),
    Buffer.from('scan-header+entropy-coded-image-data'),
    Buffer.from([0xff, 0xd9]),
]);
const APP11_ADOBE = jpegSeg(0xeb, Buffer.from('JP\0\0jumbf...claim_generator Adobe Firefly...com.adobe'));
const APP1_MSFT_EXIF = jpegSeg(0xe1, Buffer.from('Exif\0\0Microsoft Windows Photo'));

describe('stripAdobeImageMetadata — PNG', () => {
    it('剥掉含 adobe/firefly 的 caBX(C2PA),保留 IHDR/IDAT/IEND', () => {
        const input = mkPng(IHDR, CABX_ADOBE, IDAT, IEND);
        const out = stripAdobeImageMetadata(input);
        expect(out).not.toBe(input); // 有改动
        expect(out.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
        expect(pngChunkTypes(out)).toEqual(['IHDR', 'IDAT', 'IEND']);
        expect(out.toString('latin1').toLowerCase()).not.toContain('adobe');
        expect(out.toString('latin1').toLowerCase()).not.toContain('firefly');
        expect(out.toString('latin1')).not.toContain('claim_generator');
    });

    it('像素无损:IDAT 字节与输入完全一致', () => {
        const input = mkPng(IHDR, CABX_ADOBE, IDAT, IEND);
        const out = stripAdobeImageMetadata(input);
        // 提取 IDAT data 段比对
        const idatData = IDAT.subarray(8, IDAT.length - 4);
        expect(out.includes(idatData)).toBe(true);
    });

    it('azure(Microsoft C2PA)不动:字节完全一致、同一引用返回', () => {
        const input = mkPng(IHDR, CABX_MSFT, IDAT, IEND);
        const out = stripAdobeImageMetadata(input);
        expect(out).toBe(input); // 引用不变(未改动)
    });

    it('无元数据的普通 PNG 不动', () => {
        const input = mkPng(IHDR, IDAT, IEND);
        expect(stripAdobeImageMetadata(input)).toBe(input);
    });

    it('adobe XMP 藏在 iTXt(无 caBX)也剥', () => {
        const iTXt = pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp...Adobe Firefly'));
        const input = mkPng(IHDR, iTXt, IDAT, IEND);
        const out = stripAdobeImageMetadata(input);
        expect(pngChunkTypes(out)).toEqual(['IHDR', 'IDAT', 'IEND']);
        expect(out.toString('latin1').toLowerCase()).not.toContain('adobe');
    });

    it('剥 adobe 时保留渲染/色彩辅助块(iCCP/gAMA/pHYs 不误伤)', () => {
        const iCCP = pngChunk('iCCP', Buffer.from('sRGB\0\0deflated-icc-profile'));
        const gAMA = pngChunk('gAMA', Buffer.alloc(4, 1));
        const input = mkPng(IHDR, iCCP, gAMA, CABX_ADOBE, IDAT, IEND);
        const out = stripAdobeImageMetadata(input);
        expect(pngChunkTypes(out)).toEqual(['IHDR', 'iCCP', 'gAMA', 'IDAT', 'IEND']); // caBX 没了,其余都在
    });

    it('幂等:剥两次结果稳定(第二次无 adobe → 不动)', () => {
        const input = mkPng(IHDR, CABX_ADOBE, IDAT, IEND);
        const once = stripAdobeImageMetadata(input);
        const twice = stripAdobeImageMetadata(once);
        expect(twice).toBe(once); // 第二次返回同一引用
    });

    it('截断/损坏的 PNG 不抛异常,原样返回', () => {
        const bad = Buffer.concat([
            PNG_MAGIC,
            Buffer.from([0x00, 0x00, 0x99, 0x99]),
            Buffer.from('caBXadobe-truncated'),
        ]);
        expect(() => stripAdobeImageMetadata(bad)).not.toThrow();
        expect(stripAdobeImageMetadata(bad)).toBe(bad);
    });
});

describe('stripAdobeImageMetadata — JPEG', () => {
    it('剥掉含 adobe 的 APP11(C2PA),保留 SOI/APP0/SOS', () => {
        const input = Buffer.concat([SOI, APP0_JFIF, APP11_ADOBE, SOS]);
        const out = stripAdobeImageMetadata(input);
        expect(out).not.toBe(input);
        expect(out.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
        expect(out.toString('latin1').toLowerCase()).not.toContain('adobe');
        expect(out.includes(Buffer.from('scan-header+entropy-coded-image-data'))).toBe(true); // 图像数据在
        expect(out.includes(APP0_JFIF)).toBe(true); // JFIF 保留
    });

    it('azure(Microsoft EXIF)JPEG 不动', () => {
        const input = Buffer.concat([SOI, APP0_JFIF, APP1_MSFT_EXIF, SOS]);
        expect(stripAdobeImageMetadata(input)).toBe(input);
    });
});

describe('stripAdobeImageMetadata — 其它', () => {
    it('非图片 buffer 原样返回', () => {
        const buf = Buffer.from('this is not an image at all, just text');
        expect(stripAdobeImageMetadata(buf)).toBe(buf);
    });

    it('空 buffer 原样返回', () => {
        const buf = Buffer.alloc(0);
        expect(stripAdobeImageMetadata(buf)).toBe(buf);
    });
});

describe('stripAdobeImageMetadataB64', () => {
    it('adobe 图:回编后 base64 变短、解码无 adobe', () => {
        const input = mkPng(IHDR, CABX_ADOBE, IDAT, IEND);
        const b64 = input.toString('base64');
        const out = stripAdobeImageMetadataB64(b64);
        expect(out).not.toBe(b64);
        expect(Buffer.from(out, 'base64').toString('latin1').toLowerCase()).not.toContain('adobe');
    });

    it('非 adobe 图:返回同一 base64 字符串(不重编码)', () => {
        const input = mkPng(IHDR, IDAT, IEND);
        const b64 = input.toString('base64');
        expect(stripAdobeImageMetadataB64(b64)).toBe(b64);
    });
});
