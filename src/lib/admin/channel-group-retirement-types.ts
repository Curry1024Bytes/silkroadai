export interface ChannelGroupRetirementUpstream {
    status: 'missing' | 'present' | 'unknown';
    message: string;
}

export interface ChannelGroupRetirementPreview {
    group: {
        id: string;
        key: string;
        display_name: string;
        newapi_group: string;
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
}

export interface ChannelGroupRetirementResult {
    group_key: string;
    group_name: string;
    updated_models: number;
    disabled_models: number;
    existing_keys: { active: number; total: number };
    replacement_default_name: string | null;
}
