import {
    formatTieredPrice,
    parseTieredPricingDetails,
    tieredPricingConditionLabel,
} from '@/lib/models/tiered-pricing-details';

/** The same verified tariff is retained in both the current catalog and its history. */
export default function CatalogTieredPriceDetails({ raw, en }: { raw: unknown; en: boolean }) {
    let details;
    try {
        details = parseTieredPricingDetails(raw);
    } catch {
        return <p className="mt-1 text-xs text-amber-600">{en ? 'Tiered prices need review' : '阶梯价格待核对'}</p>;
    }
    if (!details) return null;
    return (
        <details className="mt-2 max-w-xl text-xs">
            <summary className="cursor-pointer font-medium text-emerald-600">
                {en ? 'Tiered prices · view all rates' : '阶梯价 · 查看完整价格'}
            </summary>
            <p className="my-2">
                {en
                    ? 'Rates in CNY / million tokens. Full input length selects one tier for the whole request.'
                    : '单位：元／百万 token。按完整输入长度选档，整次请求使用该档价格。'}
            </p>
            <div className="space-y-2">
                {details.tiers.map((tier) => (
                    <div key={tier.name} className="rounded border border-slate-400/30 p-2">
                        <p className="font-medium">{tieredPricingConditionLabel(tier, en)}</p>
                        <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-4 gap-y-1">
                            {(
                                [
                                    ['input', en ? 'Input' : '输入'],
                                    ['output', en ? 'Output' : '输出'],
                                    ['cache_read', en ? 'Cache read' : '缓存读取'],
                                    ['cache_write', en ? 'Cache write' : '缓存写入'],
                                    ['cache_write_1h', en ? 'Cache write · 1h' : '缓存写入 · 1 小时'],
                                ] as const
                            ).flatMap(([key, label]) => {
                                const value = tier.rates[key];
                                return value === null
                                    ? []
                                    : [
                                          <dt key={`${key}-label`}>{label}</dt>,
                                          <dd key={key}>¥{formatTieredPrice(value)}</dd>,
                                      ];
                            })}
                        </dl>
                    </div>
                ))}
            </div>
        </details>
    );
}
