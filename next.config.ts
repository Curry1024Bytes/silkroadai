import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    output: 'standalone',
    // undici 外置:instrumentation.ts 用它给 Node fetch 设 600s headersTimeout(慢生图)。
    serverExternalPackages: ['wechatpay-node-v3', 'undici'],
    // 企业实例 Action API 兼容(2026-08-02):框架内置尾斜杠 308 跑在 middleware 之前,
    // 会把 /api/?Action=…(火山官方客户端形态)重定向到 /api —— SignerV4 客户签的是
    // /api/,重定向后 path 变了必 401。关掉内置重定向,由 middleware 统一处理:
    // /api/ rewrite 到 /api(保留原始 path 供验签),其余尾斜杠路径 middleware 复刻
    // 同样的 308(主站行为不变,见 src/middleware.ts)。
    skipTrailingSlashRedirect: true,
    // 落地页暂时下线(设计待重做):silkroadai.io/ 直接进控制台登录页。
    // 落地页代码完整保留在 src/app/page.tsx,恢复 = 删掉本 redirects()(不用动文件)。
    // - ?invite=X 旧式邀请链接 → /register(保留 reseller 归因;register 挂了
    //   InviteCodeBridge 会捕获)。query 由 Next 自动透传到 destination。
    // - 其余(含 OAuth 失败回跳的 ?oauth_error=)→ /login(登录页已能渲染该 banner)。
    async redirects() {
        return [
            {
                source: '/',
                has: [{ type: 'query', key: 'invite' }],
                destination: '/register',
                permanent: false,
            },
            {
                source: '/',
                // 带 Action query 的根路径请求(火山官方 SDK 形态 /?Action=…)不重定向,
                // 放行给 middleware rewrite 到 /api(config redirects 跑在 middleware 之前)。
                // 主站几乎不可能有带 ?Action 的浏览器访问,残余影响 = 渲染已下线落地页。
                missing: [{ type: 'query', key: 'Action' }],
                destination: '/login',
                permanent: false,
            },
        ];
    },
};

export default nextConfig;
