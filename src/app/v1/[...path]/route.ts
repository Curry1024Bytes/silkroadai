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
 *      响应转回 OpenAI chat.completion 格式,图片以 markdown data URL 内联
 *      (Phase 2 改 R2 上传返 URL)。
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
 * - 不读不写 portal DB。
 * - 回滚 = Caddy reverse_proxy 切回 new-api :3000(见 handoff 1.3)。
 */
import { NextRequest, NextResponse } from 'next/server';

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

/** OpenAI message content(string 或 multimodal array)→ Gemini parts。Phase 1 只支持 text。 */
function toGeminiContents(messages: unknown): Array<{ role: string; parts: Array<{ text: string }> }> {
    if (!Array.isArray(messages)) return [];
    return messages.map((m) => {
        const msg = (m ?? {}) as JsonRecord;
        const content = msg.content;
        let text: string;
        if (typeof content === 'string') {
            text = content;
        } else if (Array.isArray(content)) {
            // Phase 1:multimodal array 只取 text 项(image_url 在 Phase 2 支持)
            text = content
                .map((item) => {
                    const it = (item ?? {}) as JsonRecord;
                    return it.type === 'text' && typeof it.text === 'string' ? it.text : '';
                })
                .filter(Boolean)
                .join('\n');
        } else {
            text = '';
        }
        return {
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text }],
        };
    });
}

interface GeminiPart {
    text?: string;
    inlineData?: { mimeType: string; data: string };
}

async function handleGeminiImage(req: NextRequest, body: JsonRecord, model: string): Promise<NextResponse> {
    const imageSize = GEMINI_IMAGE_MODELS[model];
    const contents = toGeminiContents(body.messages);

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
    if (imagePart?.inlineData) {
        // Phase 1:data URL 内联(Phase 2 改 R2 上传返 https URL)
        const { mimeType, data } = imagePart.inlineData;
        content = `![image](data:${mimeType};base64,${data})`;
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

    return NextResponse.json(openaiResp, {
        status: 200,
        headers: { 'X-Silkroadai-Translated': 'gemini-native' },
    });
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
