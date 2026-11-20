import type { BrowserTier } from './catalog-browser-types';
import type { TypeName } from './categorize';
import type { TierPricing } from './machine-catalog';

export interface PlazaPriceBreakdown {
    base: TierPricing;
    groupMultiplier: number;
    dynamic: boolean;
}

/** Explicit Portal tariffs; never reverse-engineered into new-api ratio fields. */
export interface PlazaTariffs {
    type: TypeName;
    tiers: BrowserTier[];
    pricesByTier: Record<string, TierPricing | null>;
    breakdownByTier?: Record<string, PlazaPriceBreakdown>;
}

export interface PlazaViewer {
    id: string;
    newapi_user_id?: number | null;
    newapi_access_token?: string | null;
}
