/** Public sync metadata only. Never include complete new-api channel/options objects. */
export interface NewApiSyncItem {
    id: string;
    kind: 'group' | 'model' | 'price';
    change: 'new' | 'update' | 'unavailable' | 'missing';
    title: string;
    before: string[];
    after: string[];
    notes: string[];
    selectable: boolean;
    defaultSelected: boolean;
    /** Explicit opt-in to enabling a new/disabled tier or publishing a model. */
    canActivate: boolean;
    dependsOn: string[];
}

export interface NewApiSyncPreview {
    preview_token: string;
    items: NewApiSyncItem[];
    warnings: string[];
    unchanged: { groups: number; models: number; prices: number };
}

export interface NewApiSyncSelection {
    selected: string[];
    activate: string[];
}

export interface NewApiSyncResponse {
    dryRun: boolean;
    preview: NewApiSyncPreview;
    applied?: { groups: number; models: number; prices: number };
}
