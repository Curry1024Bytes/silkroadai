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
import { getMessages } from '@/lib/i18n/server';
import { commonMessages } from '@/lib/i18n/messages/common';

export async function generateMetadata() {
    const m = await getMessages(commonMessages);
    return { title: m.errors.notFoundPageTitle };
}

export default async function NotFound() {
    const m = await getMessages(commonMessages);
    return (
        <main className="min-h-[70vh] flex items-center justify-center bg-paper px-4 py-12">
            <Card className="w-full max-w-md p-8 text-center">
                <div className="flex justify-center mb-5">
                    <Logo variant="primary-flat" size={32} />
                </div>
                <p
                    className="m-0 mb-3 text-brand-accent font-semibold tabular-nums"
                    aria-hidden="true"
                    style={{ fontSize: 36, letterSpacing: '-0.02em' }}
                >
                    404
                </p>
                <h1 className="m-0 mb-2 text-xl font-semibold text-navy">{m.errors.notFoundTitle}</h1>
                <p className="m-0 mb-6 text-sm text-muted-ink leading-relaxed">{m.errors.notFoundBody}</p>
                <div className="flex flex-col sm:flex-row gap-2 justify-center">
                    <Button href="/" variant="primary" size="md">
                        {m.nav.backHome}
                    </Button>
                    <Button href="/models" variant="secondary" size="md">
                        {m.errors.viewModels}
                    </Button>
                </div>
                <p className="m-0 mt-6 text-xs text-minor-ink">
                    {m.support.needHelp}{' '}
                    <code className="font-mono text-xs bg-paper-muted px-1.5 py-0.5 rounded border border-brand-border text-navy">
                        Global_Ads
                    </code>{' '}
                    · {m.support.email}{' '}
                    <a href="mailto:support@silkroadai.io" className="text-navy no-underline hover:text-brand-accent">
                        support@silkroadai.io
                    </a>
                </p>
            </Card>
        </main>
    );
}
