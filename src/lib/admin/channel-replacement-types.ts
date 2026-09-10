export interface ReplacementChannel {
    id: number;
    name: string;
    status: number | null;
    groups: string[];
    models: string[];
    owner: string | null;
}

export interface ReplacementGroup {
    id: string;
    key: string;
    display_name: string;
    newapi_group: string;
    newapi_channel_ids: number[];
    enabled: boolean;
}

export interface ChannelReplacementOptions {
    group: ReplacementGroup;
    channels: ReplacementChannel[];
}

export interface ChannelReplacementPreview {
    group: ReplacementGroup;
    source_channel_id: number;
    target: ReplacementChannel;
    next_channel_ids: number[];
    models: {
        id: string;
        slug: string;
        display_name: string;
        enabled: boolean;
        upstream_model: string;
        supported: boolean;
    }[];
    issues: { code: string; message: string }[];
    canApply: boolean;
    preview_token: string;
}
