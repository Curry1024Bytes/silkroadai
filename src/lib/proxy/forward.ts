/**
 * 代理转发共享助手(/v1/* 与 /v1beta/* 两条透传路由共用)。
 * 从 src/app/v1/[...path]/route.ts 原样抽出 —— Next 的 route 文件只允许导出
 * handler,共享逻辑必须落 lib。行为零改动。
 */
import { NextRequest, NextResponse } from 'next/server';

export const HOP_BY_HOP_REQUEST_HEADERS = new Set([
    'host',
    'content-length',
    'connection',
    'keep-alive',
    'transfer-encoding',
]);

/** 不往客户端回传的响应头(body 已被改写/重新分块时这些头会撒谎) */
export const STRIP_RESPONSE_HEADERS = new Set([
    'content-length',
    'content-encoding',
    'transfer-encoding',
    'connection',
]);

/** 运行时可配置的额外剥离请求头(env `PROXY_STRIP_REQUEST_HEADERS`,逗号分隔,小写比较)。
 *  挡掉客户端注入、会干扰上游的头(如 kiro/Bedrock 上游因客户端带 profileArn 相关头而报
 *  "profileArn is required")。动态读 env → 改 .env + 重启即生效,无需重构建。 */
function extraStripRequestHeaders(): Set<string> {
    return new Set(
        (process.env.PROXY_STRIP_REQUEST_HEADERS || '')
            .split(',')
            .map((h) => h.trim().toLowerCase())
            .filter(Boolean),
    );
}

export function forwardHeaders(req: NextRequest): Headers {
    const extra = extraStripRequestHeaders();
    const headers = new Headers();
    req.headers.forEach((value, key) => {
        const lk = key.toLowerCase();
        if (!HOP_BY_HOP_REQUEST_HEADERS.has(lk) && !extra.has(lk)) headers.set(key, value);
    });
    return headers;
}

export function passthroughResponse(upstream: Response): NextResponse {
    const headers = new Headers();
    upstream.headers.forEach((value, key) => {
        if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
    });
    return new NextResponse(upstream.body, { status: upstream.status, headers });
}
