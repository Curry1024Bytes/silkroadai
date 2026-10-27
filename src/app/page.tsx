/**
 * silkroadai.io public landing page (W7 D3 — Phase 6a).
 *
 * Server-rendered, no client JS, minimal third-party deps. The promo
 * banner + pricing-table strikethroughs flip automatically at the W7
 * promo boundary (`isPromoActive()` from `@/lib/promo`).
 *
 * Pre-W7 this route was a thin redirect to `/pay`. We preserve the one
 * piece of legacy behavior that mattered: OAuth callbacks redirect here
 * with `?oauth_error=<code>` on failure, so we surface that as a banner
 * rather than swallowing it. (Pre-W7 we forwarded the query string to
 * `/pay`; now the user lands here, sees the error, and chooses where to
 * go from the visible CTAs.)
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { BrandLogo } from '@/components/brand/BrandLogo';
// W8 D1.5 (2026-05-21): 新永久定价替换 W7 promo,landing 不再走 isPromoActive()。
// import { isPromoActive } from '@/lib/promo'; — 留作日后审计参考
import { InviteCodeBridge } from '@/components/marketing/InviteCodeBridge';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { pickMessages } from '@/lib/i18n';
import { getLocale } from '@/lib/i18n/server';
import { landingMessages, type LandingMessages } from '@/lib/i18n/messages/landing';

// Inter is loaded globally via `next/font/google` in `src/app/layout.tsx`
// (W7 P3) so the @theme `--font-sans` token resolves on every page. We
// no longer need a landing-local import.

export async function generateMetadata(): Promise<Metadata> {
    const m = pickMessages(landingMessages, await getLocale());
    return {
        title: m.meta.title,
        description: m.meta.description,
        keywords: m.meta.keywords,
        openGraph: {
            title: m.meta.ogTitle,
            description: m.meta.ogDescription,
            url: 'https://silkroadai.io',
            type: 'website',
            // SVG placeholder — designer ships final 1200×630 PNG in a follow-up;
            // most crawlers honor SVG (Twitter / Discord), Facebook prefers PNG so
            // a binary swap is on the W7 finish list.
            images: [{ url: 'https://silkroadai.io/og-image.svg', width: 1200, height: 630 }],
        },
    };
}

export default async function LandingPage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const [params, locale] = await Promise.all([
        searchParams ?? Promise.resolve<Record<string, string | string[] | undefined>>({}),
        getLocale(),
    ]);
    // Only the top-level page resolves the locale; every section below is a
    // sync component that receives `m` as a prop (see src/lib/i18n/README.md).
    const m = pickMessages(landingMessages, locale);
    const oauthError = typeof params.oauth_error === 'string' ? params.oauth_error : null;
    // W8 D1.5 (2026-05-21): W7 50% promo 已被永久新定价替换(¥0.5/¥1.5 抵 $1)。
    // promo 横幅 / "当前促销 · 海外模型 5 折" 副标 / PriceCell strikethrough 视觉
    // 全部下线。下方 PromoBanner/PricingTeaser 副标/PriceCell promo 分支变成
    // 不可达代码,留着待后 PR 清理。
    const promoActive = false;

    return (
        <main
            style={{
                background: 'var(--color-paper)',
                color: 'var(--color-ink)',
                lineHeight: 1.7,
                minHeight: '100vh',
            }}
        >
            {oauthError ? <OAuthErrorBanner code={oauthError} m={m} /> : null}
            {/* fix/invite-landing: capture `?invite=X` if a reseller link
             *  was shared as the old `silkroadai.io/?invite=X` form, so
             *  the register page can pick up the attribution on the
             *  customer's next navigation. No render — pure side effect. */}
            <InviteCodeBridge />
            <Header m={m} />
            <Hero m={m} />
            {promoActive ? <PromoBanner m={m} /> : null}
            <WhyUs m={m} />
            <HowItWorks m={m} />
            <Tools m={m} />
            <PricingTeaser promoActive={promoActive} m={m} />
            {/* W7 D4 PR-R Item B — the in-page <Trust /> prose row
             *  duplicated the global <Footer />'s contact + legal-link
             *  block (rendered by `src/app/layout.tsx` on every page).
             *  Operator visual feedback flagged the repetition; the
             *  global footer covers it once. The horizontal divider
             *  Trust used as its top border was also incidental — we
             *  rely on the footer's own `border-t` instead. */}
        </main>
    );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Layout primitives                                                    */
/* ──────────────────────────────────────────────────────────────────── */

const SECTION_MAX = 1120;

function Section({ children, style, id }: { children: React.ReactNode; style?: React.CSSProperties; id?: string }) {
    return (
        <section id={id} style={{ width: '100%', ...style }}>
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

/* ──────────────────────────────────────────────────────────────────── */
/* Header                                                                */
/* ──────────────────────────────────────────────────────────────────── */

function Header({ m }: { m: LandingMessages }) {
    return (
        <header
            style={{
                background: 'var(--color-paper)',
                borderBottom: '1px solid var(--color-brand-border)',
                position: 'sticky',
                top: 0,
                zIndex: 50,
                backdropFilter: 'saturate(180%) blur(8px)',
            }}
        >
            <div
                style={{
                    maxWidth: SECTION_MAX,
                    margin: '0 auto',
                    padding: '14px 24px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 12,
                }}
            >
                {/* `Logo` wraps in `<Link href="/">` itself (default `linkHome={true}`).
                 *  Use `primary-flat` because at 28px the gradient on `primary` aliases
                 *  on small screens; per the asset cheatsheet the flat variant is the
                 *  recommended pick below 48px. */}
                <BrandLogo variant="primary-flat" size={28} />
                <nav style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {/* W7 D4 PR-R Item A — operator visual feedback after PR-Q
                     *  shipped: "登录" + "进入控制台 →" pair read as redundant
                     *  affordances. /dashboard already double-duties (W7 PR-I:
                     *  unauthenticated → /login, authenticated → /dashboard),
                     *  so the lone "进入控制台" CTA covers both states without
                     *  the visual clutter of a third nav button. */}
                    <a
                        href="#tools"
                        style={{
                            color: 'var(--color-navy)',
                            textDecoration: 'none',
                            fontSize: 14,
                            fontWeight: 500,
                            padding: '8px 14px',
                        }}
                    >
                        {m.header.tools}
                    </a>
                    <Link
                        href="/dashboard"
                        style={{
                            color: 'var(--color-navy)',
                            textDecoration: 'none',
                            fontSize: 14,
                            fontWeight: 500,
                            padding: '8px 16px',
                            border: '1px solid var(--color-navy)',
                            borderRadius: 6,
                        }}
                    >
                        {m.header.console}
                    </Link>
                    {/* 中文 / EN toggle — client island, token classes only (works
                     *  inside this inline-styled header). */}
                    <LocaleSwitcher />
                </nav>
            </div>
        </header>
    );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Hero                                                                 */
/* ──────────────────────────────────────────────────────────────────── */

function Hero({ m }: { m: LandingMessages }) {
    return (
        <Section style={{ padding: '64px 0 56px' }}>
            <div
                style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr)',
                    gap: 48,
                    alignItems: 'center',
                }}
                className="lp-hero-grid"
            >
                <div style={{ maxWidth: 640 }}>
                    <h1
                        style={{
                            fontSize: 'clamp(32px, 5.4vw, 52px)',
                            lineHeight: 1.18,
                            fontWeight: 700,
                            margin: 0,
                            color: 'var(--color-navy)',
                            letterSpacing: -0.5,
                        }}
                    >
                        {m.hero.title}
                    </h1>
                    <p
                        style={{
                            marginTop: 20,
                            fontSize: 18,
                            color: 'var(--color-muted-ink)',
                            maxWidth: 580,
                        }}
                    >
                        {m.hero.subtitle}
                    </p>
                    <div
                        style={{
                            marginTop: 32,
                            display: 'flex',
                            gap: 12,
                            flexWrap: 'wrap',
                        }}
                    >
                        {/* CTA → /portal/register (W7 D4 — flipped back from
                         *  the F2-quick /login band-aid in PR #28 once the
                         *  real signup page landed). /login is one click
                         *  away on the register page itself for returning
                         *  users + OAuth signin. */}
                        <Link
                            href="/portal/register"
                            style={{
                                display: 'inline-block',
                                padding: '12px 24px',
                                background: 'var(--color-navy)',
                                color: 'var(--color-paper)',
                                textDecoration: 'none',
                                borderRadius: 8,
                                fontSize: 15,
                                fontWeight: 600,
                                boxShadow: '0 1px 0 rgba(0,0,0,0.06)',
                            }}
                        >
                            {m.hero.ctaStart}
                        </Link>
                        <Link
                            href="/models"
                            style={{
                                display: 'inline-block',
                                padding: '12px 24px',
                                color: 'var(--color-navy)',
                                textDecoration: 'none',
                                border: '1px solid var(--color-navy)',
                                borderRadius: 8,
                                fontSize: 15,
                                fontWeight: 500,
                                background: 'transparent',
                            }}
                        >
                            {m.hero.ctaModels}
                        </Link>
                    </div>
                </div>
                <CodeExample />
            </div>

            {/* 2-col on desktop / 1-col on mobile, via inline media query injected globally below */}
            <style
                dangerouslySetInnerHTML={{
                    __html: `
                        @media (min-width: 1024px) {
                            .lp-hero-grid { grid-template-columns: 1.1fr 1fr !important; }
                        }
                    `,
                }}
            />
            <p
                style={{
                    marginTop: 28,
                    fontSize: 13,
                    color: 'var(--color-minor-ink)',
                }}
            >
                {m.hero.compat}
            </p>
        </Section>
    );
}

function CodeExample() {
    return (
        <div
            style={{
                background: 'var(--color-navy-strong)',
                color: '#e6ebf5',
                borderRadius: 12,
                padding: '20px 22px',
                fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                fontSize: 13.5,
                lineHeight: 1.7,
                overflow: 'auto',
                boxShadow: '0 6px 24px -8px rgba(26,37,64,0.18)',
            }}
        >
            <div
                style={{
                    color: '#7a8aa8',
                    fontSize: 11,
                    marginBottom: 10,
                    letterSpacing: 0.4,
                    textTransform: 'uppercase',
                }}
            >
                $ curl
            </div>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                <code>
                    <span style={{ color: '#a3b3d1' }}>curl</span> https://ai.silkroadai.io/v1/chat/completions \{'\n'}
                    {'  '}-H <span style={{ color: '#c9a961' }}>{'"Authorization: Bearer sk-xxx"'}</span> \{'\n'}
                    {'  '}-d <span style={{ color: '#c9a961' }}>{'\'{"model": "claude-sonnet-4-6", ...}\''}</span>
                </code>
            </pre>
        </div>
    );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Promo banner — rendered only when promo window is active             */
/* ──────────────────────────────────────────────────────────────────── */

function PromoBanner({ m }: { m: LandingMessages }) {
    return (
        <Section style={{ marginBottom: 48 }}>
            <div
                role="note"
                aria-label={m.promo.ariaLabel}
                style={{
                    background: 'var(--color-paper-muted)',
                    borderLeft: '3px solid var(--color-brand-accent)',
                    padding: '14px 20px',
                    borderRadius: 8,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    fontSize: 15,
                }}
            >
                <GiftIcon />
                <div>
                    <strong style={{ color: 'var(--color-navy)' }}>{m.promo.headline}</strong>
                    {m.promo.body}
                    <span style={{ color: 'var(--color-navy)', fontWeight: 600 }}>{m.promo.deadline}</span>
                </div>
            </div>
        </Section>
    );
}

function GiftIcon() {
    return (
        <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ color: 'var(--color-brand-accent)', flexShrink: 0 }}
        >
            <polyline points="20 12 20 22 4 22 4 12" />
            <rect x="2" y="7" width="20" height="5" />
            <line x1="12" y1="22" x2="12" y2="7" />
            <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
            <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
        </svg>
    );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Why us — 3 cards                                                      */
/* ──────────────────────────────────────────────────────────────────── */

function WhyUs({ m }: { m: LandingMessages }) {
    const w = m.whyUs;
    return (
        <Section style={{ padding: '40px 0' }}>
            <div
                className="lp-three-col"
                style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr)',
                    gap: 24,
                }}
            >
                <Card
                    badge="①"
                    title={w.direct.title}
                    body={[
                        <>
                            {w.direct.line1a}
                            <strong>{w.direct.line1b}</strong>
                            {w.direct.line1c}
                        </>,
                        w.direct.line2,
                    ]}
                />
                <Card
                    badge="②"
                    title={w.models.title}
                    body={[
                        w.models.line1,
                        w.models.line2,
                        <>
                            <strong>{w.models.line3a}</strong>
                            {w.models.line3b}
                        </>,
                    ]}
                />
                <Card
                    badge="③"
                    title={w.pricing.title}
                    body={[
                        <>
                            {w.pricing.line1a}
                            <strong>{w.pricing.line1b}</strong>
                        </>,
                        w.pricing.line2,
                        <>
                            <strong>{w.pricing.line3a}</strong>
                            {w.pricing.line3b}
                        </>,
                    ]}
                />
            </div>
            <style
                dangerouslySetInnerHTML={{
                    __html: `
                        @media (min-width: 768px) {
                            .lp-three-col { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
                        }
                    `,
                }}
            />
        </Section>
    );
}

function Card({ badge, title, body }: { badge: string; title: string; body: React.ReactNode[] }) {
    return (
        <div
            style={{
                background: 'white',
                border: '1px solid var(--color-brand-border)',
                borderRadius: 12,
                padding: '28px 24px',
                boxShadow: '0 1px 0 rgba(26,37,64,0.03)',
            }}
        >
            <div
                style={{
                    color: 'var(--color-brand-accent)',
                    fontWeight: 700,
                    fontSize: 18,
                    marginBottom: 8,
                }}
            >
                {badge}
            </div>
            <h3
                style={{
                    margin: 0,
                    fontSize: 20,
                    fontWeight: 600,
                    color: 'var(--color-navy)',
                }}
            >
                {title}
            </h3>
            <div
                style={{
                    marginTop: 12,
                    color: 'var(--color-muted-ink)',
                    fontSize: 14.5,
                }}
            >
                {body.map((row, i) => (
                    <p
                        key={i}
                        style={{
                            margin: i === 0 ? 0 : '8px 0 0',
                            lineHeight: 1.65,
                        }}
                    >
                        {row}
                    </p>
                ))}
            </div>
        </div>
    );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Tools showcase — 卡片式,未来可持续追加                                  */
/* ──────────────────────────────────────────────────────────────────── */

type Tool = { icon: string; tag: string; title: string; desc: string; href: string; cta: string };

/** Localized tool cards — copy lives in `landingMessages.tools`. */
function buildTools(t: LandingMessages['tools']): Tool[] {
    return [
        { icon: '🎬', tag: t.tagOnline, ...t.seedance, href: '/tools/seedance', cta: t.ctaUse },
        { icon: '💬', tag: t.tagOnline, ...t.chat, href: '/tools/chat', cta: t.ctaUse },
        { icon: '🎨', tag: t.tagOnline, ...t.image, href: '/tools/image', cta: t.ctaUse },
        { icon: '⌨️', tag: t.tagDownload, ...t.codex, href: '/docs#codex-cli', cta: t.ctaDownload },
        { icon: '🤖', tag: t.tagDownload, ...t.claudeCode, href: '/docs#claude-code', cta: t.ctaDownload },
    ];
}

function ToolCard({ icon, tag, title, desc, href, cta }: Tool) {
    return (
        <a
            className="tool-card"
            href={href}
            style={{
                display: 'flex',
                flexDirection: 'column',
                background: 'white',
                border: '1px solid var(--color-brand-border)',
                borderRadius: 12,
                padding: 24,
                textDecoration: 'none',
                color: 'inherit',
                height: '100%',
                boxShadow: '0 1px 0 rgba(26,37,64,0.03)',
            }}
        >
            <div style={{ fontSize: 30, marginBottom: 10 }}>{icon}</div>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-brand-accent)', marginBottom: 6 }}>
                {tag}
            </span>
            <h3 style={{ margin: '0 0 8px', fontSize: 17, fontWeight: 700, color: 'var(--color-navy)' }}>{title}</h3>
            <p style={{ margin: '0 0 16px', flex: 1, fontSize: 14, lineHeight: 1.6, color: 'var(--color-muted-ink)' }}>
                {desc}
            </p>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-brand-accent)' }}>{cta} →</span>
        </a>
    );
}

function Tools({ m }: { m: LandingMessages }) {
    return (
        <Section id="tools" style={{ padding: '48px 0', scrollMarginTop: 72 }}>
            <h2 style={{ margin: 0, fontSize: 28, fontWeight: 600, color: 'var(--color-navy)', textAlign: 'center' }}>
                {m.tools.title}
            </h2>
            <p style={{ margin: '8px 0 0', textAlign: 'center', fontSize: 15, color: 'var(--color-muted-ink)' }}>
                {m.tools.subtitle}
            </p>
            <div
                className="lp-three-col"
                style={{ marginTop: 36, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 24 }}
            >
                {buildTools(m.tools).map((t) => (
                    <ToolCard key={t.href} {...t} />
                ))}
            </div>
            <style
                dangerouslySetInnerHTML={{
                    __html: `
                        @media (min-width: 768px) { .lp-three-col { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; } }
                        .tool-card { transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease; }
                        .tool-card:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(26,37,64,0.08); border-color: var(--color-brand-accent); }
                    `,
                }}
            />
        </Section>
    );
}

/* ──────────────────────────────────────────────────────────────────── */
/* How it works — 3 steps                                                */
/* ──────────────────────────────────────────────────────────────────── */

function HowItWorks({ m }: { m: LandingMessages }) {
    const h = m.howItWorks;
    return (
        <Section style={{ padding: '40px 0' }}>
            <h2
                style={{
                    margin: 0,
                    fontSize: 28,
                    fontWeight: 600,
                    color: 'var(--color-navy)',
                    textAlign: 'center',
                }}
            >
                {h.title}
            </h2>
            <div
                className="lp-three-col"
                style={{
                    marginTop: 36,
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr)',
                    gap: 24,
                }}
            >
                <Step
                    n={1}
                    title={h.step1.title}
                    body={
                        <>
                            {h.step1.bodyA}
                            <strong>{h.step1.bodyStrong}</strong>
                        </>
                    }
                />
                <Step
                    n={2}
                    title={h.step2.title}
                    body={
                        <>
                            {h.step2.bodyA}
                            <strong>{h.step2.bodyStrong}</strong>
                        </>
                    }
                />
                <Step
                    n={3}
                    title={h.step3.title}
                    body={
                        <>
                            {h.step3.bodyA}
                            <code style={{ fontFamily: 'monospace' }}>sk-xxx</code>
                            {h.step3.bodyB}
                            <code style={{ fontFamily: 'monospace' }}>base_url</code>
                            {h.step3.bodyC}
                        </>
                    }
                />
            </div>
        </Section>
    );
}

function Step({ n, title, body }: { n: number; title: string; body: React.ReactNode }) {
    return (
        <div
            style={{
                padding: '24px 22px',
                borderRadius: 12,
                background: 'var(--color-paper-muted)',
            }}
        >
            <div
                style={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    background: 'var(--color-navy)',
                    color: 'var(--color-paper)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 600,
                    fontSize: 15,
                }}
            >
                {n}
            </div>
            <h3
                style={{
                    margin: '14px 0 6px',
                    fontSize: 18,
                    fontWeight: 600,
                    color: 'var(--color-navy)',
                }}
            >
                {title}
            </h3>
            <p style={{ margin: 0, color: 'var(--color-muted-ink)', fontSize: 14.5 }}>{body}</p>
        </div>
    );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Pricing teaser                                                       */
/* ──────────────────────────────────────────────────────────────────── */

interface PricingRow {
    model: string;
    type: string;
    /** Retail input price ($/1M) — strikethrough during promo */
    retailIn?: string;
    /** Promo input price ($/1M) — bold */
    promoIn?: string;
    /** Retail output price ($/1M) — strikethrough during promo */
    retailOut?: string;
    /** Promo output price ($/1M) — bold */
    promoOut?: string;
    /** SF cost-plus row: shows ¥ price with no promo discount */
    cnyIn?: string;
    cnyOut?: string;
}

const PRICING_ROWS: PricingRow[] = [
    // W8 D1.5 (2026-05-21):W7 50% promo 永久替换为 ¥0.5 / ¥1.5 抵 $1 公式。
    // 这 4 行(Claude + GPT)从 retailIn/promoIn $ 双价切到 cnyIn/cnyOut ¥ 单价。
    // Gemini 行(下方)保留 $ 因 channel 未动;SF 行原本就是 ¥(W7 PR-K 以来)。
    {
        model: 'Claude Sonnet 4.6',
        type: '通用对话 · 高性价比',
        cnyIn: '¥4.5/1M',
        cnyOut: '¥22.5/1M',
    },
    {
        model: 'Claude Opus 4.7',
        type: '旗舰推理',
        cnyIn: '¥22.5/1M',
        cnyOut: '¥112.5/1M',
    },
    {
        model: 'GPT-5.4',
        type: 'OpenAI 通用',
        cnyIn: '¥2.5/1M',
        cnyOut: '¥10/1M',
    },
    {
        model: 'GPT-5.5',
        type: 'OpenAI 旗舰',
        cnyIn: '¥2.5/1M',
        cnyOut: '¥12.5/1M',
    },
    // PR-S — Google Gemini family (零 markup at launch:retail = official Google
    // AI Studio price). Operator decision: keep margin via post-launch upstream
    // swap rather than markup at launch. promoIn/promoOut omitted intentionally
    // — Gemini is not in the W7 海外 5 折 promo (Anthropic/OpenAI only).
    {
        model: 'Gemini 3.1 Pro',
        type: 'Google 旗舰长上下文',
        retailIn: '$4',
        retailOut: '$18',
    },
    {
        model: 'Gemini 3.1 Flash Lite',
        type: 'Google 高速 / 高吞吐',
        retailIn: '$0.25',
        retailOut: '$1.50',
    },
    // W7 D4 PR-K: SF flagship trio refresh. Retail ¥ shown = wholesale × 1.20
    // (= mr × 7 since mr = wholesale / 5.83). Wholesale itself never appears
    // on the landing — surfacing it would imply we sell at cost. Numbers
    // sourced from operator-supplied SF screenshots; mirror table in
    // _bootstrap/apply-w7-pricing.ts:SF_WHOLESALE_CNY.
    {
        model: 'DeepSeek V4-Flash',
        type: '长上下文 1024K',
        cnyIn: '¥1.20/1M',
        cnyOut: '¥2.40/1M',
    },
    {
        model: 'GLM-5.1 (Pro)',
        type: '旗舰 / 编程 / 200K',
        cnyIn: '¥9.60/1M',
        cnyOut: '¥33.60/1M',
    },
    {
        model: 'Kimi K2.6 (Pro)',
        type: '视觉 / 256K',
        cnyIn: '¥7.80/1M',
        cnyOut: '¥32.40/1M',
    },
];

/**
 * W8 D2 (2026-05-26):价格预览板块重构 — 跟海报 v3 同步。
 *
 * 替换原"4 列 9 行 per-SKU 表格"为双卡片设计:
 *   1) 海外模型 · 号池低价(默认):¥X 抵 $1 官方,3 个 family 卡片
 *      (ChatGPT 0.2 / Claude 1.3 / Gemini 0.5),适合开发者
 *   2) 企业 / 合规渠道 · 官方授权:3 个 family 卡片
 *      (Azure / AWS Bedrock / Gemini t3),适合 B2B 合规场景
 *
 * 老 PRICING_ROWS 数据保留(供 /pricing 详情页用,以及 SF 系展示)。
 */
type FamilyTier = {
    name: 'ChatGPT' | 'Claude' | 'Gemini';
    family: 'chatgpt' | 'claude' | 'gemini';
    /** Per-$1 price in CNY, e.g., '¥0.2' for the cheap pool. Enterprise rows use `zhe` instead. */
    cnyPerDollar?: string;
    /** Enterprise discount in 折 ('3.8' = 38% of the official price); rendered via `m.pricing.discount`. */
    zhe?: string;
    /** Percentage of the official price, e.g. '2.9%' — rendered via `m.pricing.officialOnly` / `.official`. */
    officialPct: string;
};

const CHEAP_POOL: FamilyTier[] = [
    { name: 'ChatGPT', family: 'chatgpt', cnyPerDollar: '¥0.2', officialPct: '2.9%' },
    { name: 'Claude', family: 'claude', cnyPerDollar: '¥1.3', officialPct: '19%' },
    { name: 'Gemini', family: 'gemini', cnyPerDollar: '¥0.5', officialPct: '7.3%' },
];

/** Provider sublabels are mostly brand names; the Vertex one carries a localized "t3 pool" suffix. */
function enterpriseTiers(m: LandingMessages): Array<FamilyTier & { provider: string }> {
    return [
        { name: 'ChatGPT', family: 'chatgpt', zhe: '3.8', officialPct: '38%', provider: 'Azure OpenAI' },
        { name: 'Claude', family: 'claude', zhe: '5.0', officialPct: '50%', provider: 'AWS Bedrock' },
        { name: 'Gemini', family: 'gemini', zhe: '2.3', officialPct: '23%', provider: m.pricing.providerVertex },
    ];
}

function FamilyIcon({ family }: { family: 'chatgpt' | 'claude' | 'gemini' }) {
    const styles = {
        chatgpt: { bg: '#1B2A4E', fg: '#FFFFFF', label: 'G' },
        claude: { bg: '#E66B47', fg: '#FFFFFF', label: '✻' },
        gemini: { bg: '#3B82F6', fg: '#FFFFFF', label: '◆' },
    } as const;
    const s = styles[family];
    return (
        <div
            style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: s.bg,
                color: s.fg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 22,
                fontWeight: 700,
                flexShrink: 0,
            }}
        >
            {s.label}
        </div>
    );
}

function PricingFamilyRow({
    tier,
    rightLabel,
    rightSubLabel,
    m,
}: {
    tier: FamilyTier;
    rightLabel: string;
    rightSubLabel?: string;
    m: LandingMessages;
}) {
    const bigLabel = tier.cnyPerDollar ?? m.pricing.discount(tier.zhe ?? '');
    return (
        <div
            className="lp-fam-row"
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '14px 18px',
                background: 'white',
                borderRadius: 12,
                border: '1px solid var(--color-brand-border)',
            }}
        >
            <FamilyIcon family={tier.family} />
            <div className="lp-fam-name" style={{ flex: '1 1 auto', minWidth: 0 }}>
                <div
                    style={{
                        fontSize: 18,
                        fontWeight: 700,
                        color: 'var(--color-navy)',
                        lineHeight: 1.15,
                    }}
                >
                    {tier.name}
                </div>
            </div>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 4,
                    flexShrink: 0,
                }}
            >
                <span
                    style={{
                        fontSize: 26,
                        fontWeight: 700,
                        color: 'var(--color-navy)',
                        lineHeight: 1,
                    }}
                >
                    {bigLabel}
                </span>
                {tier.cnyPerDollar ? (
                    <span style={{ fontSize: 14, color: 'var(--color-muted-ink)' }}>{m.pricing.perDollar}</span>
                ) : null}
            </div>
            <div
                className="lp-fam-pill"
                style={{
                    flexShrink: 0,
                    minWidth: 120,
                    textAlign: 'right',
                }}
            >
                <span
                    style={{
                        display: 'inline-block',
                        padding: '4px 12px',
                        borderRadius: 999,
                        background: '#FBF1DC',
                        color: 'var(--color-navy)',
                        fontSize: 13,
                        fontWeight: 600,
                    }}
                >
                    {rightLabel}
                </span>
                {rightSubLabel ? (
                    <div
                        style={{
                            marginTop: 4,
                            fontSize: 11,
                            color: 'var(--color-muted-ink)',
                            fontWeight: 500,
                        }}
                    >
                        {rightSubLabel}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function PricingTeaser({ promoActive: _promoActive, m }: { promoActive: boolean; m: LandingMessages }) {
    const p = m.pricing;
    return (
        <Section style={{ padding: '48px 0' }}>
            {/* 手机窄屏下行内固定宽度(图标 44 + 价格 + pill minWidth 120)超过可用宽度,
                模型名被压到 0 宽溢出叠到价格上 — 允许换行:第一行图标+模型名,第二行价格靠左 + pill 靠右 */}
            <style
                dangerouslySetInnerHTML={{
                    __html: `
                        @media (max-width: 640px) {
                            .lp-fam-row { flex-wrap: wrap; }
                            .lp-fam-name { flex: 1 0 auto !important; }
                            .lp-fam-pill { min-width: 0 !important; margin-left: auto; }
                        }
                    `,
                }}
            />
            <h2
                style={{
                    margin: 0,
                    fontSize: 28,
                    fontWeight: 600,
                    color: 'var(--color-navy)',
                    textAlign: 'center',
                }}
            >
                {p.title}
            </h2>
            <p
                style={{
                    margin: '10px 0 0',
                    textAlign: 'center',
                    fontSize: 15,
                    color: 'var(--color-muted-ink)',
                }}
            >
                {p.subtitle}
            </p>

            {/* 卡片 1:号池低价(默认渠道,适合开发者 / 个人 / 大批量) */}
            <div
                style={{
                    marginTop: 28,
                    padding: 24,
                    borderRadius: 16,
                    background: 'linear-gradient(180deg, #FDF5E2 0%, #FAF1D5 100%)',
                    border: '1px solid #EBD8A0',
                }}
            >
                <div
                    style={{
                        marginBottom: 16,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                    }}
                >
                    <span style={{ fontSize: 22 }}>🏷️</span>
                    <span
                        style={{
                            fontSize: 18,
                            fontWeight: 700,
                            color: 'var(--color-navy)',
                        }}
                    >
                        {p.cheapPoolTitle}
                    </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {CHEAP_POOL.map((tier) => (
                        <PricingFamilyRow
                            key={tier.name}
                            tier={tier}
                            rightLabel={p.officialOnly(tier.officialPct)}
                            m={m}
                        />
                    ))}
                </div>
            </div>

            {/* 卡片 2:企业 / 合规渠道 · 官方授权(可签商务合同,适合 B2B) */}
            <div
                style={{
                    marginTop: 18,
                    padding: 24,
                    borderRadius: 16,
                    background: 'linear-gradient(180deg, #F4F6FC 0%, #EAEEF8 100%)',
                    border: '1px solid #C9D3EA',
                }}
            >
                <div
                    style={{
                        marginBottom: 6,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                    }}
                >
                    <span style={{ fontSize: 22 }}>🛡️</span>
                    <span
                        style={{
                            fontSize: 18,
                            fontWeight: 700,
                            color: 'var(--color-navy)',
                        }}
                    >
                        {p.enterpriseTitle}
                    </span>
                </div>
                <p
                    style={{
                        margin: '0 0 16px',
                        fontSize: 13,
                        color: 'var(--color-muted-ink)',
                    }}
                >
                    {p.enterpriseDesc}
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {enterpriseTiers(m).map((tier) => (
                        <PricingFamilyRow
                            key={tier.name}
                            tier={tier}
                            rightLabel={p.discount(tier.zhe ?? '')}
                            rightSubLabel={tier.provider}
                            m={m}
                        />
                    ))}
                </div>
            </div>

            <p
                style={{
                    marginTop: 22,
                    fontSize: 14,
                    color: 'var(--color-muted-ink)',
                    textAlign: 'center',
                }}
            >
                {p.fullPricing}{' '}
                <Link href="/pricing" style={{ color: 'var(--color-navy)', fontWeight: 500 }}>
                    /pricing
                </Link>{' '}
                · {p.allModels}{' '}
                <Link href="/models" style={{ color: 'var(--color-navy)', fontWeight: 500 }}>
                    /models
                </Link>{' '}
                · {p.enterpriseWechat} <strong style={{ color: 'var(--color-navy)' }}>Global_Ads</strong>
            </p>
        </Section>
    );
}

// W8 D2(2026-05-26):老 PriceCell 删除 — PricingTeaser 重构成 family-summary 卡片
// 后不再用 per-cell 渲染。PRICING_ROWS 数据保留(/pricing 详情页将复用)。

/* ──────────────────────────────────────────────────────────────────── */
/* OAuth-error banner — preserves the W4-1 ?oauth_error= forwarding     */
/* ──────────────────────────────────────────────────────────────────── */

function OAuthErrorBanner({ code, m }: { code: string; m: LandingMessages }) {
    // Whitelist friendly codes (landingMessages.oauth.codes); unknown values
    // are shown as-is but truncated. `hasOwnProperty` guards against
    // prototype keys like `constructor` leaking through the lookup.
    const friendly = Object.prototype.hasOwnProperty.call(m.oauth.codes, code) ? m.oauth.codes[code] : undefined;
    const safe = code.length > 60 ? code.slice(0, 60) + '…' : code;
    const message = friendly ?? m.oauth.failed(safe);
    return (
        <div
            role="alert"
            style={{
                background: '#fff7ed',
                borderBottom: '1px solid #fed7aa',
                color: '#9a3412',
                padding: '10px 16px',
                fontSize: 13,
                textAlign: 'center',
            }}
        >
            {message}{' '}
            <Link
                href="/login"
                style={{
                    color: '#9a3412',
                    textDecoration: 'underline',
                    marginLeft: 8,
                    fontWeight: 600,
                }}
            >
                {m.oauth.backToLogin}
            </Link>
        </div>
    );
}
