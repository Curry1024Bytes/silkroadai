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
}

export interface PricingPublishPreviewRow {
    model_id: string;
    model_name: string;
    tier: string;
    group: string;
    before: PricingPublishAmounts | null;
    after: PricingPublishAmounts;
}

export interface PricingPublishPreview {
    preview_token: string;
    expires_at: string;
    upstream_model: string;
    basis: 'token' | 'request';
    rows: PricingPublishPreviewRow[];
    warnings: string[];
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
