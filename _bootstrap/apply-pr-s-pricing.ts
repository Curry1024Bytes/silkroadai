#!/usr/bin/env tsx
/**
 * PR-S — Gemini family + ChatGPT image-2 pricing apply.
 *
 * Sister script to `apply-w7-pricing.ts` (which wrote channel-level
 * ratios at launch). PR-S writes GLOBAL options instead — operator
 * decision per the PR-S brief Stage 3:
 *
 *   - text / embedding / per-token audio  → ModelRatio + CompletionRatio
 *   - image / video / per-call audio       → ModelPrice (flat USD per call)
 *
 * Both are global JSON dicts persisted on the new-api `option` table
 * and exposed via `GET /api/option/` (array-of-{key,value}). To update
 * one we PUT /api/option/ with body {key, value:"<json string>"}.
 *
 * Markup policy (per operator):
 *   - Image (Gemini + OpenAI image-2):  retail = wholesale × 1.5
 *   - Text / video / audio / embedding: retail = wholesale × 1.0  (zero
 *     markup; operator plans to swap to cheaper upstreams post-launch
 *     to recover margin without changing customer-facing prices)
 *
 * Conventions match `apply-w7-pricing.ts`:
 *   - QuotaPerUnit = 1_000_000 (W7 D2 Phase 2)
 *   - mr (model_ratio) = USD per 1M input tokens
 *   - cr (completion_ratio) = output_per_M / input_per_M
 *   - ModelPrice value = USD per call (per-image / per-second / per-request,
 *     unit determined by the model itself; new-api just bills flat)
 *
 * Channel-level mutation:
 *   - PUT /api/channel/<id> with `models` field rewritten to drop the
 *     7 SKUs operator marked disabled. Other channel fields (model_mapping,
 *     base_url, etc.) are preserved verbatim — gotcha #15 hot zone.
 *
 * Usage:
 *   tsx _bootstrap/apply-pr-s-pricing.ts            # dry-run (default)
 *   tsx _bootstrap/apply-pr-s-pricing.ts --apply    # PUT live
 *
 * Pre-reqs:
 *   - SSH tunnel: ssh -fN -L 3000:localhost:3000 vps
 *   - Env: NEWAPI_BASE_URL, NEWAPI_ADMIN_TOKEN, NEWAPI_ADMIN_USER_ID
 */
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

const NEWAPI_BASE_URL = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';
const NEWAPI_ADMIN_TOKEN = process.env.NEWAPI_ADMIN_TOKEN;
const NEWAPI_ADMIN_USER_ID = process.env.NEWAPI_ADMIN_USER_ID;

if (!NEWAPI_ADMIN_TOKEN || !NEWAPI_ADMIN_USER_ID) {
    console.error('Missing NEWAPI_ADMIN_TOKEN or NEWAPI_ADMIN_USER_ID. Aborting.');
    process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const GEMINI_CHANNEL_ID = 4;
const SUB2API_OPENAI_CHANNEL_ID = 3;

// =============================================================================
// PRICING TABLES — operator-supplied PR-S Stage 3 spec
// =============================================================================

/** Text + embedding + per-token audio. Markup 1.0 (retail = wholesale).
 *  cr = output / input. For embedding-only models, cr = 1 (no output token tier). */
const PER_TOKEN_USD: Record<string, { in: number; out: number; note?: string }> = {
    // Text — Gemini 2.5 family (already in ModelRatio at older promo values; we overwrite to current Google prices)
    'gemini-2.5-flash': { in: 0.30, out: 2.50, note: 'Google docs current ($0.30/$2.50)' },
    'gemini-2.5-pro': { in: 1.25, out: 10.00, note: '≤200k tier — operator chose lower tier' },
    // Text — Gemini 3.1 family (newly priced)
    'gemini-3.1-flash-lite': { in: 0.25, out: 1.50 },
    'gemini-3.1-pro-preview': { in: 4.00, out: 18.00, note: '>200k long-context tier per Google docs' },
    'gemini-3.1-pro-preview-customtools': { in: 4.00, out: 18.00, note: 'shares parent tier' },
    // Embedding (cr=1 — no separate output)
    'gemini-embedding-2': { in: 0.20, out: 0.20, note: 'embedding: cr=1' },
    // Audio per-token
    'gemini-3.1-flash-tts-preview': { in: 1.00, out: 20.00, note: 'audio output tier' },
    'gemini-2.5-flash-native-audio-latest': { in: 1.00, out: 2.50, note: '2.5 flash audio tier' },
};

/** Per-image flat fee. Markup 1.5. Applied as ModelPrice (USD per image). */
const PER_IMAGE_USD: Record<string, { wholesale: number; note?: string }> = {
    'gemini-2.5-flash-image-preview': { wholesale: 0.039, note: 'Google: nano-banana 2.5 flash image, $0.039/image standard' },
    'gemini-3.1-flash-image-preview': { wholesale: 0.10, note: 'Google: midpoint of $0.045-$0.151 per resolution' },
    'gemini-3-pro-image-preview': { wholesale: 0.187, note: 'Google: midpoint of $0.134-$0.24 per resolution' },
    'nano-banana-pro-preview': { wholesale: 0.187, note: 'Operator: same as gemini-3-pro-image-preview alias' },
    'imagen-4.0-ultra-generate-001': { wholesale: 0.06, note: 'Google: Ultra tier $0.06/image' },
    'gpt-image-2': { wholesale: 0.04, note: 'OpenAI standard quality — operator-stated $0.04/image' },
};

/** Per-second video. Markup 1.0. ModelPrice (USD per second). 720p tier default. */
const PER_SECOND_USD: Record<string, { wholesale: number; note?: string }> = {
    'veo-3.1-generate-preview': { wholesale: 0.40, note: '720p/1080p tier (4K is $0.60/sec — not default)' },
    'veo-3.1-fast-generate-preview': { wholesale: 0.10, note: '720p tier (1080p is $0.12, 4K $0.30)' },
    'veo-3.1-lite-generate-preview': { wholesale: 0.05, note: '720p tier (1080p is $0.08)' },
};

/** Per-request flat fee (audio gen). Markup 1.0. ModelPrice (USD per request). */
const PER_REQUEST_USD: Record<string, { wholesale: number; note?: string }> = {
    'lyria-3-pro-preview': { wholesale: 0.08 },
    'lyria-3-clip-preview': { wholesale: 0.08, note: 'shares lyria-3-pro tier' },
};

/** SKUs to remove from Gemini channel.models (no public pricing or operator-marked deprecated). */
const DISABLE_FROM_GEMINI_CHANNEL = [
    'aqa',
    'gemini-2.5-pro-preview-tts',
    'gemini-3.1-flash-live-preview',
    'gemini-robotics-er-1.6-preview',
    'deep-research-pro-preview-12-2025',
    'deep-research-preview-04-2026',
    'deep-research-max-preview-04-2026',
];

/** Markup multipliers — kept as named constants so the diff makes the
 *  policy choice explicit + reviewable. */
const MARKUP_IMAGE = 1.5;
const MARKUP_TEXT = 1.0; // text / embedding / audio per-token
const MARKUP_VIDEO = 1.0;
const MARKUP_AUDIO_FLAT = 1.0;

// =============================================================================
// HELPERS
// =============================================================================

interface Option {
    key: string;
    value: string;
}

interface Channel {
    id: number;
    name: string;
    type: number;
    models: string;
    [k: string]: unknown;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await fetch(NEWAPI_BASE_URL + path, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            Authorization: NEWAPI_ADMIN_TOKEN!,
            'New-Api-User': NEWAPI_ADMIN_USER_ID!,
            ...(init.headers || {}),
        },
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`${init.method || 'GET'} ${path} ${r.status}: ${txt.slice(0, 200)}`);
    const env = txt ? JSON.parse(txt) : {};
    if (env.success === false) throw new Error(`${init.method || 'GET'} ${path} envelope failure: ${env.message}`);
    return (env.data ?? env) as T;
}

async function fetchOptionMap(): Promise<Record<string, string>> {
    const arr = await api<Option[]>('/api/option/');
    const out: Record<string, string> = {};
    for (const o of arr) out[o.key] = o.value;
    return out;
}

function parseOptionJson(value: string | undefined): Record<string, number> {
    if (!value) return {};
    try {
        const v = JSON.parse(value);
        return typeof v === 'object' && v !== null ? (v as Record<string, number>) : {};
    } catch {
        return {};
    }
}

function fmt(n: number): string {
    return n.toFixed(4).replace(/\.?0+$/, '');
}

function parseModels(csv: string | null | undefined): string[] {
    if (!csv) return [];
    return csv.split(',').map((s) => s.trim()).filter(Boolean);
}

// =============================================================================
// PLAN — compute the merged ModelRatio / CompletionRatio / ModelPrice
// =============================================================================

interface Plan {
    /** Diffs grouped by option key. */
    modelRatioMerged: Record<string, number>;
    completionRatioMerged: Record<string, number>;
    modelPriceMerged: Record<string, number>;
    /** Per-key list of new+changed entries (for the report). */
    modelRatioChanges: Array<{ key: string; oldVal: number | undefined; newVal: number; note?: string }>;
    completionRatioChanges: Array<{ key: string; oldVal: number | undefined; newVal: number; note?: string }>;
    modelPriceChanges: Array<{ key: string; oldVal: number | undefined; newVal: number; note?: string }>;
    /** Channel-4 model set after dropping disabled SKUs. */
    geminiChannelModels: string[];
    geminiChannelDropped: string[];
    /** Sanity flag: brief lists 19 active SKUs but only some live in current channels. */
    notInAnyChannel: string[];
}

function buildPlan(
    options: Record<string, string>,
    geminiChannel: Channel,
    sub2apiOpenaiChannel: Channel,
): Plan {
    const oldMr = parseOptionJson(options['ModelRatio']);
    const oldCr = parseOptionJson(options['CompletionRatio']);
    const oldMp = parseOptionJson(options['ModelPrice']);

    const newMr = { ...oldMr };
    const newCr = { ...oldCr };
    const newMp = { ...oldMp };

    const modelRatioChanges: Plan['modelRatioChanges'] = [];
    const completionRatioChanges: Plan['completionRatioChanges'] = [];
    const modelPriceChanges: Plan['modelPriceChanges'] = [];

    // Per-token (text / embedding / audio per-token)
    for (const [key, p] of Object.entries(PER_TOKEN_USD)) {
        const mr = +(p.in * MARKUP_TEXT).toFixed(6);
        const cr = p.in > 0 ? +(p.out / p.in).toFixed(6) : 1;
        if (oldMr[key] !== mr) {
            modelRatioChanges.push({ key, oldVal: oldMr[key], newVal: mr, note: p.note });
        }
        if (oldCr[key] !== cr) {
            completionRatioChanges.push({ key, oldVal: oldCr[key], newVal: cr, note: p.note });
        }
        newMr[key] = mr;
        newCr[key] = cr;
    }

    // Per-image (ModelPrice mode, image markup 1.5)
    for (const [key, p] of Object.entries(PER_IMAGE_USD)) {
        const price = +(p.wholesale * MARKUP_IMAGE).toFixed(6);
        if (oldMp[key] !== price) {
            modelPriceChanges.push({ key, oldVal: oldMp[key], newVal: price, note: p.note });
        }
        newMp[key] = price;
    }

    // Per-second (video, ModelPrice mode, markup 1.0)
    for (const [key, p] of Object.entries(PER_SECOND_USD)) {
        const price = +(p.wholesale * MARKUP_VIDEO).toFixed(6);
        if (oldMp[key] !== price) {
            modelPriceChanges.push({ key, oldVal: oldMp[key], newVal: price, note: p.note });
        }
        newMp[key] = price;
    }

    // Per-request (audio gen flat, ModelPrice mode, markup 1.0)
    for (const [key, p] of Object.entries(PER_REQUEST_USD)) {
        const price = +(p.wholesale * MARKUP_AUDIO_FLAT).toFixed(6);
        if (oldMp[key] !== price) {
            modelPriceChanges.push({ key, oldVal: oldMp[key], newVal: price, note: p.note });
        }
        newMp[key] = price;
    }

    // Channel-4 mutation: drop the 7 disabled SKUs.
    const currentGeminiModels = parseModels(geminiChannel.models);
    const dropped: string[] = [];
    const kept: string[] = [];
    for (const m of currentGeminiModels) {
        if (DISABLE_FROM_GEMINI_CHANNEL.includes(m)) dropped.push(m);
        else kept.push(m);
    }

    // Sanity: list operator-priced SKUs that aren't currently in any channel
    // we know about (channels 3 + 4). They'll get a global ratio but be
    // unreachable until added to some channel.
    const allChannelModels = new Set([
        ...kept, // post-disable Gemini channel
        ...parseModels(sub2apiOpenaiChannel.models),
    ]);
    const allPricedSkus = [
        ...Object.keys(PER_TOKEN_USD),
        ...Object.keys(PER_IMAGE_USD),
        ...Object.keys(PER_SECOND_USD),
        ...Object.keys(PER_REQUEST_USD),
    ];
    const notInAnyChannel = allPricedSkus.filter((m) => !allChannelModels.has(m));

    return {
        modelRatioMerged: newMr,
        completionRatioMerged: newCr,
        modelPriceMerged: newMp,
        modelRatioChanges,
        completionRatioChanges,
        modelPriceChanges,
        geminiChannelModels: kept,
        geminiChannelDropped: dropped,
        notInAnyChannel,
    };
}

// =============================================================================
// REPORT
// =============================================================================

function reportPlan(plan: Plan): void {
    console.log('\n────────────────────────────────────────────────────────────────────');
    console.log('PR-S pricing plan');
    console.log('────────────────────────────────────────────────────────────────────');

    console.log('\n[ModelRatio + CompletionRatio] — per-token (text / embedding / audio)');
    for (const c of plan.modelRatioChanges) {
        const old = c.oldVal === undefined ? '—' : fmt(c.oldVal);
        const cr = plan.completionRatioMerged[c.key];
        console.log(`  ${c.key.padEnd(50)} mr ${old.padStart(8)} → ${fmt(c.newVal).padStart(8)}    cr ${fmt(cr).padStart(6)}${c.note ? `   · ${c.note}` : ''}`);
    }

    console.log('\n[ModelPrice] — flat per-call (image / video / per-request audio)');
    for (const c of plan.modelPriceChanges) {
        const old = c.oldVal === undefined ? '—' : `$${fmt(c.oldVal)}`;
        console.log(`  ${c.key.padEnd(50)} ${old.padStart(10)} → $${fmt(c.newVal).padStart(7)}${c.note ? `   · ${c.note}` : ''}`);
    }

    console.log('\n[Channel 4 (Gemini 官方)] — drop disabled SKUs from channel.models');
    console.log(`  before: ${plan.geminiChannelModels.length + plan.geminiChannelDropped.length} models`);
    console.log(`  after : ${plan.geminiChannelModels.length} models`);
    for (const m of plan.geminiChannelDropped) console.log(`    - ${m}`);

    if (plan.notInAnyChannel.length > 0) {
        console.log('\n[heads-up] priced SKUs NOT currently in any channel.models we know about:');
        console.log('  (global ratio applied; will 503 until you add them to a channel)');
        for (const m of plan.notInAnyChannel) console.log(`    ⚠  ${m}`);
    }
}

// =============================================================================
// APPLY
// =============================================================================

async function putOption(key: string, valueObj: Record<string, number>): Promise<void> {
    const value = JSON.stringify(valueObj);
    await api('/api/option/', {
        method: 'PUT',
        body: JSON.stringify({ key, value }),
    });
}

async function putChannelModels(channel: Channel, newModels: string[]): Promise<void> {
    const merged = { ...channel, models: newModels.join(',') };
    await api('/api/channel/', { method: 'PUT', body: JSON.stringify(merged) });
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
    console.log(`PR-S pricing apply ${APPLY ? '(LIVE — will PUT to admin API)' : '(DRY-RUN — pass --apply to write)'}`);
    console.log(`new-api URL: ${NEWAPI_BASE_URL}`);

    const [options, geminiChannel, sub2apiOpenAI] = await Promise.all([
        fetchOptionMap(),
        api<Channel>(`/api/channel/${GEMINI_CHANNEL_ID}`),
        api<Channel>(`/api/channel/${SUB2API_OPENAI_CHANNEL_ID}`),
    ]);

    const plan = buildPlan(options, geminiChannel, sub2apiOpenAI);
    reportPlan(plan);

    if (!APPLY) {
        console.log('\n────────────────────────────────────────────────────────────────────');
        console.log('Dry-run complete. Pass --apply to PUT changes to new-api admin API.');
        console.log('────────────────────────────────────────────────────────────────────');
        return;
    }

    console.log('\n→ PUT /api/option/ ModelRatio (merged)');
    await putOption('ModelRatio', plan.modelRatioMerged);
    console.log('  ✓');

    console.log('→ PUT /api/option/ CompletionRatio (merged)');
    await putOption('CompletionRatio', plan.completionRatioMerged);
    console.log('  ✓');

    console.log('→ PUT /api/option/ ModelPrice (merged)');
    await putOption('ModelPrice', plan.modelPriceMerged);
    console.log('  ✓');

    console.log(`→ PUT /api/channel/${GEMINI_CHANNEL_ID} (drop ${plan.geminiChannelDropped.length} disabled SKUs)`);
    await putChannelModels(geminiChannel, plan.geminiChannelModels);
    console.log('  ✓');

    console.log('\nAll updates applied. Verify with:');
    console.log('  curl -H "Authorization: $NEWAPI_ADMIN_TOKEN" -H "New-Api-User: $NEWAPI_ADMIN_USER_ID" \\');
    console.log('    "$NEWAPI_BASE_URL/api/pricing" | jq \'.data[] | select(.model_name | test("gemini|nano-banana|gpt-image-2|veo-3\\\\.1|lyria|imagen-4|gemma-4"))\' | head -200');
}

main().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
