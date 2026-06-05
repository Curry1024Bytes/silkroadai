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
 * 3. 其余一切(/messages、/images/generations、/models、/embeddings、
 *    其他模型的 /chat/completions…)→ 原样透传 new-api,
 *    streaming SSE 不缓冲(直接 forward upstream ReadableStream)。
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

interface GeminiPart {
    text?: string;
    inlineData?: { mimeType: string; data: string };
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

    const upstream = await fetch(`${NEWAPI_BASE_URL}/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: forwardHeaders(req),
        body: JSON.stringify({
            contents,
            generationConfig: { imageConfig: { imageSize, aspectRatio: '1:1' } },
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
    let r2Fallback = false;
    let ossFallback = false;
    if (imagePart?.inlineData) {
        // Phase 2/3:客户 OSS → 平台 R2 → data URL 内联,三级降级(请求不失败)
        const { mimeType, data } = imagePart.inlineData;
        const buffer = Buffer.from(data, 'base64');
        const ext = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';
        const key = `gen/${randomUUID()}.${ext}`;

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

        if (customerUrl) {
            content = `![image](${customerUrl})`;
        } else {
            try {
                const url = await uploadImage(key, buffer, mimeType);
                content = `![image](${url})`;
            } catch (e) {
                console.warn('[v1-proxy] R2 upload failed, falling back to inline data URL', e);
                r2Fallback = true;
                content = `![image](data:${mimeType};base64,${data})`;
            }
        }
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
    if (ossFallback) respHeaders['X-Silkroadai-Oss-Fallback'] = 'yes';
    if (r2Fallback) respHeaders['X-Silkroadai-R2-Fallback'] = 'yes';
    return NextResponse.json(openaiResp, { status: 200, headers: respHeaders });
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

    // 其他路径(/messages /images/generations /models /embeddings …)全部透传
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
