import 'server-only';

/**
 * LiteLLM maintains a machine-readable aggregation of public model prices.
 * This is a reference source for the operator calculator only: it never
 * changes Portal catalog prices or new-api billing options.
 */
export const LITELLM_PRICE_SOURCES = [
    {
        id: 'litellm-cdn',
        label: 'LiteLLM CDN',
        url: 'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json',
    },
    {
        id: 'litellm-github',
        label: 'LiteLLM GitHub',
        url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
    },
    {
        id: 'litellm-backup',
        label: 'LiteLLM GitHub backup',
        url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/model_prices_and_context_window_backup.json',
    },
] as const;

const CACHE_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;

export interface OfficialModelPrice {
    model: string;
    provider: string | null;
    inputUsdPer1m: number;
    outputUsdPer1m: number;
    cacheReadUsdPer1m: number;
    cacheWrite5mUsdPer1m: number;
    cacheWrite1hUsdPer1m: number | null;
}

export interface OfficialPriceCatalog {
    source: (typeof LITELLM_PRICE_SOURCES)[number]['id'];
    sourceLabel: string;
    fetchedAt: string;
    models: OfficialModelPrice[];
}

type Fetcher = typeof fetch;
type RawPriceEntry = Record<string, unknown>;

let cachedCatalog: { expiresAt: number; value: OfficialPriceCatalog } | null = null;
let pendingCatalog: Promise<OfficialPriceCatalog> | null = null;

function positiveNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function perMillion(value: unknown): number | null {
    const perToken = positiveNumber(value);
    return perToken === null ? null : perToken * 1_000_000;
}

/** Convert LiteLLM's per-token fields into the calculator's USD-per-1M shape. */
export function parseLiteLlmPriceCatalog(raw: unknown): OfficialModelPrice[] {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('LiteLLM price data is not a model dictionary');
    }

    const models: OfficialModelPrice[] = [];
    for (const [model, entry] of Object.entries(raw as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const price = entry as RawPriceEntry;
        const inputUsdPer1m = perMillion(price.input_cost_per_token);
        const outputUsdPer1m = perMillion(price.output_cost_per_token);

        // A calculator needs both normal input and output prices. Entries that
        // only describe embeddings, images, or provider metadata are excluded.
        if (inputUsdPer1m === null || inputUsdPer1m <= 0 || outputUsdPer1m === null || outputUsdPer1m <= 0) {
            continue;
        }

        const provider = typeof price.litellm_provider === 'string' ? price.litellm_provider : null;
        models.push({
            model,
            provider,
            inputUsdPer1m,
            outputUsdPer1m,
            cacheReadUsdPer1m: perMillion(price.cache_read_input_token_cost) ?? 0,
            cacheWrite5mUsdPer1m: perMillion(price.cache_creation_input_token_cost) ?? 0,
            cacheWrite1hUsdPer1m: perMillion(price.cache_creation_input_token_cost_above_1hr),
        });
    }

    if (models.length === 0) throw new Error('LiteLLM price data contains no chat token prices');
    return models.sort((a, b) => a.model.localeCompare(b.model));
}

/**
 * Fetch one complete catalog, trying the same source order used by llmprice.cn.
 * The function is exported separately so tests can verify fallback behavior
 * without touching the process-wide cache.
 */
export async function fetchLiteLlmPriceCatalog(fetcher: Fetcher = fetch): Promise<OfficialPriceCatalog> {
    const failures: string[] = [];

    for (const source of LITELLM_PRICE_SOURCES) {
        try {
            const response = await fetcher(source.url, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const models = parseLiteLlmPriceCatalog(await response.json());
            return { source: source.id, sourceLabel: source.label, fetchedAt: new Date().toISOString(), models };
        } catch (error) {
            failures.push(`${source.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    throw new Error(`LiteLLM price sources are unavailable (${failures.join('; ')})`);
}

/** Cached service-side catalog. A browser never fetches or caches the external source itself. */
export async function getLiteLlmPriceCatalog(): Promise<OfficialPriceCatalog> {
    if (cachedCatalog && cachedCatalog.expiresAt > Date.now()) return cachedCatalog.value;
    if (pendingCatalog) return pendingCatalog;

    pendingCatalog = fetchLiteLlmPriceCatalog()
        .then((value) => {
            cachedCatalog = { value, expiresAt: Date.now() + CACHE_TTL_MS };
            return value;
        })
        .finally(() => {
            pendingCatalog = null;
        });
    return pendingCatalog;
}

function normalized(value: string): string {
    return value.trim().toLowerCase();
}

/** Find the most relevant reference prices without returning the full upstream catalog to the browser. */
export function searchOfficialModelPrices(
    models: OfficialModelPrice[],
    query: string,
    limit = 20,
): OfficialModelPrice[] {
    const q = normalized(query);
    if (!q) return [];

    return models
        .map((model) => {
            const name = normalized(model.model);
            const provider = normalized(model.provider ?? '');
            let score = 0;
            if (name === q) score = 4;
            else if (name.endsWith(`/${q}`) || name.endsWith(`.${q}`)) score = 3;
            else if (name.includes(q)) score = 2;
            else if (provider.includes(q)) score = 1;
            return { model, score };
        })
        .filter((candidate) => candidate.score > 0)
        .sort((a, b) => b.score - a.score || a.model.model.localeCompare(b.model.model))
        .slice(0, limit)
        .map((candidate) => candidate.model);
}
