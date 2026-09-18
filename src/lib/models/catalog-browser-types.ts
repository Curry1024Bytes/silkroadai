import type { TierPricing } from '@/lib/models/machine-catalog';

export interface BrowserTier {
    key: string;
    label: string;
    isDefault: boolean;
}

export interface BrowserModelPricing {
    slug: string;
    /** Keys are current, validated memberships. A null value means that tier has no published price. */
    pricesByTier: Record<string, TierPricing | null>;
}

export interface BrowserCatalog {
    tiers: BrowserTier[];
    models: BrowserModelPricing[];
}
