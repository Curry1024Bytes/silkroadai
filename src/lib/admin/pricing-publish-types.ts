/** Public pricing publication contracts. All monetary values use CNY numbers, never Decimal strings. */
export interface PricingPublishAmounts {
    input_cny_per_1m: number | null;
    output_cny_per_1m: number | null;
    per_image_cny: number | null;
}

export interface PricingPublishInput extends PricingPublishAmounts {
    model_id: string;
    tier: string;
    cost_cny_per_1m: number | null;
    /** Only the cost workflow may explicitly adjust an already configured resolution SKU. */
    pricing_mode?: 'standard' | 'fixed_image';
    /** Explicit cached-token target; only a verified tiered expression can publish this. */
    cache_read_cny_per_1m?: number;
}

export interface TieredPricingDetails {
    version: 1;
    mode: 'tiered_token';
    unit: 'cny_per_million_tokens';
    semantics: 'whole_request';
    tiers: Array<{
        name: string;
        min_input_tokens: number | null;
        max_input_tokens: number | null;
        min_inclusive: boolean;
        max_inclusive: boolean;
        rates: {
            input: number;
            output: number;
            cache_read: number | null;
            cache_write: number | null;
            cache_write_1h: number | null;
        };
    }>;
}

export interface PricingPublishPreviewRow {
    model_id: string;
    model_name: string;
    tier: string;
    group: string;
    before: PricingPublishAmounts | null;
    after: PricingPublishAmounts;
    before_details?: TieredPricingDetails | null;
    after_details?: TieredPricingDetails;
}

export interface PricingPublishPreview {
    preview_token: string;
    expires_at: string;
    upstream_model: string;
    basis: 'token' | 'request';
    rows: PricingPublishPreviewRow[];
    warnings: string[];
    batch?: { count: number; upstream_models: string[] };
    publication_mode?: 'tiered_token' | 'uniform_token';
    unchanged?: boolean;
    customer_overrides?: Array<{
        group: string;
        ratio: number;
        public_ratio: number;
        count: number;
        before: TieredPricingDetails;
        after: TieredPricingDetails;
    }>;
}

export type PricingPublishJobStatus = 'queued' | 'retry_wait' | 'conflict' | 'failed' | 'succeeded' | 'cancelled';

export interface PricingPublishJob {
    id: string;
    status: PricingPublishJobStatus;
    message: string;
    attempts: number;
    created_at: string;
    updated_at: string;
    next_attempt_at: string | null;
    upstream_model: string;
}
