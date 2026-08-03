/**
 * ServiceFlow — 4-step horizontal flow for /gpu (W7 PR-P).
 *
 * Server-rendered. Reads from `src/data/gpu-pricing.ts` (`SERVICE_STEPS`)
 * and `src/i18n/gpu-page.ts`.
 *
 * Layout
 * ------
 *   Desktop (≥768px) — 4 horizontal cards, gap 4, equal width
 *   Mobile (<768px)  — vertical stack, full-width cards
 *
 * Each step is paper-muted (matches the landing's "三步开始使用" block
 * pattern). The leading numbered chip uses navy bg + paper text — same
 * affordance as the existing landing flow card.
 */
import { SERVICE_STEPS } from '@/data/gpu-pricing';
import { SUPPORT_WECHAT } from '@/lib/public-config';

export function ServiceFlow() {
    return (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {SERVICE_STEPS.map((step) => (
                <article key={step.id} className="px-5 py-5 rounded-xl bg-paper-muted">
                    <div
                        className="w-8 h-8 rounded-full bg-navy text-paper flex items-center justify-center font-semibold text-sm"
                        aria-hidden="true"
                    >
                        {step.n}
                    </div>
                    <h3 className="m-0 mt-3 mb-1 text-base font-semibold text-navy">{step.title}</h3>
                    <p className="m-0 text-sm text-muted-ink leading-relaxed">
                        {step.id === 'inquire' ? (
                            <>
                                加 <code className="font-mono text-xs text-navy">{SUPPORT_WECHAT}</code>,{step.body}
                            </>
                        ) : (
                            step.body
                        )}
                    </p>
                </article>
            ))}
        </div>
    );
}
