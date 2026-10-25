/**
 * 最小 APNG 编码器(给伪流式「生成中」占位帧做动图用)。
 *
 * sharp / libvips 不写 APNG(只写动态 GIF / WebP),但 APNG 本身只是在普通 PNG 上加三种 chunk:
 *   acTL(帧数 / 循环)、fcTL(每帧控制:偏移 / 尺寸 / 延时 / dispose / blend)、fdAT(帧数据 = 该帧独立
 *   zlib 流,前缀 4 字节序号)。每帧先用 sharp 独立编成 PNG,抠出它的 IDAT 数据塞进 fdAT 即可 ——
 *   前提是所有帧 bit depth / color type 一致(调用方统一出 8-bit RGBA、不调色板)。
 * 首帧 = 整幅画布(同时也是普通 PNG 解码器看到的静态图);后续帧可以只覆盖一个子矩形(x/y 偏移),
 * 转圈动画只更新中间一小块 → 4K 画布也只有几十 KB。
 */
import { crc32 } from 'node:zlib';

export interface ApngFrame {
    /** 该帧的完整 PNG 字节(8-bit RGBA,非调色板)。 */
    png: Buffer;
    /** 在画布上的偏移(首帧必须 0,0 且尺寸 = 画布)。 */
    x: number;
    y: number;
    /** 显示时长(ms)。 */
    delayMs: number;
}

interface PngParts {
    width: number;
    height: number;
    ihdr: Buffer;
    idat: Buffer;
}

function readChunks(png: Buffer): Array<{ type: string; data: Buffer }> {
    const out: Array<{ type: string; data: Buffer }> = [];
    let i = 8;
    while (i + 8 <= png.length) {
        const len = png.readUInt32BE(i);
        const type = png.toString('latin1', i + 4, i + 8);
        out.push({ type, data: png.subarray(i + 8, i + 8 + len) });
        i += 12 + len;
        if (type === 'IEND') break;
    }
    return out;
}

function parsePng(png: Buffer): PngParts {
    if (png.length < 8 || png[0] !== 0x89 || png.toString('latin1', 1, 4) !== 'PNG') throw new Error('not a PNG');
    const chunks = readChunks(png);
    const ihdr = chunks.find((c) => c.type === 'IHDR');
    if (!ihdr) throw new Error('PNG without IHDR');
    const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
    return { width: ihdr.data.readUInt32BE(0), height: ihdr.data.readUInt32BE(4), ihdr: ihdr.data, idat };
}

function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(data, crc32(typeBuf)) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crc]);
}

/** 把帧序列编成 APNG(无限循环)。首帧必须覆盖整幅画布;所有帧 IHDR 的 bit depth / color type 必须一致。 */
export function encodeApng(frames: ApngFrame[]): Buffer {
    if (frames.length === 0) throw new Error('no frames');
    const parts = frames.map((f) => parsePng(f.png));
    const canvas = parts[0];
    if (frames[0].x !== 0 || frames[0].y !== 0) throw new Error('first frame must be at 0,0');
    for (const p of parts) {
        if (p.ihdr[8] !== canvas.ihdr[8] || p.ihdr[9] !== canvas.ihdr[9])
            throw new Error('frames must share bit depth / color type');
    }
    const out: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', canvas.ihdr)];
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(frames.length, 0);
    actl.writeUInt32BE(0, 4); // 0 = 无限循环
    out.push(chunk('acTL', actl));
    let seq = 0;
    frames.forEach((f, i) => {
        const p = parts[i];
        const fctl = Buffer.alloc(26);
        fctl.writeUInt32BE(seq++, 0);
        fctl.writeUInt32BE(p.width, 4);
        fctl.writeUInt32BE(p.height, 8);
        fctl.writeUInt32BE(f.x, 12);
        fctl.writeUInt32BE(f.y, 16);
        fctl.writeUInt16BE(Math.max(1, Math.round(f.delayMs)), 20); // delay_num
        fctl.writeUInt16BE(1000, 22); // delay_den → 单位 ms
        fctl[24] = 0; // dispose_op: APNG_DISPOSE_OP_NONE(保留画布)
        fctl[25] = 0; // blend_op: APNG_BLEND_OP_SOURCE(整块替换,透明底也成立)
        out.push(chunk('fcTL', fctl));
        if (i === 0) {
            out.push(chunk('IDAT', p.idat));
        } else {
            const seqBuf = Buffer.alloc(4);
            seqBuf.writeUInt32BE(seq++, 0);
            out.push(chunk('fdAT', Buffer.concat([seqBuf, p.idat])));
        }
    });
    out.push(chunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(out);
}

/** 测试 / 排障用:读 APNG 的帧数与每帧控制块。 */
export function inspectApng(png: Buffer): {
    frames: number;
    loops: number;
    fctl: Array<{ w: number; h: number; x: number; y: number; delayMs: number }>;
} | null {
    const chunks = readChunks(png);
    const actl = chunks.find((c) => c.type === 'acTL');
    if (!actl) return null;
    const fctl = chunks
        .filter((c) => c.type === 'fcTL')
        .map((c) => ({
            w: c.data.readUInt32BE(4),
            h: c.data.readUInt32BE(8),
            x: c.data.readUInt32BE(12),
            y: c.data.readUInt32BE(16),
            delayMs: (c.data.readUInt16BE(20) * 1000) / (c.data.readUInt16BE(22) || 100),
        }));
    return { frames: actl.data.readUInt32BE(0), loops: actl.data.readUInt32BE(4), fctl };
}
