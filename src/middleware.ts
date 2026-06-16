import { NextResponse } from 'next/server';

/**
 * Default-deny security headers for every response.
 *
 * W5 D2 dropped the W1 sub2apipay iframe-allow CSP segment (frame-ancestors
 * with LITELLM_BASE_URL / IFRAME_ALLOW_ORIGINS). The portal is now standalone
 * — no iframe embedding from sub2apipay anymore — so the strict default
 * (X-Frame-Options=SAMEORIGIN) is correct and the dynamic CSP build was
 * dead code.
 */
export function middleware() {
    const response = NextResponse.next();
    response.headers.set('X-Frame-Options', 'SAMEORIGIN');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    return response;
}

export const config = {
    // ⚠️ /v1/* 必须排除在 middleware 之外:Next 对命中 middleware 的路由会把请求体
    // 缓冲到 middlewareClientMaxBodySize(默认 10MB)再交给 handler,超出被截断 —
    // 客户给 /v1/images/edits 传 >10MB multipart(多参考图 2K 编辑)会拿到
    // 400 "invalid request body"(2026-06-11 实测;proxy 自身限制是单图 20MB,
    // 被框架层先挡)。/v1 是纯 API 中继,这三个页面向安全头对它无意义。
    // seedance-adapter/* 同 /v1/* 一并排除:内部视频中继端点,不需页面安全头,
    // 且要避开 middleware 的 10MB body 缓冲(Phase 2 参考图 base64 可能偏大)。
    matcher: ['/((?!v1/|seedance-adapter/|_next/static|_next/image|favicon.ico).*)'],
};
