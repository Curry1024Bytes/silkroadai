'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import PayPageLayout from '@/components/PayPageLayout';
import SimplePricing from '@/components/admin/SimplePricing';
import SaleRules from '@/components/admin/SaleRules';
import { resolveLocale, type Locale } from '@/lib/locale';

/**
 * 两个标签,对应两条真实的改价路径:
 *  - 现有定价:模型基础价 + 档次倍率,同步写 new-api 并回读核对。日常改价走这里。
 *  - 售卖规则:按客户/模型的折扣,编译成分组倍率。未纳管任何计费分组时只是只读视图。
 * 原「按成本加价」与「发布任务」走 V1–V7 签名发布链路,2026-11-08 已连同该链路拆除
 * (见 docs/2026-11-08-拆除签名发布链路.md):它的持久化核验只接受 mysql://,而生产
 * new-api 是 PostgreSQL,调度器也从未启动,三张发布表一直是空的。
 */
type PricingSection = 'simple' | 'rules';

function PricingWorkspace({
    isDark,
    locale,
    initialSection,
}: {
    isDark: boolean;
    locale: Locale;
    initialSection: PricingSection;
}) {
    const en = locale === 'en';
    const [section, setSection] = useState<PricingSection>(initialSection);

    const tabClass = (active: boolean) =>
        `min-h-11 rounded-lg border px-4 py-2 text-sm font-medium ${active ? 'border-emerald-600 bg-emerald-600 text-white' : isDark ? 'border-slate-600 text-slate-200 hover:bg-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-100'}`;

    return (
        <div>
            <p className={`mb-4 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {en
                    ? 'Customer price = model price × tier ratio. Change one model in Model base prices; change a whole tier in Tiers & margin. A single model priced differently inside one tier needs its own billing group.'
                    : '客户实付 = 模型价格 × 档次倍率。改单个模型:「模型基础价」;改整档:「档次与利润」。某模型要在某档单独定价,只能给它拆独立计费分组。'}
            </p>
            <div role="tablist" aria-label={en ? 'Pricing tools' : '定价工具'} className="mb-5 flex flex-wrap gap-2">
                {(
                    [
                        ['simple', en ? 'Current pricing' : '现有定价'],
                        ['rules', en ? 'Sale rules' : '售卖规则'],
                    ] as const
                ).map(([key, label]) => (
                    <button
                        key={key}
                        type="button"
                        role="tab"
                        id={`pricing-section-${key}`}
                        aria-controls={`pricing-section-panel-${key}`}
                        aria-selected={section === key}
                        tabIndex={section === key ? 0 : -1}
                        onClick={() => setSection(key)}
                        className={tabClass(section === key)}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <div
                id="pricing-section-panel-simple"
                role="tabpanel"
                aria-labelledby="pricing-section-simple"
                hidden={section !== 'simple'}
            >
                <SimplePricing isDark={isDark} en={en} />
            </div>
            <div
                id="pricing-section-panel-rules"
                role="tabpanel"
                aria-labelledby="pricing-section-rules"
                hidden={section !== 'rules'}
            >
                {section === 'rules' && <SaleRules isDark={isDark} />}
            </div>
        </div>
    );
}

function PricingContent() {
    const searchParams = useSearchParams();
    const isDark = searchParams.get('theme') === 'dark';
    const isEmbedded = (searchParams.get('ui_mode') || 'standalone') === 'embedded';
    const locale = resolveLocale(searchParams.get('lang'));
    const en = locale === 'en';
    // Links to the removed tabs (view=cost / view=jobs) land on the live one.
    const initialSection: PricingSection = searchParams.get('view') === 'rules' ? 'rules' : 'simple';

    return (
        <PayPageLayout
            isDark={isDark}
            isEmbedded={isEmbedded}
            maxWidth="full"
            title={en ? 'Pricing' : '模型定价'}
            subtitle={en ? 'Manage customer prices and sale rules' : '管理客户售价与售卖规则'}
            locale={locale}
        >
            <PricingWorkspace isDark={isDark} locale={locale} initialSection={initialSection} />
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
