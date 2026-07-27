/**
 * Custom 404 — replaces Next's default for any unmatched route.
 *
 * Server-rendered, no client JS. Uses the W7 P1 design system:
 * paper backdrop, primary-flat logo, navy heading, brand-accent gold
 * accent, contact + legal links from the footer (rendered globally
 * via `src/app/layout.tsx` so we don't duplicate it inside this file).
 *
 * Tone: neutral, factual. Brief: "中性不人格化" — no jokes, no pet
 * mascots, no "oops!" — just "页面没找到 + 怎么回去 + 怎么联系".
 */
import { Logo } from '@/components/brand/Logo';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

export const metadata = {
    title: '页面没找到 — LLmRoute',
};

export default function NotFound() {
    return (
        <main className="min-h-[70vh] flex items-center justify-center bg-paper px-4 py-12">
            <Card className="w-full max-w-md p-8 text-center">
                <div className="flex justify-center mb-5">
                    <Logo variant="primary-flat" size={32} />
                </div>
                <p
                    className="m-0 mb-3 text-brand-accent font-semibold tabular-nums"
                    aria-hidden="true"
                    style={{ fontSize: 36, letterSpacing: 0 }}
                >
                    404
                </p>
                <h1 className="m-0 mb-2 text-xl font-semibold text-navy">页面没找到</h1>
                <p className="m-0 mb-6 text-sm text-muted-ink leading-relaxed">您访问的链接可能已变更或不存在。</p>
                <div className="flex flex-col sm:flex-row gap-2 justify-center">
                    <Button href="/" variant="primary" size="md">
                        返回首页
                    </Button>
                    <Button href="/models" variant="secondary" size="md">
                        查看模型清单
                    </Button>
                </div>
                <p className="m-0 mt-6 text-xs text-minor-ink">
                    需要帮助?微信{' '}
                    <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                        Global_Ads
                    </code>{' '}
                    · 邮箱{' '}
                    <a href="mailto:support@llmroute.club" className="text-navy no-underline hover:text-brand-accent">
                        support@llmroute.club
                    </a>
                </p>
            </Card>
        </main>
    );
}
