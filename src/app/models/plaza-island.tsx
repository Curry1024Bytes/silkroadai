'use client';
/**
 * 模型广场客户端岛(2026-10-22)。
 *
 * 把 vendored new-api pricing feature 挂进 portal:QueryClient + i18n + 运行时
 * 配置(货币 / API 地址)+ `.newapi-plaza` 主题作用域。整个岛 `ssr:false`
 * 由 page.tsx 动态加载 —— 上游代码依赖 window / localStorage,不做 SSR。
 */
import { useEffect, useMemo, useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@newapi/i18n/config';
import { useLocale } from '@/lib/i18n/client';
import { Pricing } from '@newapi/features/pricing';
import { PortalContainerContext } from '@newapi/components/ui/portal-container';
import { usePlazaRuntime, type PlazaRuntimeConfig } from '@newapi/lib/plaza-runtime';
import { useSystemConfigStore } from '@newapi/stores/system-config-store';

export interface PlazaIslandProps {
    runtime: PlazaRuntimeConfig;
}

export default function PlazaIsland({ runtime }: PlazaIslandProps) {
    // Follow the portal locale (cookie) instead of the vendored default `zhCN`.
    // Resources are bundled, so changeLanguage is synchronous; doing it during
    // render (guarded) avoids a one-frame Chinese flash before an effect runs.
    const locale = useLocale();
    const lng = locale === 'en' ? 'en' : 'zhCN';
    if (i18n.language !== lng) void i18n.changeLanguage(lng);
    const client = useMemo(
        () =>
            new QueryClient({
                defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 60_000 } },
            }),
        [],
    );
    const containerRef = useRef<HTMLDivElement | null>(null);
    const setRuntime = usePlazaRuntime((s) => s.setConfig);
    const setSystemConfig = useSystemConfigStore((s) => s.setConfig);
    useEffect(() => {
        setRuntime(runtime);
        setSystemConfig({
            systemName: runtime.system_name,
            currency: {
                displayInCurrency: runtime.display_in_currency,
                quotaDisplayType: runtime.quota_display_type,
                quotaPerUnit: runtime.quota_per_unit,
                usdExchangeRate: runtime.usd_exchange_rate,
                customCurrencySymbol: runtime.custom_currency_symbol,
                customCurrencyExchangeRate: runtime.custom_currency_exchange_rate,
            },
        });
    }, [runtime, setRuntime, setSystemConfig]);

    return (
        <div className="newapi-plaza" ref={containerRef}>
            <QueryClientProvider client={client}>
                <PortalContainerContext.Provider value={containerRef}>
                    <Pricing />
                </PortalContainerContext.Provider>
            </QueryClientProvider>
        </div>
    );
}
