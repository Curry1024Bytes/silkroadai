/** Operator cost quotes are separate from active retail prices and billing. */
export interface PricingCostConfig {
    version: 1;
    basis: 'token' | 'image' | 'video';
    currency: 'cny' | 'credits';
    credits_per_cny: number;
    upstream_multiplier: number;
    /** Final multiplier on the reference quote; omitted by legacy percentage-based rules. */
    retail_multiplier?: number;
    /** Legacy cost markup; must be zero when retail_multiplier is supplied. */
    markup_percent: number;
    source_note: string;
    token_rates: {
        input: number | null;
        output: number | null;
        cache_read: number | null;
        cache_write: number | null;
    };
    variants: Array<{
        key: string;
        label: string;
        resolution: string;
        audio: 'any' | 'silent' | 'audio';
        reference_video: 'any' | 'without' | 'with';
        price: number;
        minimum_units: number;
        step_units: number;
    }>;
}

export interface PricingCostLine {
    key: string;
    label: string;
    unit: 'million_tokens' | 'image' | 'second';
    cost: number;
    retail: number;
    profit: number;
    margin_percent: number;
}

export interface PricingCostCalculation {
    lines: PricingCostLine[];
    multiplier: number;
}

/** Samples use actual token counts, image counts, or seconds, never millions of units. */
export interface PricingCostSample {
    line: PricingCostLine;
    requested_units: number;
    billed_units: number;
    cost: number;
    retail: number;
    profit: number;
    margin_percent: number;
}

export interface StoredPricingCostRule {
    id: string;
    model_id: string;
    tier: string;
    channel_id: number;
    upstream_model: string;
    revision: number;
    config: PricingCostConfig;
    updated_at: string;
    mapping_current: boolean;
}

export interface PricingCostSelection {
    rule_id: string;
    revision: number;
    variant_key?: string;
}

export interface PricingCostCapability {
    publication_mode?: 'tiered_token';
    model_id: string;
    tier: string;
    basis: 'token' | 'image' | 'video' | 'unknown';
    resolution: string | null;
    publishable: boolean;
    reason: string | null;
}
