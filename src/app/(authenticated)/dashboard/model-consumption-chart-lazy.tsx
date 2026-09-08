'use client';

/**
 * ModelConsumptionChart 的懒加载壳(P2 2026-08-29)。
 *
 * recharts 是 dashboard 路由客户端 bundle 里最大的一块,而它的 SSR 输出
 * 近乎空壳(ResponsiveContainer 要真 DOM 量宽度)。next/dynamic + ssr:false
 * 把 recharts 拆出关键 JS:首屏 HTML 放等高占位(与图表卡同壳,补入不
 * 跳版),hydration 后另起 chunk 渲染图表,页面更快可交互。
 */
import dynamic from 'next/dynamic';
import type { ModelConsumptionChartProps } from './model-consumption-chart';

const LazyChart = dynamic(() => import('./model-consumption-chart').then((m) => m.ModelConsumptionChart), {
    ssr: false,
    loading: () => (
        <div className="rounded-xl border border-brand-border bg-surface p-4 shadow-card">
            <div aria-hidden className="h-[280px] w-full animate-pulse rounded-md bg-paper-muted" />
        </div>
    ),
});

export function ModelConsumptionChartLazy(props: ModelConsumptionChartProps) {
    return <LazyChart {...props} />;
}
