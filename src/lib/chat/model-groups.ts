/**
 * Chat UI — server-authoritative model → routing-group resolver.
 *
 * Why
 * ---
 * new-api groups are pricing tiers (GroupRatio: default 1×, official 2.46×,
 * official-gpt 7.29×). A customer's default-group token can only route models
 * served by a `default`-group channel; models that live ONLY in a pricier
 * group (e.g. `claude-fable-5` in the `official` channel) 503 under `default`.
 *
 * To let the chat reach every model at the correct per-group price, the
 * stream route resolves each model's group HERE (server-side, not trusting
 * the client) and asks for a system token pinned to that group
 * (getOrCreateSystemToken(userId, group)).
 *
 * Group choice = the CHEAPEST group (lowest GroupRatio) that has an enabled
 * channel serving the model — mirrors new-api's own "auto" routing. So a
 * model available in both `default` and `official` routes `default` (1×);
 * an `official`-only model routes `official` (2.46×). Unknown / unmapped
 * models fall back to `default` (no worse than today).
 *
 * Built from `listChannels()` + the `GroupRatio` option, cached briefly.
 * Never throws — on any upstream hiccup callers degrade to `default`.
 *
 * Server-only.
 */
import 'server-only';
import { listChannels, getOption } from '@/lib/newapi/client';

export const DEFAULT_GROUP = 'default';

export interface ModelGroupInfo {
    /** Cheapest group serving the model. */
    group: string;
    /** That group's GroupRatio (absolute, e.g. 1 / 2.4615 / 7.2913). */
    ratio: number;
    /** ratio relative to the default group (>1 ⇒ premium). For the picker badge. */
    multiplier: number;
}

interface ModelGroupCache {
    at: number;
    map: Map<string, ModelGroupInfo>;
}

const TTL_MS = 60_000;
let cache: ModelGroupCache | null = null;

function parseRatios(raw: string | null): Record<string, number> {
    if (!raw) return {};
    try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') {
            const out: Record<string, number> = {};
            for (const [k, v] of Object.entries(obj)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
            return out;
        }
    } catch {
        /* malformed option — treat as no ratios */
    }
    return {};
}

function csv(v: unknown): string[] {
    return String(v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

async function build(): Promise<Map<string, ModelGroupInfo>> {
    const [channels, ratioRaw] = await Promise.all([listChannels(), getOption('GroupRatio')]);
    const ratios = parseRatios(ratioRaw);
    const defaultRatio = ratios[DEFAULT_GROUP] ?? 1;

    // model → set of groups served by an ENABLED channel.
    const modelToGroups = new Map<string, Set<string>>();
    for (const ch of channels) {
        if ((ch.status as number) !== 1) continue; // 1 = enabled
        const groups = csv(ch.group);
        if (groups.length === 0) continue;
        for (const model of csv(ch.models)) {
            let set = modelToGroups.get(model);
            if (!set) {
                set = new Set<string>();
                modelToGroups.set(model, set);
            }
            for (const g of groups) set.add(g);
        }
    }

    const ratioOf = (g: string): number => ratios[g] ?? (g === DEFAULT_GROUP ? 1 : Number.POSITIVE_INFINITY);

    const map = new Map<string, ModelGroupInfo>();
    for (const [model, groups] of modelToGroups) {
        let bestGroup = DEFAULT_GROUP;
        let bestRatio = Number.POSITIVE_INFINITY;
        for (const g of groups) {
            const r = ratioOf(g);
            // Lower ratio wins; on a tie prefer the literal default group.
            if (r < bestRatio || (r === bestRatio && g === DEFAULT_GROUP)) {
                bestRatio = r;
                bestGroup = g;
            }
        }
        if (!Number.isFinite(bestRatio)) bestRatio = defaultRatio; // all-unknown ratios → treat as default
        map.set(model, {
            group: bestGroup,
            ratio: bestRatio,
            multiplier: defaultRatio > 0 ? bestRatio / defaultRatio : 1,
        });
    }
    return map;
}

/** The model→group map, cached for TTL_MS. Never throws — returns the last
 *  good map (or empty) on upstream failure. */
export async function getModelGroupMap(): Promise<Map<string, ModelGroupInfo>> {
    const now = Date.now();
    if (cache && now - cache.at < TTL_MS) return cache.map;
    try {
        const map = await build();
        cache = { at: now, map };
        return map;
    } catch (err) {
        console.warn('[model-groups] build failed:', err);
        return cache?.map ?? new Map();
    }
}

/**
 * Server-authoritative routing group for a model. Unknown / unmapped → the
 * default group. NEVER throws — the chat route depends on this resolving.
 */
export async function resolveModelGroup(model: string): Promise<string> {
    const map = await getModelGroupMap();
    return map.get(model)?.group ?? DEFAULT_GROUP;
}

/** Test seam: drop the cache between unit tests. */
export function _resetModelGroupCacheForTest(): void {
    cache = null;
}
