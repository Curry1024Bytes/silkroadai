'use client';

import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import type { ModelEntry, TypeName } from '@/lib/models/categorize';
import type { BrowserTier } from '@/lib/models/catalog-browser-types';
import type { TierPricing } from '@/lib/models/machine-catalog';
import {
    formatTieredPrice,
    isUniformPricingDetails,
    tieredPricingConditionLabel,
} from '@/lib/models/tiered-pricing-details';
import CatalogMediaPriceDetails from '@/components/CatalogMediaPriceDetails';

export function ModelPriceDialog({
    entry,
    tiers,
    prices,
    onClose,
}: {
    entry: ModelEntry;
    tiers: BrowserTier[];
    prices: Record<string, TierPricing | null>;
    onClose: () => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    useEffect(() => {
        const element = dialog.current;
        element?.showModal();
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            element?.close();
            document.body.style.overflow = previousOverflow;
        };
    }, []);
    return (
        <dialog
            ref={dialog}
            aria-labelledby={titleId}
            onCancel={(event) => {
                event.preventDefault();
                onClose();
            }}
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
            className="fixed inset-0 m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-3xl overflow-y-auto rounded-xl border border-brand-border bg-surface p-0 text-navy shadow-card-strong backdrop:bg-navy-strong/60 backdrop:backdrop-blur-sm"
        >
            <div>
                <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-brand-border bg-surface px-5 py-4 sm:px-6">
                    <div className="min-w-0">
                        <h2 id={titleId} className="m-0 break-words text-lg font-semibold [overflow-wrap:anywhere]">
                            {entry.shortName}
                        </h2>
                        <p className="m-0 mt-1 text-xs text-muted-ink">完整价格 · 使用对应分组的 API Key 调用</p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="关闭价格详情"
                        className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted-ink hover:bg-paper-muted hover:text-navy"
                    >
                        <X size={20} aria-hidden="true" />
                    </button>
                </header>
                <div className="space-y-7 p-5 sm:p-6">
                    {tiers
                        .filter((row) => Object.hasOwn(prices, row.key))
                        .map((row) => (
                            <section key={row.key} aria-label={`${row.label}价格`}>
                                <h3 className="m-0 mb-3 break-words text-sm font-semibold text-navy">{row.label}</h3>
                                <ModelTierPrices price={prices[row.key]} type={entry.type} />
                            </section>
                        ))}
                </div>
            </div>
        </dialog>
    );
}

export function ModelTierPrices({ price, type }: { price: TierPricing | null; type: TypeName }) {
    if (!price) return <p className="m-0 text-sm text-muted-ink">未定价</p>;
    const details = price.billing_details;
    if (details && details.mode !== 'tiered_token') return <CatalogMediaPriceDetails details={details} />;
    if (details && !isUniformPricingDetails(details)) {
        return (
            <>
                <p className="m-0 mb-3 text-xs leading-relaxed text-muted-ink">
                    单位：元 / 百万 token。按完整输入长度选档，整次请求使用该档价格。
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                    {details.tiers.map((row) => (
                        <section key={row.name} className="rounded-lg bg-paper-muted p-4">
                            <h4 className="m-0 mb-3 text-xs font-medium text-navy">
                                {tieredPricingConditionLabel(row)}
                            </h4>
                            <TokenPriceRows rates={row.rates} />
                        </section>
                    ))}
                </div>
            </>
        );
    }
    const rates = details?.tiers[0].rates ?? {
        input: price.input_cny_per_1m,
        output: price.output_cny_per_1m,
        cache_read: null,
        cache_write: null,
        cache_write_1h: null,
    };
    const hasTokenRates = Object.values(rates).some((rate) => rate !== null);
    if (price.per_image_cny === null && !hasTokenRates) return <p className="m-0 text-sm text-muted-ink">未定价</p>;
    return (
        <>
            {price.per_image_cny !== null && (
                <p className="m-0 mb-2 text-base font-semibold">
                    {`¥${formatTieredPrice(price.per_image_cny)}`}
                    <span className="text-xs font-normal text-muted-ink"> / {type === 'image-gen' ? '张' : '次'}</span>
                </p>
            )}
            {hasTokenRates && (
                <>
                    <p className="m-0 mb-2 text-xs text-muted-ink">元 / 百万 token</p>
                    <TokenPriceRows rates={rates} />
                </>
            )}
        </>
    );
}

function TokenPriceRows({
    rates,
}: {
    rates: {
        input: number | null;
        output: number | null;
        cache_read: number | null;
        cache_write: number | null;
        cache_write_1h: number | null;
    };
}) {
    const labels = [
        ['input', '输入'],
        ['output', '输出'],
        ['cache_read', '缓存读取'],
        ['cache_write', rates.cache_write_1h !== null ? '缓存写入 / 5 分钟' : '缓存写入'],
        ['cache_write_1h', '缓存写入 / 1 小时'],
    ] as const;
    return (
        <dl className="m-0 space-y-2 text-sm">
            {labels.flatMap(([key, label]) =>
                rates[key] === null
                    ? []
                    : [
                          <div key={key} className="flex justify-between gap-3">
                              <dt className="text-muted-ink">{label}</dt>
                              <dd className="m-0 break-all font-medium tabular-nums text-navy">
                                  {`¥${formatTieredPrice(rates[key])}`}
                              </dd>
                          </div>,
                      ],
            )}
        </dl>
    );
}
