import type { TierPricing } from '@/lib/models/machine-catalog';

export const SD_SPECIAL_GROUP = 'SD特惠';

type Resolution = '480p' | '720p' | '1080p';
type Variant = readonly [sku: string, minSeconds: number, maxSeconds: number];
type VideoSpec = { withVideo: Variant; withoutVideo: Variant };

// Current new-api channel has one 1080p SKU. The separate AIGAS no-video SKU is not configured.
const fullHd = ['sd-2.5-1080P', 4, 30] as const;

// Exact new-api IDs from the 2026-11-21 SD特惠 acceptance record. Keep cost and retail prices in their existing stores.
export const SD_SPECIAL_MODELS = {
    'sd-2-mini': {
        '480p': { withVideo: ['sd-2-mini-480', 5, 15], withoutVideo: ['sd-2-mini-480-novideo', 4, 15] },
        '720p': { withVideo: ['sd-2-mini-720', 4, 15], withoutVideo: ['sd-2-mini-720-novideo', 4, 15] },
    },
    'sd-2-fast': {
        '480p': { withVideo: ['sd-2-fast-480', 4, 15], withoutVideo: ['sd-2-fast-480-novideo', 4, 15] },
        '720p': { withVideo: ['sd-2-fast-720', 4, 15], withoutVideo: ['sd-2-fast-720-novideo', 4, 15] },
    },
    'sd-2-vip': {
        '480p': { withVideo: ['sd-2-vip-480', 4, 15], withoutVideo: ['sd-2-vip-480-novideo', 4, 15] },
        '720p': { withVideo: ['sd-2-vip-720', 5, 15], withoutVideo: ['sd-2-vip-720-novideo', 4, 15] },
    },
    'sd-2.5': {
        '480p': { withVideo: ['sd-2.5-480P', 4, 30], withoutVideo: ['sd-2.5-480P-novideo', 4, 30] },
        '720p': { withVideo: ['sd-2.5-720P', 4, 30], withoutVideo: ['sd-2.5-720P-novideo', 4, 30] },
        '1080p': { withVideo: fullHd, withoutVideo: fullHd },
    },
    'sd-2.5-flash': {
        '480p': { withVideo: ['sd-2.5-flash-480P', 4, 30], withoutVideo: ['sd-2.5-flash-480-novideo', 4, 30] },
        '720p': { withVideo: ['sd-2.5-flash-720P', 4, 30], withoutVideo: ['sd-2.5-flash-720-novideo', 4, 30] },
    },
} as const satisfies Record<string, Partial<Record<Resolution, VideoSpec>>>;

export type SdSpecialModel = keyof typeof SD_SPECIAL_MODELS;

export function isSdSpecialPublicModel(id: string): id is SdSpecialModel {
    return Object.hasOwn(SD_SPECIAL_MODELS, id);
}

export function isSdSpecialLegacyModel(id: string): boolean {
    return (
        /^(?:sd-2-(?:mini|fast|vip)|sd-2\.5(?:-flash)?)-(?:480|720|1080)p?(?:-novideo|-限时特价)?$/i.test(id) ||
        /^sd-2\.(?:0(?:-fast|-mini)?|5)-官方版-(?:480|720|1080)p?$/i.test(id)
    );
}

export function sdSpecialSpecs(model: SdSpecialModel): [Resolution, VideoSpec][] {
    return Object.entries(SD_SPECIAL_MODELS[model]) as [Resolution, VideoSpec][];
}

const publicModelBySku = new Map<string, SdSpecialModel>();
for (const model of Object.keys(SD_SPECIAL_MODELS).filter(isSdSpecialPublicModel)) {
    for (const [, spec] of sdSpecialSpecs(model)) {
        publicModelBySku.set(spec.withVideo[0], model);
        publicModelBySku.set(spec.withoutVideo[0], model);
    }
}

export function sdSpecialPublicModelForSku(sku: string): SdSpecialModel | undefined {
    return publicModelBySku.get(sku);
}

/** Rewrite the model field in both supported video task envelopes. */
export function exposeSdSpecialTaskModel(body: unknown): boolean {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const task = body as Record<string, unknown>;
    let changed = false;
    for (const candidate of [task, task.data]) {
        if (
            !candidate ||
            typeof candidate !== 'object' ||
            !('model' in candidate) ||
            typeof candidate.model !== 'string'
        )
            continue;
        const model = sdSpecialPublicModelForSku(candidate.model);
        if (model) {
            candidate.model = model;
            changed = true;
        }
    }
    return changed;
}

export function resolveSdSpecialVideoRequest(body: Record<string, unknown>, model: SdSpecialModel) {
    const resolution = typeof body.resolution === 'string' ? body.resolution.toLowerCase() : '';
    const specs = sdSpecialSpecs(model);
    const spec = specs.find(([key]) => key === resolution)?.[1];
    if (!spec) return { error: `${model} requires resolution: ${specs.map(([key]) => key).join(', ')}` } as const;

    const references = body.references;
    if (
        references != null &&
        (!Array.isArray(references) ||
            references.some((item) => !item || typeof item !== 'object' || Array.isArray(item)))
    ) {
        return { error: 'references must be an array of reference objects' } as const;
    }
    const hasVideo = Array.isArray(references) && references.some((item) => item.type === 'video');
    const [sku, min, max] = hasVideo ? spec.withVideo : spec.withoutVideo;
    const duration = body.duration;
    if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < min || duration > max) {
        return {
            error: `duration must be an integer between ${min} and ${max} seconds for ${model} at ${resolution}`,
        } as const;
    }
    return { body: { ...body, model: sku, resolution } } as const;
}

/** Join prices only after each exact SKU has been scoped and priced for the viewer's group. */
export function sdSpecialPrices(
    model: SdSpecialModel,
    priceFor: (sku: string) => TierPricing | null | undefined,
): TierPricing | null {
    const without: Record<string, number> = {};
    const withVideo: Record<string, number> = {};
    function rate(sku: string, resolution: Resolution) {
        const details = priceFor(sku)?.billing_details;
        if (details?.mode !== 'media' || details.unit !== 'cny_per_second' || details.scheduled_discount) return null;
        return details.resolution_prices[resolution] ?? details.default_price;
    }
    for (const [resolution, spec] of sdSpecialSpecs(model)) {
        const off = rate(spec.withoutVideo[0], resolution);
        const on = rate(spec.withVideo[0], resolution);
        if (off != null) without[resolution] = off;
        if (on != null) withVideo[resolution] = on;
    }
    if (!Object.keys(without).length && !Object.keys(withVideo).length) return null;
    return {
        input_cny_per_1m: null,
        output_cny_per_1m: null,
        per_image_cny: null,
        billing_details: {
            version: 1,
            mode: 'media',
            unit: 'cny_per_second',
            default_price: null,
            resolution_prices: without,
            reference_video_prices: withVideo,
        },
    };
}
