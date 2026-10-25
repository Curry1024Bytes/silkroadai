import 'server-only';
import type {
    Modality,
    ModelCapability,
    PricingData,
    PricingModel,
    PricingVendor,
} from '@newapi/features/pricing/types';
import type { BrowserCatalog } from './catalog-browser-types';
import { loadBrowserCatalog } from './catalog-browser';
import { classifyModels, TYPE_BADGE } from './categorize';
import type { PlazaViewer } from './plaza-types';

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}
function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 4000) : undefined;
}

const ENDPOINT_TYPES = new Set([
    'openai',
    'openai-response',
    'anthropic',
    'gemini',
    'jina-rerank',
    'image-generation',
    'embeddings',
    'openai-video',
]);
const MODALITIES = new Set<Modality>(['text', 'image', 'audio', 'video', 'file']);
const CAPABILITIES = new Set<ModelCapability>([
    'function_calling',
    'streaming',
    'vision',
    'json_mode',
    'structured_output',
    'reasoning',
    'tools',
    'system_prompt',
    'web_search',
    'code_interpreter',
    'caching',
    'embeddings',
]);

/** Metadata is optional. A failure never substitutes a different pricing source. */
async function readMetadata(viewer: PlazaViewer | null): Promise<unknown> {
    try {
        const response = await fetch(new URL('/api/pricing', process.env.NEWAPI_BASE_URL || 'http://localhost:3000'), {
            headers: {
                Accept: 'application/json',
                ...(viewer?.newapi_access_token && viewer.newapi_user_id != null
                    ? { Authorization: viewer.newapi_access_token, 'New-Api-User': String(viewer.newapi_user_id) }
                    : {}),
            },
            signal: AbortSignal.timeout(2500),
            cache: 'no-store',
        });
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    }
}

/** Allowlist descriptive metadata; upstream models, groups, ratios and expressions cannot create catalog entries. */
export function adaptPlazaCatalog(catalog: BrowserCatalog, rawMetadata: unknown): PricingData {
    const payload = record(rawMetadata);
    const metadata = payload?.success === true && Array.isArray(payload.data) ? payload.data : [];
    const byName = new Map<string, Record<string, unknown>>();
    for (const item of metadata) {
        const model = record(item);
        if (model && typeof model.model_name === 'string') byName.set(model.model_name, model);
    }
    const upstreamVendors = new Map<number, Record<string, unknown>>();
    if (payload?.success === true && Array.isArray(payload.vendors)) {
        for (const item of payload.vendors) {
            const vendor = record(item);
            if (vendor && typeof vendor.id === 'number') upstreamVendors.set(vendor.id, vendor);
        }
    }
    const rawEndpoints = payload?.success === true ? (record(payload.supported_endpoint) ?? {}) : {};
    const endpoints: PricingData['supported_endpoint'] = {};
    for (const [key, value] of Object.entries(rawEndpoints)) {
        const endpoint = record(value);
        const path = text(endpoint?.path);
        if (
            ENDPOINT_TYPES.has(key) &&
            path &&
            /^\/(?:v1|v1beta)\/[A-Za-z0-9_./:{}-]+$/.test(path) &&
            !path.split('/').some((segment) => segment === '.' || segment === '..')
        ) {
            endpoints[key] = { path, method: 'POST' };
        }
    }
    const vendors: PricingVendor[] = [];
    const vendorIds = new Map<string, number>();
    const entries = new Map(
        classifyModels(catalog.models.map((model) => model.slug)).entries.map((entry) => [entry.shortName, entry]),
    );
    const data: PricingModel[] = catalog.models.flatMap((model, index) => {
        const entry = entries.get(model.slug);
        if (!entry) return [];
        const meta = byName.get(model.slug);
        const upstreamVendor = typeof meta?.vendor_id === 'number' ? upstreamVendors.get(meta.vendor_id) : undefined;
        const vendorName = text(upstreamVendor?.name) ?? entry.vendor;
        let vendorId = vendorIds.get(vendorName);
        if (vendorId === undefined) {
            vendorId = vendors.length + 1;
            vendorIds.set(vendorName, vendorId);
            vendors.push({
                id: vendorId,
                name: vendorName,
                icon: text(upstreamVendor?.icon),
                description: text(upstreamVendor?.description),
            });
        }
        const endpointTypes = Array.isArray(meta?.supported_endpoint_types)
            ? meta.supported_endpoint_types.filter(
                  (value): value is string => typeof value === 'string' && Object.hasOwn(endpoints, value),
              )
            : [];
        const result: PricingModel = {
            id: index + 1,
            model_name: model.slug,
            vendor_id: vendorId,
            vendor_name: vendorName,
            vendor_icon: text(upstreamVendor?.icon),
            description: text(meta?.description),
            icon: text(meta?.icon),
            tags: [TYPE_BADGE[entry.type], text(meta?.tags)].filter(Boolean).join(','),
            enable_groups: Object.keys(model.pricesByTier),
            supported_endpoint_types: endpointTypes,
            portal: { type: entry.type, tiers: catalog.tiers, pricesByTier: model.pricesByTier },
        };
        // These values come from actual model metadata, never seeded capability guesses.
        for (const key of ['context_length', 'max_output_tokens'] as const) {
            const value = meta?.[key];
            if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) result[key] = value;
        }
        for (const key of ['knowledge_cutoff', 'release_date', 'parameter_count'] as const) {
            const value = text(meta?.[key]);
            if (value) result[key] = value;
        }
        for (const key of ['input_modalities', 'output_modalities'] as const) {
            const value = meta?.[key];
            if (Array.isArray(value)) result[key] = value.filter((item): item is Modality => MODALITIES.has(item));
        }
        if (Array.isArray(meta?.capabilities)) {
            result.capabilities = meta.capabilities.filter((item): item is ModelCapability => CAPABILITIES.has(item));
        }
        return [result];
    });
    return {
        success: true,
        data,
        vendors,
        group_ratio: {},
        usable_group: Object.fromEntries(catalog.tiers.map((tier) => [tier.key, { desc: tier.label }])),
        supported_endpoint: endpoints,
        auto_groups: [],
        portal_tiers: catalog.tiers,
    };
}

export async function loadPlazaData(viewer: PlazaViewer | null): Promise<PricingData> {
    const catalog = await loadBrowserCatalog(viewer?.id);
    return {
        ...adaptPlazaCatalog(catalog, await readMetadata(viewer)),
        portal_viewer_key: viewer?.id ?? 'anonymous',
        portal_snapshot: Date.now(),
    };
}
