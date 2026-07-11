/**
 * 剥离 Adobe(Firefly)出图内嵌的 C2PA / 元数据,隐藏真实上游。
 *
 * 背景:候补渠道 ch83「adobe image2」实际是 Adobe Firefly Services 转发 GPT Image 2,出图 PNG
 * 内嵌 Adobe 私钥签名的 C2PA 内容凭证(`caBX` 块里 claim_generator=Adobe_Firefly + Adobe 证书链 +
 * com.adobe.* 断言)。HTTP 层已脱敏(响应头干净、报错改写 content_policy_violation),但客户把图丢进
 * contentcredentials.org / ExifTool / C2PA 工具就能读到「Adobe Firefly」。此函数把这层元数据剥掉。
 *
 * 【只剥 adobe 的图,不动 azure / gemini / 其它】—— 代理跑在 new-api 路由之前,拿不到请求落哪个渠道,
 * 所以靠【图片内容自定向】:仅当元数据块里真的含 adobe/firefly 标识才剥;否则原样返回(引用不变,
 * 字节完全一致)。Azure 的 gpt-image 若嵌 C2PA 是 Microsoft 签名(不含 adobe/firefly)→ 不触发。
 *
 * 剥法(纯字节过滤,不重编码像素,无损):
 *  - PNG:丢承载凭证/元数据的辅助块(caBX=C2PA / eXIf / iTXt / tEXt / zTXt / tIME),保留其余
 *         (IHDR/PLTE/IDAT/IEND 关键块 + iCCP/sRGB/gAMA/… 渲染色彩块)。实测 Firefly 出图只有
 *         IHDR/caBX/IDAT/IEND,丢 caBX 即 100% 去除 adobe 痕迹、像素分毫不动。
 *  - JPEG:丢含品牌的 APP1(EXIF/XMP)/ APP11(JUMBF/C2PA)/ APP13(IPTC)段(防御性,Firefly 出 PNG)。
 *
 * 任何解析异常 / 非图 → 返回原 buffer(绝不产出坏图,宁可不剥也不损图)。
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG 里承载元数据/凭证的辅助块 —— 命中 adobe 标识时剥掉这些;其余块(渲染 + 色彩)一律保留。
const PNG_META_CHUNKS = new Set(['caBX', 'eXIf', 'iTXt', 'tEXt', 'zTXt', 'tIME']);

// JPEG 里承载 EXIF/XMP(APP1)、JUMBF/C2PA(APP11)、IPTC(APP13)的段。
const JPEG_META_MARKERS = new Set([0xe1, 0xeb, 0xed]);

const ADOBE_MARKER = /adobe|firefly/i;

/** latin1 让任意字节都能当字符串搜(不丢字节);只在元数据段上跑,从不扫像素数据。 */
function bytesHaveAdobeMarker(slice: Buffer): boolean {
    return ADOBE_MARKER.test(slice.toString('latin1'));
}

interface PngChunk {
    type: string;
    start: number;
    end: number;
    dataStart: number;
    dataEnd: number;
}

function parsePngChunks(buf: Buffer): PngChunk[] {
    const chunks: PngChunk[] = [];
    let off = 8; // 跳过 8 字节签名
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        const end = off + 12 + len; // length(4) + type(4) + data(len) + crc(4)
        if (end > buf.length) break; // 截断 → 到此为止
        chunks.push({ type, start: off, end, dataStart: off + 8, dataEnd: off + 8 + len });
        if (type === 'IEND') break;
        off = end;
    }
    return chunks;
}

function stripPng(buf: Buffer): Buffer {
    const chunks = parsePngChunks(buf);
    if (chunks.length === 0) return buf;
    const isAdobe = chunks.some(
        (c) => PNG_META_CHUNKS.has(c.type) && bytesHaveAdobeMarker(buf.subarray(c.dataStart, c.dataEnd)),
    );
    if (!isAdobe) return buf; // 非 adobe(azure / gemini / 无凭证)→ 原样返回
    const keep = chunks.filter((c) => !PNG_META_CHUNKS.has(c.type));
    return Buffer.concat([PNG_MAGIC, ...keep.map((c) => buf.subarray(c.start, c.end))]);
}

interface JpegSeg {
    marker: number;
    start: number;
    end: number;
}

function parseJpegSegments(buf: Buffer): JpegSeg[] {
    const segs: JpegSeg[] = [];
    let off = 2; // 跳过 SOI(ff d8)
    while (off + 4 <= buf.length) {
        if (buf[off] !== 0xff) break;
        const marker = buf[off + 1];
        if (marker === 0xda) {
            // SOS:之后是熵编码扫描数据 + EOI,原样保留到结尾
            segs.push({ marker, start: off, end: buf.length });
            break;
        }
        const len = buf.readUInt16BE(off + 2);
        const end = off + 2 + len;
        if (end > buf.length) break;
        segs.push({ marker, start: off, end });
        off = end;
    }
    return segs;
}

function stripJpeg(buf: Buffer): Buffer {
    const segs = parseJpegSegments(buf);
    if (segs.length === 0) return buf;
    const isAdobe = segs.some(
        (s) => JPEG_META_MARKERS.has(s.marker) && bytesHaveAdobeMarker(buf.subarray(s.start + 4, s.end)),
    );
    if (!isAdobe) return buf;
    const keep = segs.filter((s) => !JPEG_META_MARKERS.has(s.marker));
    return Buffer.concat([Buffer.from([0xff, 0xd8]), ...keep.map((s) => buf.subarray(s.start, s.end))]);
}

/**
 * 见文件头注释。检测到 adobe/firefly 元数据 → 返回剥过的新 buffer;否则(非 adobe / 非图 /
 * 解析异常)→ 返回【原 buffer 引用】(调用方可用 `=== 入参` 判断是否发生改动、免去重编码)。
 */
export function stripAdobeImageMetadata(buf: Buffer): Buffer {
    try {
        if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return stripPng(buf);
        if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return stripJpeg(buf);
        return buf;
    } catch {
        return buf;
    }
}

/** base64 便捷版:解码 → 剥离 → 回编 base64。未改动(非 adobe/非图)时原样返回入参字符串,不重编。 */
export function stripAdobeImageMetadataB64(b64: string): string {
    const buf = Buffer.from(b64, 'base64');
    const stripped = stripAdobeImageMetadata(buf);
    return stripped === buf ? b64 : stripped.toString('base64');
}
