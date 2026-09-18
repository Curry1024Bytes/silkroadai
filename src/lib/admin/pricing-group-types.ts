import type { PricingCostCapability, PricingCostConfig } from './pricing-cost-types';

export interface PricingGroupTier {
    id: string;
    key: string;
    label: string;
    newapi_group: string;
}

export type PricingGroupModelStatus =
    | 'ready'
    | 'missing_price'
    | 'unregistered'
    | 'unregistered_channel'
    | 'inactive'
    | 'invalid_mapping'
    | 'ambiguous'
    | 'unsupported';

export interface PricingGroupModel {
    /** Stable identity even when new-api has no matching Portal catalog row. */
    id: string;
    model_id: string | null;
    slug: string | null;
    display_name: string;
    upstream_model: string;
    channel_ids: number[];
    status: PricingGroupModelStatus;
    /** The operator may select this row after completing any missing quote. */
    selectable: boolean;
    /** Complete, valid quote suitable for the initial selection. */
    ready: boolean;
    config: PricingCostConfig | null;
    saved_revision: number | null;
    saved_rule_id: string | null;
    capability: PricingCostCapability | null;
    reason: string | null;
    base_source: 'saved' | 'reference' | 'manual' | 'none';
    reference_model: string | null;
}

export interface PricingGroupCatalog {
    tier: PricingGroupTier;
    fingerprint: string;
    models: PricingGroupModel[];
    reference_error: string | null;
    /** Portal-only retired mappings do not become members of the live upstream group. */
    notices?: string[];
    counts: { total: number; ready: number; needs_price: number; unavailable: number };
}
