'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import PayPageLayout from '@/components/PayPageLayout';
import SimplePricing from '@/components/admin/SimplePricing';
import { resolveLocale } from '@/lib/locale';

function PricingContent() {
    const searchParams = useSearchParams();
    const isDark = searchParams.get('theme') === 'dark';
    const isEmbedded = (searchParams.get('ui_mode') || 'standalone') === 'embedded';
    const locale = resolveLocale(searchParams.get('lang'));
    const en = locale === 'en';

    return (
        <PayPageLayout
            isDark={isDark}
            isEmbedded={isEmbedded}
            maxWidth="full"
            title={en ? 'Pricing' : '模型定价'}
            subtitle={
                en
                    ? 'One base price per model, one ratio per tier — saved straight to new-api'
                    : '每个模型一个基础价，每个档次一个倍率 —— 保存即写入 new-api'
            }
            locale={locale}
        >
            <SimplePricing isDark={isDark} en={en} />
        </PayPageLayout>
    );
}

function PricingPageFallback() {
    const searchParams = useSearchParams();
    const locale = resolveLocale(searchParams.get('lang'));

    return (
        <div className="flex min-h-screen items-center justify-center">
            <div className="text-slate-500">{locale === 'en' ? 'Loading...' : '加载中...'}</div>
        </div>
    );
}

export default function PricingPage() {
    return (
        <Suspense fallback={<PricingPageFallback />}>
            <PricingContent />
        </Suspense>
    );
}
