import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    output: 'standalone',
    serverExternalPackages: ['wechatpay-node-v3'],
};

export default nextConfig;
