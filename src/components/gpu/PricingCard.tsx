/**
 * PricingCard — single GPU SKU card on /gpu (W7 PR-P).
 *
 * Server-rendered (no client JS). Reads from `src/data/gpu-pricing.ts`
 * and `src/i18n/gpu-page.ts`.
 *
 * Visual contract (P1 design system):
 *   - Card primitive (white surface, brand-border, shadow-card, rounded-xl)
 *   - 3px brand-accent gold left rail (visual continuation of the warm
 *     promo / hero rail used elsewhere on the landing)
 *   - Optional highlight ribbon top-right corner when `highlight` is set
 *   - Use-case chips render as paper-muted pills
 *   - Card CTA is a Button primitive (secondary variant, not a Link
 *     because the action is "open WeChat search" not internal nav)
 */
import { Card } from '@/components/ui/Card';
import { GPU_SKUS, LEASE_TERM_LABEL, type GpuSku } from '@/data/gpu-pricing';
import { t } from '@/i18n/gpu-page';

export interface PricingCardProps {
    sku: GpuSku;
}

/** Format CNY price with thousands grouping. ¥80,000 / 月 起 form. */
function formatPriceRange(sku: GpuSku): React.ReactNode {
    const { from, to } = sku.monthlyPriceCny;
    if (from === null && to === null) {
        return <span className="text-2xl font-semibold text-navy">{sku.customLabel ?? '—'}</span>;
    }
    const fmt = (n: number) => `¥${n.toLocaleString('zh-CN')}`;
    return (
        <span>
            <span className="text-xs text-minor-ink mr-1">{t('pricing_card_monthly_unit')}</span>
            <span className="text-2xl font-semibold text-navy tabular-nums">
                {to == null ? fmt(from!) : `${fmt(from!)}–${fmt(to)}`}
            </span>
            <span className="text-xs text-minor-ink ml-1">{t('pricing_card_from')}</span>
        </span>
    );
}

export function PricingCard({ sku }: PricingCardProps) {
    return (
        <Card
            as="article"
            className="relative flex flex-col h-full overflow-hidden border-l-[3px] border-l-brand-accent"
        >
            {sku.highlight ? (
                <div
                    className="absolute top-0 right-0 px-3 py-1 text-xs font-semibold text-paper bg-brand-accent rounded-bl-lg"
                    aria-label={`Highlight: ${sku.highlight}`}
                >
                    {sku.highlight}
                </div>
            ) : null}

            <div className="px-6 pt-6 pb-3">
                <h3 className="m-0 text-xl font-semibold text-navy">{sku.name}</h3>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm text-muted-ink">
                    <dt className="text-minor-ink">{t('pricing_card_arch_label')}</dt>
                    <dd className="m-0 font-medium text-muted-ink">{sku.architecture}</dd>
                    <dt className="text-minor-ink">{t('pricing_card_memory_label')}</dt>
                    <dd className="m-0 font-medium text-muted-ink">{sku.memory}</dd>
                </dl>
            </div>

            <div className="px-6 py-4 border-t border-brand-border">{formatPriceRange(sku)}</div>

            <div className="px-6 py-3 border-t border-brand-border text-sm text-muted-ink space-y-1.5">
                <p className="m-0">
                    <span className="text-minor-ink">{t('pricing_card_lease_term_label')}:</span>{' '}
                    <span className="font-medium text-navy">{LEASE_TERM_LABEL[sku.minLeaseTerm]}</span>
                </p>
                <p className="m-0">
                    <span className="text-minor-ink">{t('pricing_card_quantity_label')}:</span>{' '}
                    <span className="font-medium text-navy">{sku.minQuantity}</span>
                </p>
            </div>

            <div className="px-6 py-4 border-t border-brand-border flex-1">
                <p className="m-0 mb-2 text-xs text-minor-ink">{t('pricing_card_use_cases_label')}</p>
                <ul className="list-none p-0 m-0 flex flex-wrap gap-1.5">
                    {sku.useCases.map((uc) => (
                        <li
                            key={uc}
                            className="inline-block px-2.5 py-1 text-xs font-medium rounded-md bg-paper-muted text-muted-ink"
                        >
                            {uc}
                        </li>
                    ))}
                </ul>
            </div>

            <div className="px-6 py-4 border-t border-brand-border bg-paper-muted/40">
                <p className="m-0 text-sm text-navy font-medium">{t('pricing_card_cta')}</p>
                <p className="m-0 mt-1 text-xs text-minor-ink">
                    微信号 <code className="font-mono px-1.5 py-0.5 bg-surface rounded text-navy">Global_Ads</code>
                </p>
            </div>
        </Card>
    );
}

/** Convenience wrapper that renders one card per SKU in display order. */
export function PricingCardsGrid() {
    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {GPU_SKUS.map((sku) => (
                <PricingCard key={sku.id} sku={sku} />
            ))}
        </div>
    );
}
