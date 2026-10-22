/**
 * Public /models — 模型广场(2026-10-22)。
 *
 * 用 vendored new-api 模型广场(src/vendor/newapi-web,AGPL,见其 NOTICE.md)
 * 替换 W6 D3 的自写清单页。页面壳(返回首页 / Logo)由 portal SSR,广场本体是
 * `ssr:false` 的客户端岛,数据走 /api/portal/models/* 代理。
 *
 * 货币与 API 地址等运行时配置在这里服务端读 new-api `/api/status`(公开,60s
 * 缓存),失败时退回与线上一致的默认值,页面不白屏。
 */
import Link from 'next/link';
import { Logo } from '@/components/brand/Logo';
import { PlazaLoader } from './plaza-loader';
import { loadPlazaRuntime } from './runtime';

// 运行时配置来自 new-api `/api/status`(server-side 60s memo,见 runtime.ts),页面按需渲染。
export const dynamic = 'force-dynamic';
export const metadata = {
    title: '模型广场 — Silk Road AI',
    description: 'Silk Road AI 当前接入的全部模型:按供应商 / 分组 / 类型 / 标签筛选,对比价格、端点与近 24 小时可用性。',
};

export default async function ModelsPage() {
    const runtime = await loadPlazaRuntime();
    return (
        <main className="min-h-screen bg-paper">
            <div className="mx-auto max-w-[1800px] px-4 pt-8 sm:px-6 xl:px-8">
                <header className="flex flex-col gap-3">
                    <Link
                        href="/"
                        className="inline-flex w-fit items-center gap-1 text-xs text-muted-ink no-underline transition-colors duration-150 ease-brand hover:text-brand-accent"
                    >
                        <span aria-hidden="true">←</span>
                        <span>返回首页</span>
                    </Link>
                    <div className="flex items-center gap-3">
                        <Logo variant="primary-flat" size={28} />
                        <p className="m-0 text-xs text-minor-ink">Connecting Global Intelligence.</p>
                    </div>
                </header>
            </div>
            <PlazaLoader runtime={runtime} />
        </main>
    );
}
