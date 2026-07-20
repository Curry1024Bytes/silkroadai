import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    output: 'standalone',
    // undici 外置:instrumentation.ts 用它给 Node fetch 设 600s headersTimeout(慢生图)。
    serverExternalPackages: ['wechatpay-node-v3', 'undici'],
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
                destination: '/login',
                permanent: false,
            },
        ];
    },
};

export default nextConfig;
