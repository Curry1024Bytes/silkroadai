/**
 * /gpu — public GPU rental landing page (W7 PR-P).
 *
 * Server-rendered, no client JS. Reads structured data from
 * `src/data/gpu-pricing.ts` and copy from `src/i18n/gpu-page.ts`
 * so the operator can edit price ranges / advantages / customer
 * types / contact strings without touching this file.
 *
 * Sections (in render order):
 *   1. Hero               — title + subtitle + WeChat CTA + abstract icon
 *   2. Pricing cards      — 3 SKUs (H100 / H200 / B300) via PricingCardsGrid
 *   3. Service flow       — 4 steps via ServiceFlow
 *   4. Resource advantages — 3 bullets
 *   5. Customer types     — 4 chip grid
 *   6. Contact + footer   — WeChat / email / overseas note + back link
 *
 * SEO:
 *   - Indexable (allowed in robots.ts via the wildcard rule with no
 *     /gpu disallow). Listed in sitemap.xml priority 0.7.
 *   - meta tags: title / description / keywords + og:* set below.
 */
import Link from 'next/link';
import { BackButton } from '@/components/BackButton';
import type { Metadata } from 'next';
import { Logo } from '@/components/brand/Logo';
import { PricingCardsGrid } from '@/components/gpu/PricingCard';
import { ServiceFlow } from '@/components/gpu/ServiceFlow';
import { ADVANTAGES, CONTACT, CUSTOMER_TYPES } from '@/data/gpu-pricing';
import { t } from '@/i18n/gpu-page';

export const metadata: Metadata = {
    title: 'GPU 租赁 — H100 / H200 / B300 算力中心 | LLmRoute',
    description:
        '专属 GPU 算力租赁:H100 80GB / H200 141GB / B300 288GB,月起 ¥80,000 起。' +
        '面向 AI 创业 / 模型训练 / 企业 R&D 团队,对接东数西算多区域算力中心。微信 Global_Ads 询价。',
    keywords: [
        'GPU 租赁',
        'H100 租赁',
        'H200 租赁',
        'B300',
        'AI 算力',
        'AI 算力租赁',
        '东数西算',
        '模型训练 GPU',
        'AI 创业',
        '私有化推理',
        'LLmRoute',
    ],
    openGraph: {
        title: 'GPU 租赁 — H100 / H200 / B300 算力中心',
        description: '专属 GPU 算力租赁:H100 80GB / H200 141GB / B300 288GB。AI 创业 / 训练 / 推理团队定制方案。',
        url: '/gpu',
        type: 'website',
    },
    twitter: {
        card: 'summary',
        title: 'GPU 租赁 — LLmRoute',
        description: 'H100 / H200 / B300 算力租赁。月起 ¥80,000 起。微信 Global_Ads 询价。',
    },
    alternates: {
        canonical: '/gpu',
    },
};

const SECTION_MAX = 1120;

function Section({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
    return (
        <section
            style={{
                width: '100%',
                ...style,
            }}
        >
            <div
                style={{
                    maxWidth: SECTION_MAX,
                    margin: '0 auto',
                    padding: '0 24px',
                }}
            >
                {children}
            </div>
        </section>
    );
}

/** Compact landing-style header — same shape as `/login`'s warm-paper card
 *  surface but full-bleed for the marketing feel. */
function PageHeader() {
    return (
        <header className="bg-paper border-b border-brand-border">
            <div
                style={{
                    maxWidth: SECTION_MAX,
                    margin: '0 auto',
                    padding: '14px 24px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 16,
                }}
            >
                <Logo variant="primary-flat" size={28} />
                <nav style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 14, flexWrap: 'wrap' }}>
                    <Link href="/" style={{ color: 'var(--color-muted-ink)', textDecoration: 'none' }}>
                        首页
                    </Link>
                    {/* W7 D4 PR-Q — single primary CTA replaces the prior trio
                     *  (首页 / API 价格 / 注册). /pricing is not yet built so
                     *  the old "API 价格" 404'd; "注册" alone read as scattered.
                     *  "API 控制台" is the unified entry — /portal/register
                     *  for guests, the existing W3 redirect bounces signed-in
                     *  users to /dashboard. Brand-accent solid for the highest
                     *  visual weight in the page chrome. */}
                    <Link
                        href="/portal/register"
                        style={{
                            color: 'var(--color-paper)',
                            textDecoration: 'none',
                            fontWeight: 600,
                            background: 'var(--color-brand-accent)',
                            borderRadius: 6,
                            padding: '8px 16px',
                        }}
                    >
                        API 控制台
                    </Link>
                </nav>
            </div>
        </header>
    );
}

/** Hero — title + subtitle + CTA + abstract compute SVG. */
function Hero() {
    return (
        <Section style={{ padding: '64px 0 48px' }}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-10 items-center">
                <div>
                    {/* W7 D4 PR-R Item D — back-to-landing affordance
                     *  above the h1. The page chrome already has a 首页
                     *  link on the right, but visitors arriving from a
                     *  search-result deep link or a sales-engineer
                     *  shared URL benefit from a left-aligned ← arrow
                     *  next to the hero title (matches /models /docs). */}
                    <BackButton className="inline-flex items-center gap-1 mb-4 text-xs text-muted-ink hover:text-brand-accent transition-colors duration-150 ease-brand no-underline w-fit cursor-pointer border-0 bg-transparent p-0">
                        <span aria-hidden="true">←</span>
                        <span>返回</span>
                    </BackButton>
                    <h1 className="m-0 text-4xl md:text-5xl font-semibold text-navy" style={{ lineHeight: 1.2 }}>
                        {t('hero_title')}
                    </h1>
                    <p className="m-0 mt-5 text-lg text-muted-ink" style={{ lineHeight: 1.6 }}>
                        {t('hero_subtitle')}
                    </p>
                    <div className="mt-7 flex flex-wrap items-center gap-3">
                        <a
                            href="#contact"
                            className="inline-flex items-center justify-center px-6 py-3 text-base font-medium rounded-lg bg-navy text-paper hover:bg-navy-strong transition-colors duration-150 ease-brand no-underline"
                        >
                            {t('hero_cta')} →
                        </a>
                        <span className="text-sm text-minor-ink">
                            {t('hero_cta_hint')}{' '}
                            <code className="font-mono px-2 py-0.5 bg-paper-muted rounded text-navy">
                                {CONTACT.wechat}
                            </code>
                        </span>
                    </div>
                </div>
                <div className="hidden md:flex justify-center">
                    {/* Abstract compute / GPU mark — pure SVG, no external asset.
                        Stylized stack of three rack units in brand colors, with a
                        glow accent at the top to suggest active compute. */}
                    <svg width="280" height="240" viewBox="0 0 280 240" role="img" aria-label="GPU 算力示意">
                        <defs>
                            <linearGradient id="gpu-rack-glow" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#0E1A2A" stopOpacity="0.65" />
                                <stop offset="100%" stopColor="#0E1A2A" stopOpacity="0" />
                            </linearGradient>
                        </defs>
                        <rect x="50" y="40" width="180" height="160" rx="12" fill="#1D1D1F" />
                        <rect x="60" y="55" width="160" height="40" rx="6" fill="#FFFFFF" opacity="0.08" />
                        <rect x="60" y="100" width="160" height="40" rx="6" fill="#FFFFFF" opacity="0.08" />
                        <rect x="60" y="145" width="160" height="40" rx="6" fill="#FFFFFF" opacity="0.08" />
                        <rect x="70" y="65" width="100" height="20" rx="3" fill="#0E1A2A" opacity="0.85" />
                        <rect x="70" y="110" width="80" height="20" rx="3" fill="#0E1A2A" opacity="0.65" />
                        <rect x="70" y="155" width="120" height="20" rx="3" fill="#0E1A2A" opacity="0.45" />
                        <circle cx="200" cy="75" r="3" fill="#0E1A2A" />
                        <circle cx="200" cy="120" r="3" fill="#0E1A2A" opacity="0.6" />
                        <circle cx="200" cy="165" r="3" fill="#0E1A2A" opacity="0.4" />
                        <rect x="50" y="30" width="180" height="20" fill="url(#gpu-rack-glow)" rx="12" />
                    </svg>
                </div>
            </div>
        </Section>
    );
}

/** Section 2 — 3 SKU pricing cards */
function PricingSection() {
    return (
        <Section style={{ padding: '48px 0', background: 'var(--color-paper-muted)' }}>
            <h2 className="m-0 text-3xl font-semibold text-navy text-center">{t('pricing_section_title')}</h2>
            <p className="m-0 mt-3 text-base text-muted-ink text-center max-w-2xl mx-auto">
                {t('pricing_section_subtitle')}
            </p>
            <div className="mt-9">
                <PricingCardsGrid />
            </div>
        </Section>
    );
}

/** Section 3 — 4-step service flow */
function FlowSection() {
    return (
        <Section style={{ padding: '64px 0' }}>
            <h2 className="m-0 text-3xl font-semibold text-navy text-center">{t('flow_section_title')}</h2>
            <p className="m-0 mt-3 text-base text-muted-ink text-center">{t('flow_section_subtitle')}</p>
            <div className="mt-9">
                <ServiceFlow />
            </div>
        </Section>
    );
}

/** Section 4 — 3 resource advantages */
function AdvantagesSection() {
    return (
        <Section style={{ padding: '48px 0', background: 'var(--color-paper-muted)' }}>
            <h2 className="m-0 text-3xl font-semibold text-navy text-center">{t('advantages_section_title')}</h2>
            <div className="mt-9 grid grid-cols-1 md:grid-cols-3 gap-6">
                {ADVANTAGES.map((adv) => (
                    <article
                        key={adv.id}
                        className="px-6 py-6 rounded-xl bg-surface border border-brand-border shadow-card"
                    >
                        <h3 className="m-0 text-lg font-semibold text-navy">{adv.title}</h3>
                        <p className="m-0 mt-2 text-sm text-muted-ink leading-relaxed">{adv.body}</p>
                    </article>
                ))}
            </div>
        </Section>
    );
}

/** Section 5 — customer types */
function CustomersSection() {
    return (
        <Section style={{ padding: '64px 0' }}>
            <h2 className="m-0 text-3xl font-semibold text-navy text-center">{t('customers_section_title')}</h2>
            <p className="m-0 mt-3 text-base text-muted-ink text-center max-w-2xl mx-auto">
                {t('customers_section_subtitle')}
            </p>
            <ul className="mt-8 list-none p-0 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 max-w-4xl mx-auto">
                {CUSTOMER_TYPES.map((c) => (
                    <li
                        key={c}
                        className="px-4 py-3 rounded-lg bg-paper-muted text-sm text-navy text-center font-medium"
                    >
                        {c}
                    </li>
                ))}
            </ul>
        </Section>
    );
}

/** Section 6 — contact + footer note */
function ContactSection() {
    return (
        <Section
            style={{
                padding: '48px 0 80px',
                borderTop: '1px solid var(--color-brand-border)',
            }}
        >
            <div id="contact">
                <h2 className="m-0 text-2xl font-semibold text-navy text-center">{t('contact_section_title')}</h2>
                <div className="mt-6 max-w-md mx-auto text-center text-base text-muted-ink space-y-2.5">
                    <p className="m-0">
                        <strong className="text-navy">{t('contact_wechat_label')}</strong>:{' '}
                        <code className="font-mono px-2 py-0.5 bg-paper-muted rounded text-navy">{CONTACT.wechat}</code>
                    </p>
                    <p className="m-0">
                        <strong className="text-navy">{t('contact_email_label')}</strong>:{' '}
                        <a
                            href={`mailto:${CONTACT.email}`}
                            className="text-navy no-underline hover:text-brand-accent transition-colors"
                            style={{ borderBottom: '1px dotted currentColor' }}
                        >
                            {CONTACT.email}
                        </a>
                    </p>
                    <p className="m-0 text-sm text-minor-ink">{CONTACT.overseasNote}</p>
                </div>
                <p className="mt-10 text-center text-sm text-minor-ink">
                    <Link href="/" className="text-muted-ink hover:text-brand-accent transition-colors no-underline">
                        {t('contact_back_to_landing')}
                    </Link>
                </p>
            </div>
        </Section>
    );
}

export default function GpuPage() {
    return (
        <main style={{ background: 'var(--color-paper)', minHeight: '100vh' }}>
            <PageHeader />
            <Hero />
            <PricingSection />
            <FlowSection />
            <AdvantagesSection />
            <CustomersSection />
            <ContactSection />
        </main>
    );
}
