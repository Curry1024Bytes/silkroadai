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
import { Inter } from 'next/font/google';
import Link from 'next/link';
import { Logo } from '@/components/brand/Logo';
import { isPromoActive } from '@/lib/promo';

const inter = Inter({
    subsets: ['latin'],
    display: 'swap',
    weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
    title: 'Silk Road AI · 一个 Key,接入 200+ AI 模型 | ChatGPT、Claude、Gemini 国内中转',
    description:
        '国内开发者的 AI API 聚合网关。海外大模型直连,人民币付费,价格透明。上线钜惠:海外模型 5 折,限时 30 天。',
    keywords: [
        'ChatGPT API',
        'Claude API',
        'Gemini API',
        'AI API 中转',
        '国内调用 OpenAI',
        'AI 网关',
    ],
    openGraph: {
        title: 'Silk Road AI · 一个 Key,接入 200+ AI 模型',
        description: '国内直连 ChatGPT/Claude/Gemini · 人民币付费 · 上线 5 折',
        url: 'https://silkroadai.io',
        type: 'website',
        // SVG placeholder — designer ships final 1200×630 PNG in a follow-up;
        // most crawlers honor SVG (Twitter / Discord), Facebook prefers PNG so
        // a binary swap is on the W7 finish list.
        images: [{ url: 'https://silkroadai.io/og-image.svg', width: 1200, height: 630 }],
    },
};

export default async function LandingPage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = (await searchParams) ?? {};
    const oauthError =
        typeof params.oauth_error === 'string' ? params.oauth_error : null;
    const promoActive = isPromoActive();

    return (
        <main
            className={inter.className}
            style={{
                background: 'var(--color-paper)',
                color: 'var(--color-ink)',
                lineHeight: 1.7,
                minHeight: '100vh',
            }}
        >
            {oauthError ? <OAuthErrorBanner code={oauthError} /> : null}
            <Header />
            <Hero />
            {promoActive ? <PromoBanner /> : null}
            <WhyUs />
            <HowItWorks />
            <PricingTeaser promoActive={promoActive} />
            <Trust />
        </main>
    );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Layout primitives                                                    */
/* ──────────────────────────────────────────────────────────────────── */

const SECTION_MAX = 1120;

function Section({
    children,
    style,
    id,
}: {
    children: React.ReactNode;
    style?: React.CSSProperties;
    id?: string;
}) {
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

function Header() {
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
                    gap: 16,
                }}
            >
                {/* `Logo` wraps in `<Link href="/">` itself (default `linkHome={true}`).
                 *  Use `primary-flat` because at 28px the gradient on `primary` aliases
                 *  on small screens; per the asset cheatsheet the flat variant is the
                 *  recommended pick below 48px. */}
                <Logo variant="primary-flat" size={28} />
                <nav style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Link
                        href="/login"
                        style={{
                            color: 'var(--color-muted-ink)',
                            textDecoration: 'none',
                            fontSize: 14,
                            padding: '8px 12px',
                        }}
                    >
                        登录
                    </Link>
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
                        进入控制台 →
                    </Link>
                </nav>
            </div>
        </header>
    );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Hero                                                                 */
/* ──────────────────────────────────────────────────────────────────── */

function Hero() {
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
                        一个 Key,接入 200+ AI 模型
                    </h1>
                    <p
                        style={{
                            marginTop: 20,
                            fontSize: 18,
                            color: 'var(--color-muted-ink)',
                            maxWidth: 580,
                        }}
                    >
                        国内开发者直连 ChatGPT、Claude、Gemini 等海外大模型 · 人民币付费 ·
                        价格透明 · 5 分钟接入
                    </p>
                    <div
                        style={{
                            marginTop: 32,
                            display: 'flex',
                            gap: 12,
                            flexWrap: 'wrap',
                        }}
                    >
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
                            立即开始 →
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
                            查看模型清单
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
                完全 OpenAI 兼容,任何 SDK 一行替换 base URL。
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
                fontFamily:
                    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
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

function PromoBanner() {
    return (
        <Section style={{ marginBottom: 48 }}>
            <div
                role="note"
                aria-label="上线促销"
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
                    <strong style={{ color: 'var(--color-navy)' }}>
                        上线钜惠 · 海外模型 5 折
                    </strong>{' '}
                    · ChatGPT / Claude / Gemini 全系列 · 限时 30 天 ·{' '}
                    <span style={{ color: 'var(--color-navy)', fontWeight: 600 }}>
                        6 月 9 日截止
                    </span>
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

function WhyUs() {
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
                    title="国内可直连"
                    body={[
                        <>
                            海外节点 + 国内可访问域名,
                            <strong>无需代理 / VPN</strong>。
                        </>,
                        'ChatGPT、Claude、Gemini 直接调用,毫秒级响应。',
                    ]}
                />
                <Card
                    badge="②"
                    title="200+ 主流模型聚合"
                    body={[
                        '海外:OpenAI gpt-5 系列 / Anthropic Claude 4 系列 / Google Gemini',
                        '国内:DeepSeek、通义千问、智谱 GLM、月之暗面 Kimi、腾讯混元',
                        <>
                            <strong>统一 OpenAI 兼容接口,无需迁移代码</strong>。
                        </>,
                    ]}
                />
                <Card
                    badge="③"
                    title="定价透明 · 人民币付费"
                    body={[
                        '海外模型按上游官方原价 · 国内模型上游源价 +20%',
                        '1 美金 = 100 万积分 · 固定汇率 ¥7',
                        <>
                            <strong>余额永不失效,可申请退款</strong>。
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

function Card({
    badge,
    title,
    body,
}: {
    badge: string;
    title: string;
    body: React.ReactNode[];
}) {
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
/* How it works — 3 steps                                                */
/* ──────────────────────────────────────────────────────────────────── */

function HowItWorks() {
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
                三步开始使用
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
                    title="注册登录"
                    body={
                        <>
                            邮箱验证 / Google / GitHub 一键登录,
                            <strong>不绑定手机号</strong>
                        </>
                    }
                />
                <Step
                    n={2}
                    title="充值开通"
                    body={
                        <>
                            支付宝 / 微信 ¥10 起,<strong>首充独享 +20% 积分</strong>
                        </>
                    }
                />
                <Step
                    n={3}
                    title="接入调用"
                    body={
                        <>
                            复制 <code style={{ fontFamily: 'monospace' }}>sk-xxx</code>,任何
                            OpenAI SDK 改一行{' '}
                            <code style={{ fontFamily: 'monospace' }}>base_url</code> 即可
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
            <p style={{ margin: 0, color: 'var(--color-muted-ink)', fontSize: 14.5 }}>
                {body}
            </p>
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
    {
        model: 'Claude Sonnet 4.6',
        type: '通用对话 · 高性价比',
        retailIn: '$3',
        promoIn: '$1.5',
        retailOut: '$15',
        promoOut: '$7.5',
    },
    {
        model: 'Claude Opus 4.7',
        type: '旗舰推理',
        retailIn: '$5',
        promoIn: '$2.5',
        retailOut: '$25',
        promoOut: '$12.5',
    },
    {
        model: 'GPT-5.4',
        type: 'OpenAI 通用',
        retailIn: '$2.5',
        promoIn: '$1.25',
        retailOut: '$15',
        promoOut: '$7.5',
    },
    {
        model: 'GPT-5.5',
        type: 'OpenAI 旗舰',
        retailIn: '$5',
        promoIn: '$2.5',
        retailOut: '$30',
        promoOut: '$15',
    },
    {
        model: 'DeepSeek-V3.2',
        type: '国产高性价比',
        cnyIn: '~¥4.8/1M',
        cnyOut: '~¥4.8/1M',
    },
    { model: 'Qwen3-235B', type: '阿里通义', cnyIn: '~¥4.2/1M', cnyOut: '~¥4.2/1M' },
    { model: 'GLM-4.6', type: '智谱', cnyIn: '~¥6/1M', cnyOut: '~¥6/1M' },
    {
        model: 'Kimi-K2',
        type: '月之暗面 · 长上下文',
        cnyIn: '~¥2.4/1M',
        cnyOut: '~¥2.4/1M',
    },
];

function PricingTeaser({ promoActive }: { promoActive: boolean }) {
    return (
        <Section style={{ padding: '48px 0' }}>
            <h2
                style={{
                    margin: 0,
                    fontSize: 28,
                    fontWeight: 600,
                    color: 'var(--color-navy)',
                    textAlign: 'center',
                }}
            >
                价格预览
            </h2>
            {promoActive ? (
                <p
                    style={{
                        margin: '12px 0 0',
                        textAlign: 'center',
                        color: 'var(--color-brand-accent)',
                        fontWeight: 600,
                    }}
                >
                    当前促销 · 海外模型 5 折(限时 30 天)
                </p>
            ) : null}

            <div
                style={{
                    marginTop: 28,
                    overflow: 'auto',
                    border: '1px solid var(--color-brand-border)',
                    borderRadius: 12,
                    background: 'white',
                }}
            >
                <table
                    style={{
                        width: '100%',
                        borderCollapse: 'collapse',
                        fontSize: 14,
                        minWidth: 640,
                    }}
                >
                    <thead>
                        <tr
                            style={{
                                background: 'var(--color-paper-muted)',
                                color: 'var(--color-muted-ink)',
                                fontWeight: 600,
                            }}
                        >
                            <th
                                style={{
                                    padding: '14px 20px',
                                    textAlign: 'left',
                                    borderBottom: '1px solid var(--color-brand-border)',
                                }}
                            >
                                模型
                            </th>
                            <th
                                style={{
                                    padding: '14px 20px',
                                    textAlign: 'left',
                                    borderBottom: '1px solid var(--color-brand-border)',
                                }}
                            >
                                类型
                            </th>
                            <th
                                style={{
                                    padding: '14px 20px',
                                    textAlign: 'left',
                                    borderBottom: '1px solid var(--color-brand-border)',
                                }}
                            >
                                输入 ($/1M)
                            </th>
                            <th
                                style={{
                                    padding: '14px 20px',
                                    textAlign: 'left',
                                    borderBottom: '1px solid var(--color-brand-border)',
                                }}
                            >
                                输出 ($/1M)
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {PRICING_ROWS.map((row, i) => (
                            <tr key={row.model}>
                                <td
                                    style={{
                                        padding: '14px 20px',
                                        borderTop:
                                            i === 0
                                                ? 'none'
                                                : '1px solid var(--color-brand-border)',
                                        color: 'var(--color-navy)',
                                        fontWeight: 600,
                                    }}
                                >
                                    {row.model}
                                </td>
                                <td
                                    style={{
                                        padding: '14px 20px',
                                        borderTop:
                                            i === 0
                                                ? 'none'
                                                : '1px solid var(--color-brand-border)',
                                        color: 'var(--color-muted-ink)',
                                    }}
                                >
                                    {row.type}
                                </td>
                                <td
                                    style={{
                                        padding: '14px 20px',
                                        borderTop:
                                            i === 0
                                                ? 'none'
                                                : '1px solid var(--color-brand-border)',
                                    }}
                                >
                                    <PriceCell
                                        promoActive={promoActive}
                                        retail={row.retailIn}
                                        promo={row.promoIn}
                                        cny={row.cnyIn}
                                    />
                                </td>
                                <td
                                    style={{
                                        padding: '14px 20px',
                                        borderTop:
                                            i === 0
                                                ? 'none'
                                                : '1px solid var(--color-brand-border)',
                                    }}
                                >
                                    <PriceCell
                                        promoActive={promoActive}
                                        retail={row.retailOut}
                                        promo={row.promoOut}
                                        cny={row.cnyOut}
                                    />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <p
                style={{
                    marginTop: 18,
                    fontSize: 14,
                    color: 'var(--color-muted-ink)',
                }}
            >
                完整价格 →{' '}
                <Link
                    href="/pricing"
                    style={{ color: 'var(--color-navy)', fontWeight: 500 }}
                >
                    /pricing
                </Link>{' '}
                · 全部模型 →{' '}
                <Link
                    href="/models"
                    style={{ color: 'var(--color-navy)', fontWeight: 500 }}
                >
                    /models
                </Link>
            </p>
        </Section>
    );
}

function PriceCell({
    promoActive,
    retail,
    promo,
    cny,
}: {
    promoActive: boolean;
    retail?: string;
    promo?: string;
    cny?: string;
}) {
    if (cny) {
        // SF cost-plus: no promo, no strikethrough.
        return <span style={{ color: 'var(--color-navy)' }}>{cny}</span>;
    }
    if (!retail) return <span>—</span>;
    if (promoActive && promo) {
        return (
            <span>
                <span
                    style={{
                        textDecoration: 'line-through',
                        color: 'var(--color-minor-ink)',
                        marginRight: 8,
                    }}
                >
                    {retail}
                </span>
                <strong style={{ color: 'var(--color-navy)' }}>{promo}</strong>
            </span>
        );
    }
    return <strong style={{ color: 'var(--color-navy)' }}>{retail}</strong>;
}

/* ──────────────────────────────────────────────────────────────────── */
/* Trust row                                                            */
/* ──────────────────────────────────────────────────────────────────── */

function Trust() {
    return (
        <Section style={{ padding: '40px 0 64px' }}>
            <div
                style={{
                    borderTop: '1px solid var(--color-brand-border)',
                    paddingTop: 32,
                    color: 'var(--color-muted-ink)',
                    fontSize: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                }}
            >
                <p style={{ margin: 0 }}>
                    由 Silk Road AI 运营团队维护 · 海外节点部署 · HTTPS 全程加密
                </p>
                <p style={{ margin: 0 }}>
                    <strong style={{ color: 'var(--color-navy)' }}>联系我们</strong>:微信{' '}
                    <code
                        style={{
                            fontFamily: 'monospace',
                            background: 'var(--color-paper-muted)',
                            padding: '2px 8px',
                            borderRadius: 4,
                        }}
                    >
                        Global_Ads
                    </code>{' '}
                    · 邮箱{' '}
                    <a
                        href="mailto:support@silkroadai.io"
                        style={{
                            color: 'var(--color-navy)',
                            textDecoration: 'none',
                            borderBottom: '1px dotted var(--color-navy)',
                        }}
                    >
                        support@silkroadai.io
                    </a>
                </p>
                <p style={{ margin: 0 }}>
                    <strong style={{ color: 'var(--color-navy)' }}>法律</strong>:
                    <Link
                        href="/terms"
                        style={{ color: 'var(--color-navy)', textDecoration: 'none' }}
                    >
                        服务条款
                    </Link>{' '}
                    ·{' '}
                    <Link
                        href="/privacy"
                        style={{ color: 'var(--color-navy)', textDecoration: 'none' }}
                    >
                        隐私政策
                    </Link>{' '}
                    ·{' '}
                    <Link
                        href="/refund"
                        style={{ color: 'var(--color-navy)', textDecoration: 'none' }}
                    >
                        退款政策
                    </Link>
                </p>
            </div>
        </Section>
    );
}

/* ──────────────────────────────────────────────────────────────────── */
/* OAuth-error banner — preserves the W4-1 ?oauth_error= forwarding     */
/* ──────────────────────────────────────────────────────────────────── */

function OAuthErrorBanner({ code }: { code: string }) {
    // Whitelist friendly codes; unknown values are shown as-is but truncated.
    const friendly: Record<string, string> = {
        google_denied: 'Google 登录被取消,请重试。',
        github_denied: 'GitHub 登录被取消,请重试。',
        google_invalid: 'Google 登录失败 — 请重试,或使用邮箱密码登录。',
        github_invalid: 'GitHub 登录失败 — 请重试,或使用邮箱密码登录。',
        oauth_state_mismatch: '登录会话已过期,请重新登录。',
        oauth_provider_error: '第三方登录服务暂不可达,请稍后重试。',
    };
    const safe = code.length > 60 ? code.slice(0, 60) + '…' : code;
    const message = friendly[code] ?? `登录失败:${safe}`;
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
                返回登录
            </Link>
        </div>
    );
}
