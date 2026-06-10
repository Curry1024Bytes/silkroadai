/**
 * Portal /v1/* catch-all proxy (W9 D1, PR-A — task #33 Phase 1)
 *
 * 拦截所有 ai.silkroadai.io/v1/* 请求(Caddy 切流量到 portal :3002 后生效):
 *
 * 1. POST /v1/chat/completions + Gemini image 模型
 *    → 翻译到 new-api native `/v1beta/models/<model>:generateContent`
 *      并注入 `generationConfig.imageConfig.imageSize`(1K/2K/4K)。
 *      OpenAI SDK 客户端因此能拿到真 2K/4K(chat/completions 兼容层只出 1K,
 *      见 docs/W8-D8-DEPLOY-2026-06-04.md + Channel 17 fix PR #71)。
 *      响应转回 OpenAI chat.completion 格式。
 *      Phase 2(W9 D2,本版):
 *      - 入参支持 OpenAI 多模态 content array:`image_url` 项接受 data URL
 *        (直接解 base64)和外部 http(s) URL(portal fetch 后转 base64),
 *        翻译成 Gemini `inlineData`。外部 URL 有 SSRF 基础守门(协议白名单 +
 *        localhost/私网 IP 字面量拒绝;DNS rebinding 级别的防护留 Phase 3)
 *        + 20MB 大小上限。fetch 失败 → 400(OpenAI invalid_request_error 形)。
 *      - 出图改传 R2(复用 PR-T1 的 `src/lib/r2/client.ts` uploadImage,
 *        key = `gen/{uuid}.{ext}`),content 返 markdown 公网 URL。
 *        R2 不可用时降级回 data URL 内联 + `X-Silkroadai-R2-Fallback: yes`
 *        (客户请求不应因我们的存储故障而失败)。
 *      ⚠️ `gen/` 前缀不在 image-cleanup cron 的管辖内(那个按 ImageGeneration
 *        DB 行删 `image-gen/`),会累积 — operator 可在 R2 配 lifecycle rule。
 *
 * 2. POST /v1/chat/completions + claude-* 且 max_tokens > 4096
 *    → 钳到 4096 + 响应头 `X-Silkroadai-Clamped`(上游号池对超大
 *      max_tokens 限制,超了直接 4xx,钳掉对客户更友好)。
 *
 * 3. POST /v1/images/{edits,generations}(DALL·E 兼容层,W9 D4)
 *    + Gemini 生图模型 → 翻译到 native generateContent(注入 imageSize +
 *      aspect_ratio),响应包成 DALL·E 形 `{ created, data:[{url|b64_json}] }`。
 *      multipart/form-data(对标 gpt-best「Nano-banana」)与 JSON 两种 body 都收。
 *      非 Gemini model(gpt-image-2 等)→ 原样透传 new-api。详见 handleImagesDalle。
 *
 * 4. 其余一切(/messages、/models、/embeddings、其他模型的 /chat/completions…)
 *    → 原样透传 new-api,streaming SSE 不缓冲(直接 forward upstream ReadableStream)。
 *
 * 边界:
 * - 本文件不做鉴权 — Authorization 头原样透传,new-api 自己校验 sk-xxx。
 * - DB 访问仅限 Phase 3 的客户 OSS 查询(read-only,且任何 DB 故障都
 *   静默回退平台 R2,绝不阻断客户请求);其余路径不触 DB。
 * - 回滚 = Caddy reverse_proxy 切回 new-api :3000(见 handoff 1.3)。
 *
 * Phase 3(W9 D3):出图存储按优先级:
 *   1. 客户自定义 OSS(/settings/storage 配置,status='active')
 *   2. 失败 → 平台 R2 + `X-Silkroadai-Oss-Fallback: yes`
 *   3. R2 也失败 → data URL 内联 + `X-Silkroadai-R2-Fallback: yes`
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { uploadImage } from '@/lib/r2/client';
import { uploadToCustomerOss } from '@/lib/oss/client';
import { getOssConfig, resolveUserIdFromAuthHeader } from '@/lib/oss/store';

// Next.js: 强制动态 + Node runtime(需要流式 fetch duplex)
export const dynamic = 'force-dynamic';

const NEWAPI_BASE_URL = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';

/** Gemini image 模型 → 注入的 native imageSize */
const GEMINI_IMAGE_MODELS: Record<string, '1K' | '2K' | '4K'> = {
    'gemini-2.5-flash-image': '1K',
    'gemini-3.1-flash-image-preview': '2K',
    'gemini-3-pro-image-preview': '4K',
};

/** Gemini 官方支持的 aspect_ratio 白名单(按模型分档,key 与 GEMINI_IMAGE_MODELS 对齐)。
 *  来源:ai.google.dev image-generation 文档 + Vertex 3-pro-image 文档(2026-06 查证)。
 *  pro 档比 flash 多 1:4 / 1:8 / 8:1 三个极端比例。 */
const GEMINI_ASPECT_RATIOS: Record<string, ReadonlySet<string>> = {
    'gemini-2.5-flash-image': new Set(['21:9', '16:9', '4:3', '3:2', '1:1', '9:16', '3:4', '2:3', '5:4', '4:5']),
    'gemini-3.1-flash-image-preview': new Set([
        '21:9',
        '16:9',
        '4:3',
        '3:2',
        '1:1',
        '9:16',
        '3:4',
        '2:3',
        '5:4',
        '4:5',
    ]),
    'gemini-3-pro-image-preview': new Set([
        '1:1',
        '2:3',
        '3:2',
        '3:4',
        '4:3',
        '4:5',
        '5:4',
        '9:16',
        '16:9',
        '21:9',
        '1:4',
        '1:8',
        '8:1',
    ]),
};

const CLAUDE_MAX_TOKENS_CAP = 4096;

/** 外部 image_url fetch 的大小上限(Gemini inline 也有自己的上限,先在我们这层挡) */
const IMAGE_FETCH_MAX_BYTES = 20 * 1024 * 1024;

/** 不往上游转发的请求头(host/content-length 由 fetch 重算) */
const HOP_BY_HOP_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding']);

/** 不往客户端回传的响应头(body 已被改写/重新分块时这些头会撒谎) */
const STRIP_RESPONSE_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection']);

type JsonRecord = Record<string, unknown>;

function forwardHeaders(req: NextRequest): Headers {
    const headers = new Headers();
    req.headers.forEach((value, key) => {
        if (!HOP_BY_HOP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
    });
    return headers;
}

/** 翻译到 native generateContent 时用:复用鉴权头但强制 JSON Content-Type。
 *  原请求可能是 multipart/form-data,若把那个 Content-Type 带给 JSON body,
 *  new-api 会把 JSON 当 multipart 解析 → `bufio: buffer full` / `NextPart: EOF`。 */
function jsonForwardHeaders(req: NextRequest): Headers {
    const h = forwardHeaders(req);
    h.set('content-type', 'application/json');
    return h;
}

function passthroughResponse(upstream: Response): NextResponse {
    const headers = new Headers();
    upstream.headers.forEach((value, key) => {
        if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
    });
    return new NextResponse(upstream.body, { status: upstream.status, headers });
}

async function forwardToNewApi(
    req: NextRequest,
    bodyOverride: JsonRecord | null,
    path: string,
    search: string,
): Promise<NextResponse> {
    const url = `${NEWAPI_BASE_URL}/v1${path}${search}`;
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const init: RequestInit & { duplex?: 'half' } = {
        method: req.method,
        headers: forwardHeaders(req),
        // streaming SSE 透传:upstream.body 直接 forward,不缓冲
        body: bodyOverride ? JSON.stringify(bodyOverride) : hasBody ? req.body : undefined,
        duplex: 'half',
    };
    const upstream = await fetch(url, init);
    return passthroughResponse(upstream);
}

/** image_url 解析失败 → 客户侧 400(OpenAI invalid_request_error 形) */
class ImageUrlError extends Error {}

/** SSRF 基础守门:只放 http(s) + 拒 localhost / 私网 IPv4 字面量 / IPv6 字面量。
 *  DNS 解析到私网的域名(rebinding)不在本层防护范围 — Phase 3 hardening。 */
function isDisallowedImageUrl(raw: string): boolean {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return true;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
    if (h.includes(':') || h.startsWith('[')) return true; // IPv6 literal
    const ipv4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4) {
        const a = Number(ipv4[1]);
        const b = Number(ipv4[2]);
        if (
            a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168)
        )
            return true;
    }
    return false;
}

type GeminiInputPart = { text: string } | { inlineData: { mimeType: string; data: string } };

/** 单个 OpenAI image_url → Gemini inlineData(data URL 直解;外部 URL fetch)。 */
async function imageUrlToInlinePart(url: string): Promise<GeminiInputPart> {
    // 注:JSON string 里不会有裸换行,无需 dotAll(tsconfig target 限制 /s flag)
    const dataUrl = url.match(/^data:([^;,]+);base64,([\s\S]+)$/);
    if (dataUrl) {
        return { inlineData: { mimeType: dataUrl[1], data: dataUrl[2] } };
    }
    if (url.startsWith('data:')) {
        throw new ImageUrlError('image_url data URL must be base64-encoded');
    }
    if (isDisallowedImageUrl(url)) {
        throw new ImageUrlError(`image_url not allowed: ${url.slice(0, 200)}`);
    }
    let resp: Response;
    try {
        resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    } catch {
        throw new ImageUrlError(`image_url fetch failed: network error for ${url.slice(0, 200)}`);
    }
    if (!resp.ok) {
        throw new ImageUrlError(`image_url fetch failed: ${resp.status}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > IMAGE_FETCH_MAX_BYTES) {
        throw new ImageUrlError(`image_url too large: ${buf.byteLength} bytes (max ${IMAGE_FETCH_MAX_BYTES})`);
    }
    const mimeType = resp.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
    return { inlineData: { mimeType, data: buf.toString('base64') } };
}

/** OpenAI message content(string 或 multimodal array)→ Gemini parts。
 *  Phase 2:支持 image_url(data URL / 外部 URL)。解析失败抛 ImageUrlError → 400。 */
async function toGeminiContents(messages: unknown): Promise<Array<{ role: string; parts: GeminiInputPart[] }>> {
    if (!Array.isArray(messages)) return [];
    return Promise.all(
        messages.map(async (m) => {
            const msg = (m ?? {}) as JsonRecord;
            const content = msg.content;
            const parts: GeminiInputPart[] = [];
            if (typeof content === 'string') {
                parts.push({ text: content });
            } else if (Array.isArray(content)) {
                for (const item of content) {
                    const it = (item ?? {}) as JsonRecord;
                    if (it.type === 'text' && typeof it.text === 'string') {
                        parts.push({ text: it.text });
                    } else if (it.type === 'image_url') {
                        const imageUrl = (it.image_url ?? {}) as JsonRecord;
                        if (typeof imageUrl.url !== 'string') {
                            throw new ImageUrlError('image_url.url must be a string');
                        }
                        parts.push(await imageUrlToInlinePart(imageUrl.url));
                    }
                }
            }
            if (parts.length === 0) parts.push({ text: '' });
            return {
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts,
            };
        }),
    );
}

/** 从图片字节头读宽高(dep-free,只认 PNG / JPEG / WebP 三种主流格式)。
 *  读不出(其他格式 / 截断 / 坏数据)→ null,调用方按"不注入 aspectRatio"降级。 */
function imageDimensions(buf: Buffer): { w: number; h: number } | null {
    // PNG:8 字节签名 + IHDR chunk,width / height 大端在 offset 16 / 20
    if (
        buf.length >= 24 &&
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47 &&
        buf.toString('latin1', 12, 16) === 'IHDR'
    ) {
        const w = buf.readUInt32BE(16);
        const h = buf.readUInt32BE(20);
        return w > 0 && h > 0 ? { w, h } : null;
    }
    // JPEG:FF D8 起,顺序扫 segment 找 SOF(C0-CF 除 DHT C4 / JPG C8 / DAC CC),
    // SOF payload = [precision(1)][height(2)][width(2)],大端
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        while (i + 9 <= buf.length) {
            if (buf[i] !== 0xff) return null;
            const marker = buf[i + 1];
            if (marker === 0xff) {
                i += 1; // padding fill byte
                continue;
            }
            if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
                i += 2; // standalone marker(RST/SOI/EOI/TEM)无 length 段
                continue;
            }
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                const h = buf.readUInt16BE(i + 5);
                const w = buf.readUInt16BE(i + 7);
                return w > 0 && h > 0 ? { w, h } : null;
            }
            i += 2 + buf.readUInt16BE(i + 2);
        }
        return null;
    }
    // WebP:RIFF container,VP8(lossy)/ VP8L(lossless)/ VP8X(extended)三种 chunk
    if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
        const chunk = buf.toString('latin1', 12, 16);
        if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
            // payload = 3 字节 frame tag + sync code 9D 01 2A + 14-bit 宽 / 高(小端)
            const w = buf.readUInt16LE(26) & 0x3fff;
            const h = buf.readUInt16LE(28) & 0x3fff;
            return w > 0 && h > 0 ? { w, h } : null;
        }
        if (chunk === 'VP8L' && buf[20] === 0x2f) {
            // 签名 0x2F 后 28 bit 打包:14-bit (width-1) + 14-bit (height-1),LSB-first
            const w = 1 + (((buf[22] & 0x3f) << 8) | buf[21]);
            const h = 1 + (((buf[24] & 0x0f) << 10) | (buf[23] << 2) | (buf[22] >> 6));
            return { w, h };
        }
        if (chunk === 'VP8X') {
            // flags(1) + reserved(3) 后 24-bit (canvasWidth-1) / (canvasHeight-1),小端
            const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
            const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
            return { w, h };
        }
        return null;
    }
    return null;
}

/** 在该 model 的官方白名单里找与 w/h 线性距离最近的 aspectRatio(精确比例必命中;
 *  并列时取白名单先出现者)。 */
function closestAspectRatio(w: number, h: number, model: string): string | null {
    const allowed = GEMINI_ASPECT_RATIOS[model];
    if (!allowed) return null;
    const target = w / h;
    let best: string | null = null;
    let bestDiff = Infinity;
    for (const candidate of allowed) {
        const [cw, ch] = candidate.split(':');
        const diff = Math.abs(Number(cw) / Number(ch) - target);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = candidate;
        }
    }
    return best;
}

/** 图生图 auto 语义:Gemini 不给 aspectRatio 时默认 1:1,【不会】自动跟随输入图
 *  (实测纠正 D4-hotfix 的"跟随输入图"假设 — 16:9 输入曾被出成方图)。
 *  所以从第一张输入图(主图;多参考图时取第一张)的字节头读宽高,
 *  映射到该 model 白名单里最接近的比例,由调用方注入。
 *  读不出尺寸 → null,调用方维持"不注入"现状 — 出图绝不因读比例失败而失败。 */
function aspectRatioFromInput(parts: GeminiInputPart[], model: string): string | null {
    const image = parts.find((p): p is { inlineData: { mimeType: string; data: string } } => 'inlineData' in p);
    if (!image) return null;
    const dims = imageDimensions(Buffer.from(image.inlineData.data, 'base64'));
    return dims ? closestAspectRatio(dims.w, dims.h, model) : null;
}

interface GeminiPart {
    text?: string;
    inlineData?: { mimeType: string; data: string };
}

interface StoredImage {
    /** url 模式用:公网 URL(客户 OSS / 平台 R2)或降级时的 data URL */
    url: string;
    ossFallback: boolean;
    r2Fallback: boolean;
}

/** 生成的 base64 图 → 客户 OSS / 平台 R2 / data URL 内联,三级降级。
 *  任何故障(DB / OSS / R2)都不抛 — 客户请求绝不因我们的存储故障而失败。
 *  chat(handleGeminiImage)与 images(handleImagesDalle)两条路复用此函数。 */
async function storeGeneratedImage(
    req: NextRequest,
    buffer: Buffer,
    mimeType: string,
    base64: string,
): Promise<StoredImage> {
    const ext = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';
    const key = `gen/${randomUUID()}.${ext}`;
    let ossFallback = false;

    // Phase 3:sk-xxx 反查 portal user → 客户 OSS 配置(查询失败一律回平台 R2)
    let customerUrl: string | null = null;
    try {
        const userId = await resolveUserIdFromAuthHeader(req.headers.get('authorization'));
        const ossConfig = userId ? await getOssConfig(userId) : null;
        if (ossConfig && ossConfig.status === 'active') {
            try {
                customerUrl = await uploadToCustomerOss(ossConfig, buffer, key, mimeType);
            } catch (e) {
                console.warn('[v1-proxy] customer OSS upload failed, falling back to platform R2', e);
                ossFallback = true;
            }
        }
    } catch (e) {
        // DB 故障等 — 静默走平台 R2,不阻断客户请求
        console.warn('[v1-proxy] customer OSS lookup failed, using platform R2', e);
    }

    if (customerUrl) return { url: customerUrl, ossFallback, r2Fallback: false };

    try {
        const url = await uploadImage(key, buffer, mimeType);
        return { url, ossFallback, r2Fallback: false };
    } catch (e) {
        console.warn('[v1-proxy] R2 upload failed, falling back to inline data URL', e);
        return { url: `data:${mimeType};base64,${base64}`, ossFallback, r2Fallback: true };
    }
}

async function handleGeminiImage(req: NextRequest, body: JsonRecord, model: string): Promise<NextResponse> {
    const imageSize = GEMINI_IMAGE_MODELS[model];
    let contents: Array<{ role: string; parts: GeminiInputPart[] }>;
    try {
        contents = await toGeminiContents(body.messages);
    } catch (e) {
        if (e instanceof ImageUrlError) {
            return NextResponse.json({ error: { message: e.message, type: 'invalid_request_error' } }, { status: 400 });
        }
        throw e;
    }

    // chat 形态没有 aspect_ratio 参数,等同 auto:文生图不注入(走 Gemini 默认);
    // 图生图(image_url 入参)读输入图尺寸注入最近的合法比例 — Gemini 默认 1:1
    // 不跟随输入图(见 aspectRatioFromInput)。与 /v1/images/* 的 auto 行为一致。
    const imageConfig: Record<string, string> = { imageSize };
    const inputAspect = aspectRatioFromInput(
        contents.flatMap((c) => c.parts),
        model,
    );
    if (inputAspect) imageConfig.aspectRatio = inputAspect;

    const upstream = await fetch(`${NEWAPI_BASE_URL}/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: jsonForwardHeaders(req),
        body: JSON.stringify({
            contents,
            generationConfig: { imageConfig },
        }),
    });

    if (!upstream.ok) {
        // 上游错误(401 / 429 / 5xx)原样透传 status + body,客户端能看到 new-api 的错误信息
        return passthroughResponse(upstream);
    }

    const upstreamData = (await upstream.json()) as {
        candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    const parts: GeminiPart[] = upstreamData.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((p) => p.inlineData);

    let content: string;
    let stored: StoredImage | null = null;
    if (imagePart?.inlineData) {
        // Phase 2/3:客户 OSS → 平台 R2 → data URL 内联,三级降级(请求不失败)
        const { mimeType, data } = imagePart.inlineData;
        stored = await storeGeneratedImage(req, Buffer.from(data, 'base64'), mimeType, data);
        content = `![image](${stored.url})`;
    } else {
        content = parts.find((p) => typeof p.text === 'string')?.text ?? 'No image generated';
    }

    const openaiResp = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: {
            prompt_tokens: upstreamData.usageMetadata?.promptTokenCount ?? 0,
            completion_tokens: upstreamData.usageMetadata?.candidatesTokenCount ?? 0,
            total_tokens: upstreamData.usageMetadata?.totalTokenCount ?? 0,
        },
    };

    const respHeaders: Record<string, string> = { 'X-Silkroadai-Translated': 'gemini-native' };
    if (stored?.ossFallback) respHeaders['X-Silkroadai-Oss-Fallback'] = 'yes';
    if (stored?.r2Fallback) respHeaders['X-Silkroadai-R2-Fallback'] = 'yes';
    return NextResponse.json(openaiResp, { status: 200, headers: respHeaders });
}

/** DALL·E 形错误(默认 400 invalid_request_error)。 */
function imageError(message: string, status = 400): NextResponse {
    return NextResponse.json({ error: { message, type: 'invalid_request_error' } }, { status });
}

/** 非 Gemini model 的 multipart 透传:重建 FormData 转发 new-api。
 *  req.body 已被 formData() 消费,不能再 stream,所以转发已解析的 FormData;
 *  删掉原 content-type 让 fetch 按新 FormData 重新生成 boundary。 */
async function forwardMultipart(req: NextRequest, form: FormData, path: string, search: string): Promise<NextResponse> {
    const headers = forwardHeaders(req);
    headers.delete('content-type');
    const upstream = await fetch(`${NEWAPI_BASE_URL}/v1${path}${search}`, {
        method: 'POST',
        headers,
        body: form,
    });
    return passthroughResponse(upstream);
}

/**
 * /v1/images/edits + /v1/images/generations 的 DALL·E 兼容入口(W9 D4)。
 *
 * model 命中 GEMINI_IMAGE_MODELS → 翻译到 Gemini native generateContent
 * 注入 imageSize(1K/2K/4K)、按需注入 aspectRatio,响应包成 DALL·E 形
 * `{ created, data: [{ url | b64_json }] }`;否则原样透传 new-api(gpt-image-2 等)。
 *
 * 边界与已知取舍(对照官方 DALL·E 的有意差异):
 * - `n`(多图):不支持,固定返 1 张(Gemini generateContent 单次出 1 图)。
 *   客户传 n>1 我们忽略。需多图后续迭代。
 * - `size`(如 1024x1024):忽略 —— 分辨率由 model 档位(imageSize 1K/2K/4K)决定,
 *   比例由 aspect_ratio 决定。
 * - `aspect_ratio` 缺省 / `""` / `auto`(大小写不限)= "不指定" → 文生图不注入 aspectRatio
 *   (走 Gemini 默认);图生图读输入主图尺寸注入白名单里最近的比例(Gemini 不注入时
 *   默认 1:1、不跟随输入图);非空、非 auto 且不在该 model 官方白名单 → 400。
 * - 多参考图:`image` 字段可重复(multipart form.getAll('image') / JSON 数组),
 *   全部按顺序转 inlineData 塞进 parts。
 * - 鉴权不在本层 —— Authorization 透传,new-api 校验 sk-xxx。
 */
async function handleImagesDalle(req: NextRequest, path: string, search: string): Promise<NextResponse> {
    const contentType = req.headers.get('content-type') || '';
    const isMultipart = contentType.includes('multipart/form-data');

    // ---- 解析入参(multipart 或 JSON)----
    let model = '';
    let prompt = '';
    let responseFormat = 'url';
    let aspectRatio = '';
    const inputParts: GeminiInputPart[] = [];

    try {
        if (isMultipart) {
            const form = await req.formData();
            model = String(form.get('model') ?? '');
            prompt = String(form.get('prompt') ?? '');
            responseFormat = String(form.get('response_format') ?? 'url') || 'url';
            aspectRatio = String(form.get('aspect_ratio') ?? '');
            // model 非我们的 Gemini 生图 → 重建 FormData 透传(保留 gpt-image-2 等)
            if (!(model in GEMINI_IMAGE_MODELS)) {
                return forwardMultipart(req, form, path, search);
            }
            for (const file of form.getAll('image')) {
                if (file instanceof File && file.size > 0) {
                    const buf = Buffer.from(await file.arrayBuffer());
                    if (buf.byteLength > IMAGE_FETCH_MAX_BYTES) {
                        return imageError(`image too large: ${buf.byteLength} bytes (max ${IMAGE_FETCH_MAX_BYTES})`);
                    }
                    inputParts.push({
                        inlineData: { mimeType: file.type || 'image/png', data: buf.toString('base64') },
                    });
                }
            }
        } else {
            const body = (await req.json()) as JsonRecord;
            model = String(body.model ?? '');
            prompt = String(body.prompt ?? '');
            responseFormat = String(body.response_format ?? 'url') || 'url';
            aspectRatio = String(body.aspect_ratio ?? '');
            if (!(model in GEMINI_IMAGE_MODELS)) {
                return forwardToNewApi(req, body, path, search);
            }
            // JSON 形态的 image 可能是 data URL / 外部 URL 字符串或其数组(复用现有 helper)
            const imageField = body.image;
            const urls = Array.isArray(imageField) ? imageField : imageField ? [imageField] : [];
            for (const u of urls) {
                if (typeof u === 'string') inputParts.push(await imageUrlToInlinePart(u));
            }
        }
    } catch (e) {
        if (e instanceof ImageUrlError) return imageError(e.message);
        return imageError('invalid request body');
    }

    // ---- aspect_ratio 校验 ----
    // "" 和 "auto"(大小写不限)= "不指定"。业界客户端(OpenAI gpt-image size:"auto" 等)
    // 常默认发 auto,不能当非法值拒。
    const wantsAuto = aspectRatio === '' || aspectRatio.toLowerCase() === 'auto';
    const allowed = GEMINI_ASPECT_RATIOS[model];
    if (aspectRatio && !wantsAuto && !allowed.has(aspectRatio)) {
        return imageError(`unsupported aspect_ratio "${aspectRatio}" for ${model}`);
    }

    // 显式合法比例 → 按显式注入;auto/空 + 有输入图(图生图)→ 读主图尺寸注入
    // 最近的合法比例(Gemini 默认 1:1 不跟随输入图,见 aspectRatioFromInput);
    // auto/空 + 无输入图(文生图)/ 尺寸读不出 → 不注入,走 Gemini 默认。
    const imageConfig: Record<string, string> = { imageSize: GEMINI_IMAGE_MODELS[model] };
    if (!wantsAuto) {
        imageConfig.aspectRatio = aspectRatio;
    } else {
        const inputAspect = aspectRatioFromInput(inputParts, model);
        if (inputAspect) imageConfig.aspectRatio = inputAspect;
    }

    // ---- 拼 Gemini contents:prompt 文本 + 参考图 inlineData ----
    const parts: GeminiInputPart[] = [{ text: prompt }, ...inputParts];
    const upstream = await fetch(`${NEWAPI_BASE_URL}/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: jsonForwardHeaders(req),
        body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: { imageConfig },
        }),
    });
    if (!upstream.ok) return passthroughResponse(upstream);

    const upstreamData = (await upstream.json()) as {
        candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
    };
    const inlineData = (upstreamData.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData)?.inlineData;
    if (!inlineData) {
        return imageError('no image generated', 502);
    }

    // ---- 包成 DALL·E 响应 ----
    const { mimeType, data: b64 } = inlineData;
    const respHeaders: Record<string, string> = { 'X-Silkroadai-Translated': 'gemini-native' };
    let datum: JsonRecord;

    if (responseFormat === 'b64_json') {
        datum = { b64_json: b64 };
    } else {
        const stored = await storeGeneratedImage(req, Buffer.from(b64, 'base64'), mimeType, b64);
        datum = { url: stored.url };
        if (stored.ossFallback) respHeaders['X-Silkroadai-Oss-Fallback'] = 'yes';
        if (stored.r2Fallback) respHeaders['X-Silkroadai-R2-Fallback'] = 'yes';
    }

    return NextResponse.json(
        { created: Math.floor(Date.now() / 1000), data: [datum] },
        { status: 200, headers: respHeaders },
    );
}

async function handleRequest(req: NextRequest, params: Promise<{ path: string[] }>): Promise<NextResponse> {
    const { path: segments } = await params;
    const path = '/' + (segments ?? []).join('/');
    const search = req.nextUrl.search || '';

    if (path === '/chat/completions' && req.method === 'POST') {
        let body: JsonRecord;
        try {
            body = (await req.json()) as JsonRecord;
        } catch {
            return NextResponse.json(
                { error: { message: 'invalid JSON body', type: 'invalid_request_error' } },
                { status: 400 },
            );
        }
        const model = String(body.model ?? '');

        // Branch 1: Gemini image → native endpoint 翻译
        if (model in GEMINI_IMAGE_MODELS) {
            return handleGeminiImage(req, body, model);
        }

        // Branch 2: Claude max_tokens clamp
        const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : 0;
        if (model.startsWith('claude-') && maxTokens > CLAUDE_MAX_TOKENS_CAP) {
            const clamped = { ...body, max_tokens: CLAUDE_MAX_TOKENS_CAP };
            const resp = await forwardToNewApi(req, clamped, path, search);
            resp.headers.set('X-Silkroadai-Clamped', `max_tokens=${CLAUDE_MAX_TOKENS_CAP}-was-${maxTokens}`);
            return resp;
        }

        // Branch 3: 其他模型透传(body 已消费,重新序列化)
        return forwardToNewApi(req, body, path, search);
    }

    // DALL·E 兼容图像接口:Gemini 生图模型翻译,其余(gpt-image-2 等)透传
    if ((path === '/images/edits' || path === '/images/generations') && req.method === 'POST') {
        return handleImagesDalle(req, path, search);
    }

    // 其他路径(/messages /models /embeddings …)全部透传
    return forwardToNewApi(req, null, path, search);
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: RouteContext) {
    return handleRequest(req, ctx.params);
}
export async function POST(req: NextRequest, ctx: RouteContext) {
    return handleRequest(req, ctx.params);
}
export async function PUT(req: NextRequest, ctx: RouteContext) {
    return handleRequest(req, ctx.params);
}
export async function DELETE(req: NextRequest, ctx: RouteContext) {
    return handleRequest(req, ctx.params);
}
