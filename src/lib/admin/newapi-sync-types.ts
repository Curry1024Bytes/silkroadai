/** Public sync metadata only. Never include complete new-api channel/options objects. */
export interface NewApiSyncItem {
    id: string;
    kind: 'group' | 'model' | 'price';
    change: 'create' | 'update' | 'publish' | 'unpublish';
    title: string;
    before: string[];
    after: string[];
}

export interface NewApiSyncSummary {
    groups_created: number;
    groups_updated: number;
    models_published: number;
    models_unpublished: number;
    models_updated: number;
    prices_updated: number;
}

export interface NewApiSyncPreview {
    preview_token: string;
    items: NewApiSyncItem[];
    summary: NewApiSyncSummary;
    warnings: string[];
    /** Set when the aligned catalog would be inconsistent; nothing can be applied. */
    blocked: string | null;
    unchanged: { groups: number; models: number; prices: number };
}

export interface NewApiSyncResponse {
    dryRun: boolean;
    preview: NewApiSyncPreview;
    applied?: { groups: number; models: number; prices: number };
}
