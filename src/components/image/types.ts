/**
 * Shared types for /image (PR-T2) client components.
 */

export interface ImageGenerationItem {
    id: string;
    prompt: string;
    model_name: string;
    size: string;
    count: number;
    image_urls: string[];
    cost_usd: number;
    is_favorite: boolean;
    created_at: string;
    expires_at: string | null;
}

export interface QuotaSnapshotJson {
    remain_quota: number;
    used_quota: number;
    remain_cny: number;
    used_cny: number;
    remain_usd: number;
    used_usd: number;
    source: 'live' | 'cache' | 'fallback';
    cached_at_iso: string | null;
}

export interface ListPage {
    items: ImageGenerationItem[];
    next_cursor: string | null;
    has_more: boolean;
}
