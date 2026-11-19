/** Customer prices are absolute fractions of an explicitly confirmed official reference. */
export interface OfficialPriceCell {
    key: string;
    label: string;
    unit: 'million_tokens' | 'call';
    official_cny: number;
    public_cny: number;
    base_cny: number;
    cost_cny: number | null;
}

export interface OfficialModelContext {
    model_id: string;
    model_name: string;
    display_name: string;
    tier_key: string;
    public_group: string;
    public_ratio: number;
    source_channel_ids: number[];
    reference_revision: string | null;
    reference_source: string | null;
    reference_available: boolean;
    unavailable_reason: string | null;
    shape: string;
    cells: OfficialPriceCell[];
    public_official_multiplier: number | null;
    current_official_multiplier: number | null;
    current_ratio: number;
    current_rule_scope: 'model' | 'tier' | 'legacy' | null;
}

export interface OfficialCustomerRule {
    id: string;
    tier_key: string;
    model_id: string | null;
    official_multiplier: number;
    revision: number;
}

export interface OfficialPricingTier {
    key: string;
    display_name: string;
    public_group: string;
    public_ratio: number;
    legacy_multiplier: number | null;
    models: OfficialModelContext[];
    binding_status: string | null;
}

export interface OfficialPricingView {
    version: string;
    tiers: OfficialPricingTier[];
    rules: OfficialCustomerRule[];
    pending_changes?: { id: string; tier_key: string; status: string }[];
}

export interface OfficialPricingDraft {
    tier_key: string;
    model_id: string | null;
    /** null removes the selected rule; it never represents a free price. */
    official_multiplier: number | null;
}

export interface OfficialPricingPreviewCell {
    model_id: string;
    model_name: string;
    label: string;
    unit: 'million_tokens' | 'call';
    official_cny: number;
    cost_cny: number | null;
    before_cny: number;
    target_cny: number;
    actual_cny: number;
    margin: number | null;
    rule_scope: 'model' | 'tier' | 'legacy' | null;
    official_multiplier: number | null;
}

export interface OfficialPricingPreview {
    version: string;
    hash: string;
    draft: OfficialPricingDraft;
    cells: OfficialPricingPreviewCell[];
    below_cost: boolean;
    has_increases: boolean;
    blocked: string[];
    warnings: string[];
    affected_keys: number;
}

/** Public presentation metadata, with no provider cost or internal billing group identifiers. */
export interface CustomerPriceDisplay {
    basis: 'official' | 'public';
    multiplier: number;
    scope: 'model' | 'tier';
    public_official_multiplier: number | null;
    official_multiplier: number | null;
}

/** A prepared native group carries exactly one client-facing model. */
export interface NativeModelPrice {
    model_id: string;
    model_name: string;
    group: string;
    public_ratio: number;
    customer_ratio: number;
    source_channel_ids: number[];
    replica_channel_ids: number[];
    source_fingerprint?: string;
}

export interface NativeTokenBinding {
    group: string;
    auto_groups: string[] | null;
    cross_group_retry: boolean;
}
