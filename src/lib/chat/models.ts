/**
 * Chat UI v1 — server-side model list helper.
 *
 * The chat picker only wants models a customer can actually *converse*
 * with: the `chat` and `vision` type buckets from `categorizeByType`
 * (vision models accept plain text too, so they're valid chat targets).
 * Pure image-gen / audio / embedding models are excluded — picking an
 * embedding model in a chat box would just 4xx upstream.
 *
 * We reuse the existing catalog plumbing (`listAvailableModels` →
 * new-api `/api/channel/models_enabled`, then `groupModels` for the
 * type × vendor classification) so the chat picker stays in lockstep
 * with the public /models page. Zero new schema, zero new upstream
 * calls beyond the one the /models page already makes.
 *
 * Server-only — this reaches for the new-api admin client.
 */
import 'server-only';
import { listAvailableModels } from '@/lib/newapi/client';
import { groupModels, VENDOR_ORDER, type TypeName, type VendorName, type GroupedModels } from '@/lib/models/categorize';
import { getModelGroupMap } from './model-groups';

/** Type buckets that are valid chat targets. Vision models accept text
 *  prompts, so they belong here; everything else does not. */
const CHAT_TYPES: readonly TypeName[] = ['chat', 'vision'] as const;

export interface ChatModel {
    /** Wire name passed to /v1/chat/completions `model`. */
    id: string;
    vendor: VendorName;
    /** True when this model is in the `vision` type bucket (accepts image
     *  input). The chat UI uses it to gate the image-upload button — a
     *  non-vision model handed an image just 4xx's upstream. */
    vision: boolean;
    /** new-api routing group this model bills through (cheapest serving
     *  group). Attached by listChatModels from channel data; undefined in
     *  the pure collapse test seam. */
    group?: string;
    /** Price multiplier vs the default group (>1 ⇒ premium tier). Drives the
     *  picker's price badge so customers aren't surprise-billed. */
    priceMultiplier?: number;
}

export interface ChatModelGroup {
    vendor: VendorName;
    models: ChatModel[];
}

export interface ChatModelList {
    /** Vendor-grouped, in VENDOR_ORDER, for the picker dropdown. */
    groups: ChatModelGroup[];
    /** Flat de-duplicated list — used for default selection + validation. */
    flat: ChatModel[];
    totalModels: number;
}

/** Collapse the chat+vision type buckets of a GroupedModels structure
 *  into a vendor-grouped, de-duplicated chat model list. A model that
 *  is classified as both chat and vision (shouldn't happen — first match
 *  wins in categorizeByType — but defensive) is kept once. */
function collapseChatModels(grouped: GroupedModels): ChatModelList {
    const byVendor = new Map<VendorName, ChatModel[]>();
    const seen = new Set<string>();

    for (const type of CHAT_TYPES) {
        const typeBucket = grouped[type];
        if (!typeBucket) continue;
        for (const vendor of VENDOR_ORDER) {
            const entries = typeBucket[vendor];
            if (!entries) continue;
            for (const entry of entries) {
                if (seen.has(entry.shortName)) continue;
                seen.add(entry.shortName);
                const list = byVendor.get(vendor) ?? [];
                // `type` is the outer CHAT_TYPES loop var; a model lands in
                // exactly one type bucket (categorizeByType → single type),
                // so this flag is authoritative.
                list.push({ id: entry.shortName, vendor, vision: type === 'vision' });
                byVendor.set(vendor, list);
            }
        }
    }

    const groups: ChatModelGroup[] = VENDOR_ORDER.filter((v) => (byVendor.get(v)?.length ?? 0) > 0).map((vendor) => ({
        vendor,
        models: byVendor.get(vendor)!,
    }));

    const flat = groups.flatMap((g) => g.models);
    return { groups, flat, totalModels: flat.length };
}

/**
 * Fetch the chat-capable model list for the picker. Never throws — on a
 * new-api hiccup it returns an empty list so the page can render an
 * error/empty state instead of crashing (mirrors /models page behavior).
 */
export async function listChatModels(): Promise<ChatModelList> {
    let raw: string[] = [];
    try {
        raw = await listAvailableModels();
    } catch (err) {
        console.warn('[chat/models] listAvailableModels failed:', err);
        return { groups: [], flat: [], totalModels: 0 };
    }
    const { grouped } = groupModels(raw);
    const list = collapseChatModels(grouped);

    // Attach each model's routing group + price multiplier (premium tiers) so
    // the picker can flag pricier models. `flat` and `groups` share the same
    // ChatModel object refs, so one pass updates both. Best-effort —
    // getModelGroupMap never throws; on a miss the model just has no badge.
    const gmap = await getModelGroupMap();
    for (const m of list.flat) {
        const info = gmap.get(m.id);
        if (info) {
            m.group = info.group;
            m.priceMultiplier = info.multiplier;
        }
    }
    return list;
}

/** Test seam: collapse a pre-grouped structure without an upstream call. */
export const _collapseChatModelsForTest = collapseChatModels;
