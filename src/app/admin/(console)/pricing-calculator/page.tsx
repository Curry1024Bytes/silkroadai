import { redirect } from 'next/navigation';

type CalculatorSearchParams = Record<string, string | string[] | undefined>;

// Keep old bookmarks working inside the existing admin authentication layout.
// Only presentation preferences belong in the destination URL; never carry a
// legacy token or arbitrary query parameters into the pricing workbench.
export default async function PricingCalculatorPage({
    searchParams,
}: {
    searchParams: Promise<CalculatorSearchParams>;
}) {
    const query = await searchParams;
    const params = new URLSearchParams();
    const allowed = {
        lang: ['zh', 'en'],
        theme: ['light', 'dark'],
        ui_mode: ['standalone', 'embedded'],
    };

    for (const [key, values] of Object.entries(allowed)) {
        const value = query[key];
        if (typeof value === 'string' && values.includes(value)) params.set(key, value);
    }

    const suffix = params.toString();
    redirect(`/admin/pricing${suffix ? `?${suffix}` : ''}`);
}
