export interface ChannelGroupRetirementUpstream {
    status: 'missing' | 'present' | 'unknown';
    message: string;
}

export interface ChannelGroupRetirementPreview {
    group: {
        id: string;
        key: string;
        display_name: string;
        newapi_group: string | null;
        is_default: boolean;
        enabled: boolean;
    };
    models: {
        id: string;
        slug: string;
        display_name: string;
        was_enabled: boolean;
        will_disable: boolean;
        remaining_tiers: string[];
    }[];
    existing_keys: { active: number; total: number };
    default_candidates: { id: string; key: string; display_name: string }[];
    replacement_default_id: string | null;
    upstream: ChannelGroupRetirementUpstream;
    issues: { code: string; message: string }[];
    canApply: boolean;
    preview_token: string;
    group_resolution?: {
        source: 'history' | 'current_keys' | 'already_absent';
        message: string;
    };
    /** Absent only on the legacy Portal-only preview. New revocation previews always include this. */
    revocation?: {
        keys: ChannelGroupRetirementKeyPreview[];
        customers: number;
        expected_group: string | null;
        orphaned: boolean;
        archive_only?: boolean;
    };
}

export interface ChannelGroupRetirementResult {
    archive_only?: boolean;
    group_key: string;
    group_name: string;
    updated_models: number;
    disabled_models: number;
    existing_keys: { active: number; total: number };
    replacement_default_name: string | null;
    revoked_keys?: number;
    already_absent_keys?: number;
}

export interface ChannelGroupRetirementKeyPreview {
    id: string;
    label: string;
    user_id: string;
    status: 'ready' | 'already_absent' | 'missing' | 'blocked' | 'unknown';
    actual_group: string | null;
    message: string;
}

export type ChannelGroupRetirementJobStatus = 'queued' | 'running' | 'needs_attention' | 'succeeded' | 'cancelled';

export interface ChannelGroupRetirementJobView {
    id: string;
    tenant_id: string | null;
    group_key: string;
    group_name: string;
    newapi_group: string | null;
    orphaned: boolean;
    archive_only?: boolean;
    status: ChannelGroupRetirementJobStatus;
    message: string;
    summary: {
        total: number;
        confirmed: number;
        pending: number;
        failed: number;
        revoked: number;
        already_absent: number;
    };
    keys: {
        id: string;
        label: string;
        user_id: string;
        status: 'pending' | 'revoking' | 'confirmed' | 'already_absent' | 'blocked';
        message: string;
    }[];
    canResume: boolean;
    canStop: boolean;
    created_at: string;
    updated_at: string;
    result: ChannelGroupRetirementResult | null;
}

export interface ChannelGroupRetirementOrphan {
    tenant_id: string | null;
    tier_key: string;
    key_count: number;
    active_key_count: number;
}
