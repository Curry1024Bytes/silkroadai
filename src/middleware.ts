import { NextRequest, NextResponse } from 'next/server';

/**
 * Default-deny security headers for every response.
 *
 * W5 D2 dropped the W1 sub2apipay iframe-allow CSP segment (frame-ancestors
 * with LITELLM_BASE_URL / IFRAME_ALLOW_ORIGINS). The portal is now standalone
 * — no iframe embedding from sub2apipay anymore — so the strict default
 * (X-Frame-Options=SAMEORIGIN) is correct and the dynamic CSP build was
 * dead code.
 */
export function middleware(request: NextRequest) {
    // 独立门户形态(PORTAL_FLAVOR=seedance-enterprise 实例):主站页面/API 默认 404 ——
    // 大客户实例只暴露 /v1 视频端点(matcher 排除,由 enterprise/proxy 分发)+ 下列白名单:
    //  - /enterprise/*   P2 dashboard(登录 + 概览/计费/日志/密钥/素材库)
    //  - /api/auth/{login,logout}   cookie 会话(企业登录页复用主站 JWT 会话)
    //  - /api/enterprise/*          dashboard 的客户 API(keys 管理等)
    //  - /api/admin/enterprise/*    admin break-glass(x-admin-token,VPS 本机 curl)
    //  - /login → 302 /enterprise/login(next.config 把 / 先 307 到 /login,借道进门)
    // 主站实例(env 未设)零影响。
    if (process.env.PORTAL_FLAVOR === 'seedance-enterprise') {
        const p = request.nextUrl.pathname;
        if (p === '/login' || p === '/') {
            return NextResponse.redirect(new URL('/enterprise/login', request.url));
        }
        const allowed =
            p === '/enterprise' ||
            p.startsWith('/enterprise/') ||
            p === '/api/auth/login' ||
            p === '/api/auth/logout' ||
            p.startsWith('/api/enterprise/') ||
            p.startsWith('/api/admin/enterprise/');
        if (!allowed) return new NextResponse(null, { status: 404 });
    }
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
    // v1beta/* 同理:Gemini native 透传(W10),inlineData 大图 base64 必须避开
    // 10MB 缓冲截断;`v1/` 的负向断言匹配不到 `v1beta/`(v1b ≠ v1/),要单列。
    // api/tools/* 一并排除:工具箱各工具的客户提交入口(seedance 图生视频 submit /
    // 生图 edit / chat 图片上传)body 里带参考图 base64,>10MB 会被 middleware 缓冲
    // 截断 → new-api 收到残缺 JSON,报 "unexpected end of JSON input"(2026-07-05
    // 客户 seedance 图生视频实测)。纯 API 中继,不需页面安全头。
    matcher: ['/((?!v1/|v1beta/|seedance-adapter/|api/tools/|_next/static|_next/image|favicon.ico).*)'],
};
