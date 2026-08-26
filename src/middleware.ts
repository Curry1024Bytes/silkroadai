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
    const pathname = request.nextUrl.pathname;
    const isEnterprise = process.env.PORTAL_FLAVOR === 'seedance-enterprise';
    // 火山官方 Action API 形态兼容(2026-08-02,仅企业实例):官方 endpoint 是根路径
    // `/?Action=…`(官方 SDK 默认拼 path "/";客户把 base 配成 …/api 时客户端也会拼出
    // /api/)。两种都 rewrite 到 /api(rewrite 非 redirect,POST body 不丢)。原始 path
    // 经内部头传给 route —— AK/SK SignerV4 验签必须用客户实际签名的 path,rewrite 后
    // 不还原会把签名用户全打成 401(也因此 /api/ 不能走下面的尾斜杠 308:redirect 会
    // 改 path,签名同样作废)。根路径仅带 Action query 时改写,浏览器访问 / 照旧跳登录。
    // 注意:根路径形态还依赖 next.config 的 / → /login redirect 对带 Action 的请求放行
    // (config redirects 跑在 middleware 之前),两处必须配套。
    if (isEnterprise && (pathname === '/api/' || (pathname === '/' && request.nextUrl.searchParams.has('Action')))) {
        // 用普通 URL 构造(不 clone nextUrl):NextURL 会记住原路径的尾斜杠标志,
        // pathname 赋值后序列化仍被补回 /api/,rewrite 就白做了。
        const url = new URL('/api' + request.nextUrl.search, request.url);
        const headers = new Headers(request.headers);
        headers.set('x-enterprise-orig-path', pathname);
        return NextResponse.rewrite(url, { request: { headers } });
    }
    // next.config skipTrailingSlashRedirect=true 关掉了框架内置尾斜杠 308(为让上面的
    // /api/ rewrite 先于重定向拿到请求)—— 这里复刻默认行为,主站/企业其余路径不变。
    if (pathname.length > 1 && pathname.endsWith('/')) {
        return NextResponse.redirect(new URL(pathname.slice(0, -1) + request.nextUrl.search, request.url), 308);
    }
    if (isEnterprise) {
        const p = pathname;
        if (p === '/login' || p === '/') {
            return NextResponse.redirect(new URL('/enterprise/login', request.url));
        }
        const allowed =
            p === '/enterprise' ||
            p.startsWith('/enterprise/') ||
            p === '/enterprise-admin' || // 运营后台(superadmin session 守门)
            p.startsWith('/enterprise-admin/') ||
            p === '/api' || // P3 素材库 Action API(火山形 /api?Action=…,sk-ent 鉴权)
            p.startsWith('/api/v3/') || // 火山方舟形视频 API(/api/v3/contents/generations/tasks)
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
    // api/enterprise/assets 一并排除:P3 dashboard 素材上传(multipart 视频可 >10MB,
    // 避开 middleware body 缓冲截断)。纯 API(cookie 鉴权在 route 内),不需页面安全头。
    // api/v3/* 一并排除:火山方舟形视频提交(2026-07-26)body 带参考图 base64 可能 >10MB。
    // image-adapter/* 一并排除:按张计费图片上游适配器(W10),edits multipart 带 4K 输入图
    // 轻松 >10MB,必须避开 middleware body 缓冲截断。纯内部 API 中继,不需页面安全头。
    // minimax-adapter/* 一并排除:MiniMax-H3 视频中继(2026-08-26),参考图 data URL base64
    // 可能 >10MB,同样避开 middleware body 缓冲截断。纯内部 API 中继,不需页面安全头。
    matcher: [
        '/((?!v1/|v1beta/|seedance-adapter/|image-adapter/|minimax-adapter/|api/tools/|api/enterprise/assets|api/v3/|_next/static|_next/image|favicon.ico).*)',
    ],
};
