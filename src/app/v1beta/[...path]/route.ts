/**
 * /v1beta/* — Gemini 原生格式透传(native 面)。
 *
 * 背景:Caddy 目前把 `ai.silkroadai.io/v1beta/*` 直接送 new-api :3000,portal 完全
 * 看不见 —— 请求日志盲区(数据存储线 memory:≈6 直连调用/7d)、无 keep-alive、无
 * 失败观测。本路由补一条与 /v1/* 同款的轻量透传:forwardHeaders + reqlog capture +
 * stream-guard(shape=null:只做静默期 keep-alive 注释;Gemini native SSE 的错误事件
 * 格式不注入,上游错误照旧传播)。
 *
 * 【一个字节不改写】—— native 面的意义就是原汁原味(对齐 OpenRouter 的做法:OpenAI
 * 兼容面做归一,native 面直通)。finish_reason 归一、翻译、图床改写都只在 /v1/*。
 *
 * ⚠️ 部署配套(今晚维护窗口):
 *  1. Caddy `ai.silkroadai.io` 把 `@portalv1 path /v1/*` 扩成 `path /v1/* /v1beta/*`
 *     (或加同款第二条 matcher)→ portal :3002;切之前本路由无流量,纯 dormant。
 *  2. middleware.ts matcher 已同步排除 `v1beta/`(Next 对命中 middleware 的路由会
 *     buffer 请求体且 10MB 截断 —— Gemini native 的 inlineData 大图必炸,见 PR #113)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { forwardHeaders, passthroughResponse } from '@/lib/proxy/forward';
import { guardSseResponse } from '@/lib/sse/stream-guard';
import {
    beginCapture,
    captureResponse,
    captureJsonResponse,
    recordRequestBody,
    isMediaCaptureSkipped,
} from '@/lib/reqlog/capture';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** 与 /v1/* 一致:自托管 Node 忽略;Vercel 部署时的兜底上限。 */
export const maxDuration = 300;

const NEWAPI_BASE_URL = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';

/** Gemini native:model 在 URL 不在 body(/models/{model}:generateContent)。
 *  streamGenerateContent(?alt=sse)= 流式。 */
function parseGeminiPath(path: string): { model: string | null; streamed: boolean } {
    const m = path.match(/\/models\/([^:/]+):(\w+)/);
    return { model: m ? m[1] : null, streamed: (m?.[2] ?? '').toLowerCase().startsWith('stream') };
}

async function handleRequest(req: NextRequest, params: Promise<{ path: string[] }>): Promise<NextResponse> {
    const { path: segments } = await params;
    const path = '/' + (segments ?? []).join('/');
    const search = req.nextUrl.search || '';
    const pm = parseGeminiPath(path);

    // 请求日志捕获,与 /v1/* 同一开关/同一 best-effort 语义(见 capture.ts);
    // cap.path 带 /v1beta 前缀,日志里与 OpenAI 面区分。
    // - OPTIONS(CORS 预检)不记 —— 无业务语义,白占行数;
    // - REQUEST_LOGGING_SKIP_MEDIA 时跳过 image SKU(gemini-*-image-*):native 面
    //   inlineData 大图 base64 会整份进内存 + 无上限写 R2 log,text-only 开关必须
    //   在这里生效(镜像 /v1 chat 分支按模型 null cap 的做法)。
    const skipMedia = isMediaCaptureSkipped() && (pm.model?.includes('image') ?? false);
    const cap = req.method === 'OPTIONS' || skipMedia ? null : beginCapture(req, `/v1beta${path}`);

    // Gemini 原生 SDK 的三种鉴权都不走 Authorization 头:x-goog-api-key 头 /
    // ?key= query / x-api-key。归因合成成 Bearer 形喂给 resolveLogIdentity
    // (它按 /^Bearer (.+)$/ 抽 token 哈希),否则盲区行全是无主行,白补了盲区。
    if (cap && !cap.authHeader) {
        const nativeKey =
            req.headers.get('x-goog-api-key') || req.nextUrl.searchParams.get('key') || req.headers.get('x-api-key');
        if (nativeKey) cap.authHeader = `Bearer ${nativeKey}`;
    }

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    let outgoingBody: BodyInit | undefined;
    if (hasBody) {
        if (cap) {
            const raw = await req.text();
            recordRequestBody(cap, raw, pm.model, pm.streamed);
            outgoingBody = raw;
        } else {
            outgoingBody = req.body as unknown as BodyInit; // 开关 off:stream 直传,字节级不变
        }
    }

    let upstream: Response;
    try {
        upstream = await fetch(`${NEWAPI_BASE_URL}/v1beta${path}${search}`, {
            method: req.method,
            headers: forwardHeaders(req),
            body: outgoingBody,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });
    } catch (err) {
        // 上游不可达:Gemini native 错误形(客户端 SDK 按 error.status 分支)
        const body = {
            error: {
                code: 502,
                message: `upstream request failed: ${err instanceof Error ? err.message : String(err)}`,
                status: 'UNAVAILABLE',
            },
        };
        if (cap) captureJsonResponse(cap, 502, body);
        return NextResponse.json(body, { status: 502 });
    }

    // shape=null:只做 keep-alive(streamGenerateContent 的长静默同样会被 CF ~100s 掐),
    // 不注入错误事件 —— native 面错误语义原样传播。
    const guarded = guardSseResponse(upstream, { shape: null, label: `proxy/v1beta${path}` });
    return cap ? captureResponse(cap, guarded) : passthroughResponse(guarded);
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
/** CORS 预检必须透传:浏览器端 Gemini SDK(application/json + x-goog-api-key 必触发
 *  preflight)今天由 new-api 直接应答(204 + Access-Control-Allow-*,实测)。不导出
 *  OPTIONS 的话 Next 自动应答只带 Allow 头、无 CORS 头 → 今晚 Caddy 切流后浏览器
 *  客户端全灭。转发给 new-api 让它继续按原样应答。 */
export async function OPTIONS(req: NextRequest, ctx: RouteContext) {
    return handleRequest(req, ctx.params);
}
