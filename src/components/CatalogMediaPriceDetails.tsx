import { catalogDetailLines, type CatalogBillingDetails } from '@/lib/models/catalog-pricing-details';

export default function CatalogMediaPriceDetails({
    details,
    en = false,
}: {
    details: Exclude<CatalogBillingDetails, { mode: 'tiered_token' }>;
    en?: boolean;
}) {
    return (
        <div className="space-y-1 text-xs">
            {catalogDetailLines(details, en).map((line, index) => (
                <p className="m-0" key={index}>
                    {line}
                </p>
            ))}
        </div>
    );
}
