#!/usr/bin/env tsx
/**
 * ⚠️ OBSOLETE — 2026-05-21 起永久作废
 *
 * 本脚本是 W7 D2(2026-05-06)的 50% promo 应用工具(PROMO_DISCOUNT = 0.5),
 * 已被新永久定价方案替换:`scripts/apply-new-pricing-2026-05-21.mjs`。
 * 新公式:ChatGPT × 0.0714 / Claude × 0.2143(¥0.5 / ¥1.5 抵 $1 官方)。
 * 不要再 --apply 本脚本 — 会把 promo discount 写回去,客户余额扣费会错乱。
 * 历史代码保留作 W7 retro 参考。
 *
 * ───────────── 以下是原 W7 D2 注释 ─────────────
 *
 * W7 D2 Phase 3 — apply post-launch pricing across the 3 channels.
 *
 * Reads the operator-supplied pricing decisions (whitelists + retail
 * prices + SF wholesale + promo discount) from constants below, computes
 * the new {model_ratio, completion_ratio, models} per channel, prints
 * a Before/After diff, and (with --apply) PUTs the changes via
 * new-api admin API at PUT /api/channel/<id>.
 *
 * Conventions
 * -----------
 * After Phase 2 (QuotaPerUnit 500K → 1M, fixed FX ¥7/USD), the cost
 * formula is:
 *   quota_consumed = tokens × model_ratio × group_ratio × (1 if input else completion_ratio)
 *   USD            = quota_consumed / QuotaPerUnit (= 1M)
 *
 * Therefore at QPU=1M:
 *   USD/1M_tokens (input)  = model_ratio × 1
 *   USD/1M_tokens (output) = model_ratio × completion_ratio
 *
 * So `model_ratio` reads as "USD per 1M input tokens" — direct.
 *
 * Promo math (海外渠道 only)
 * --------------------------
 * promo_ratio = retail_ratio × 0.5
 * post_promo_ratio = retail_ratio (Phase 7 exit script multiplies by 2)
 *
 * SF formula (国内渠道,不打折)
 * ---------------------------
 * mr = wholesale_¥_per_1M_input / 5.83    (gives ~20% markup, ~17% margin)
 * cr = wholesale_¥_out / wholesale_¥_in    (preserves output/input ratio)
 *
 * Usage
 * -----
 *   tsx _bootstrap/apply-w7-pricing.ts             # dry-run (default)
 *   tsx _bootstrap/apply-w7-pricing.ts --apply     # PUT to admin API
 *
 * Pre-reqs
 * --------
 *   - SSH tunnel:  ssh -fN -L 3000:localhost:3000 vps
 *   - Env loaded:  NEWAPI_BASE_URL, NEWAPI_ADMIN_TOKEN, NEWAPI_ADMIN_USER_ID
 *   - Phase 2 NOT yet run (this script writes ratios that assume QPU=1M;
 *     they're correct after Phase 2 flips QPU and apply Phase 4 sync,
 *     so the order is: this script's --apply MUST run between Phase 2
 *     and Phase 5 verification, with the maintenance-window strategy
 *     described in the brief)
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

// =============================================================================
// OPERATOR INPUT — REVIEW THESE CAREFULLY BEFORE --apply
// =============================================================================

/**
 * Channel IDs as they exist on prod today (verified 2026-05-06):
 *   1 = siliconflow (type=1 OpenAI-compat, 190 models)
 *   2 = sub2api (type=14 Anthropic Claude, 32 models)
 *   3 = sub2api-openai (type=1 OpenAI, 157 models)
 */
const CHANNEL_IDS = {
    siliconflow: 1,
    sub2apiClaude: 2,
    sub2apiOpenAI: 3,
} as const;

/**
 * Promo discount applied to overseas (sub2api) channels' retail ratios.
 * 0.5 = "promo price = half of retail". Phase 7 exit script multiplies
 * back by 2 to restore retail.
 */
const PROMO_DISCOUNT = 0.5;

/**
 * sub2api Anthropic Claude — keep these 6, delete all other claude-*.
 *
 * Retail prices from anthropic.com/api/pricing (assumed stable for the
 * 4.x family — claude-opus uses the Opus tier price, etc.). cr is
 * output/input retail ratio (Anthropic's family-wide convention is 5x).
 */
const SUB2API_CLAUDE_WHITELIST: Record<string, { retailIn: number; retailOut: number; note?: string }> = {
    'claude-opus-4-7':    { retailIn: 15, retailOut: 75, note: 'Opus 4.x tier' },
    'claude-opus-4-6':    { retailIn: 15, retailOut: 75, note: 'Opus 4.x tier' },
    'claude-opus-4-5':    { retailIn: 15, retailOut: 75, note: 'Opus 4.x tier' },
    'claude-sonnet-4-6':  { retailIn: 3,  retailOut: 15, note: 'Sonnet 4.x tier' },
    'claude-sonnet-4-5':  { retailIn: 3,  retailOut: 15, note: 'Sonnet 4.x tier' },
    'claude-haiku-4-5':   { retailIn: 1,  retailOut: 5,  note: 'Haiku 4.x tier' },
};

/**
 * sub2api-openai — keep these 8, delete all other gpt-* / gpt-image-*.
 *
 * Retail prices: confirmed by operator for gpt-5.5 ($5 input).
 * Other SKUs use plausible defaults based on tier hierarchy:
 *   - gpt-5.2 = baseline (similar to gpt-4.1 tier $2/$8)
 *   - gpt-5.3-codex / gpt-5.4 = mid-flagship (~$3-5 / $12-20)
 *   - gpt-5.4-mini = cost-tier ($0.5/$2)
 *   - gpt-5.5 = top flagship ($5/$25, per operator)
 *   - gpt-4o-audio-preview = audio handling premium ($2.5/$10 best estimate)
 *   - gpt-4o-realtime-preview = realtime + audio premium ($5/$20 best estimate)
 *   - gpt-image-1.5 = per-image priced (skip per-token mr; tag for follow-up)
 *
 * ⚠️  ANY of these where you have authoritative retail prices: edit before --apply.
 */
const SUB2API_OPENAI_WHITELIST: Record<string, { retailIn: number; retailOut: number; note?: string; skipPerTokenRatio?: boolean }> = {
    'gpt-5.2':                    { retailIn: 2.00, retailOut: 8.00,  note: '✱ defaulted: baseline tier (gpt-4.1-similar)' },
    'gpt-5.3-codex':              { retailIn: 3.00, retailOut: 12.00, note: '✱ defaulted: mid-flagship (codex specialty)' },
    'gpt-5.4':                    { retailIn: 5.00, retailOut: 20.00, note: '✱ defaulted: mid-flagship' },
    'gpt-5.4-mini':               { retailIn: 0.50, retailOut: 2.00,  note: '✱ defaulted: cost tier' },
    'gpt-5.5':                    { retailIn: 5.00, retailOut: 25.00, note: 'operator-confirmed $5 input; output assumed $25 (5x)' },
    'gpt-4o-audio-preview':       { retailIn: 2.50, retailOut: 10.00, note: '✱ defaulted: per-token portion of audio model' },
    'gpt-4o-realtime-preview':    { retailIn: 5.00, retailOut: 20.00, note: '✱ defaulted: realtime + audio premium' },
    'gpt-image-1.5':              { retailIn: 0,    retailOut: 0,     skipPerTokenRatio: true, note: 'per-image priced; ratios skipped, model kept in channel' },
};

/**
 * SiliconFlow wholesale — used to derive mr = wholesale_¥/5.83.
 * Mirror of _bootstrap/build-pricing-audit.py SF_WHOLESALE table.
 * Models NOT in this table are subject to the "delete-or-followup"
 * decision based on whether they had any traffic in the last 30 days.
 *
 * W7 D4 PR-K — operator-supplied refresh for the 5/8 launch flagship
 * trio (3 entries, all SF Pro tier; only Pro/ shipped on SF for the
 * 2 new SKUs):
 *   - DeepSeek-V4-Flash:    wholesale revised ¥0.14/¥0.28 → ¥1.00/¥2.00
 *     (W7 D2 was off by ~7×; the value shipped at mr=0.024/cr=2 was
 *     under-charging by the same factor. Real customer count = 0,
 *     internal = 4, so no compensation needed.)
 *   - Pro/zai-org/GLM-5.1:  NEW. SF lists tiered pricing; took the
 *     conservative 32k+ tier (in ¥8 / out ¥28) so the long-context
 *     hit doesn't surprise us at customer first-call time.
 *   - Pro/moonshotai/Kimi-K2.6: NEW. SF wholesale ¥6.50 in / ¥27 out
 *     per 1M (vision + 256K).
 *
 * Retail price math (landing teaser cross-reference):
 *   retail = mr × 7 = (wholesale/5.83) × 7 ≈ wholesale × 1.20
 *   So a wholesale ¥1.00 row shows as retail ¥1.20 on the landing
 *   pricing teaser (PRICING_ROWS in src/app/page.tsx). The teaser
 *   intentionally never displays wholesale — that would be promising
 *   to sell at cost.
 */
const SF_WHOLESALE_CNY: Record<string, { in_cny_per_1m: number; out_cny_per_1m: number; note?: string }> = {
    'deepseek-ai/DeepSeek-V4-Flash':           { in_cny_per_1m: 1.00, out_cny_per_1m: 2.00, note: 'PR-K refresh: W7 D2 was 7× low' },
    'Pro/zai-org/GLM-5.1':                     { in_cny_per_1m: 8.00, out_cny_per_1m: 28.00, note: 'PR-K NEW: SF 32k+ tier (conservative)' },
    'Pro/moonshotai/Kimi-K2.6':                { in_cny_per_1m: 6.50, out_cny_per_1m: 27.00, note: 'PR-K NEW: SF vision/256K tier' },
    'Pro/deepseek-ai/DeepSeek-V3.2':           { in_cny_per_1m: 0.27, out_cny_per_1m: 0.42 },
    'deepseek-ai/DeepSeek-V3.2':               { in_cny_per_1m: 0.27, out_cny_per_1m: 0.42 },
    'Pro/deepseek-ai/DeepSeek-V3.1-Terminus':  { in_cny_per_1m: 0.27, out_cny_per_1m: 1.0 },
    'deepseek-ai/DeepSeek-V3.1-Terminus':      { in_cny_per_1m: 0.27, out_cny_per_1m: 1.0 },
    'Pro/deepseek-ai/DeepSeek-V3':             { in_cny_per_1m: 2.0,  out_cny_per_1m: 8.0,  note: 'web-search early-2025 SF Pro' },
    'deepseek-ai/DeepSeek-V3':                 { in_cny_per_1m: 1.0,  out_cny_per_1m: 2.0,  note: 'web-search early-2025 SF standard' },
    'Pro/deepseek-ai/DeepSeek-R1':             { in_cny_per_1m: 4.0,  out_cny_per_1m: 16.0, note: 'web-search early-2025 SF Pro' },
    'deepseek-ai/DeepSeek-R1':                 { in_cny_per_1m: 4.0,  out_cny_per_1m: 16.0 },
    'Pro/zai-org/GLM-4.7':                     { in_cny_per_1m: 0.42, out_cny_per_1m: 2.2 },
    'zai-org/GLM-4.6':                         { in_cny_per_1m: 0.39, out_cny_per_1m: 1.9 },
    'Pro/moonshotai/Kimi-K2-Instruct-0905':    { in_cny_per_1m: 0.4,  out_cny_per_1m: 2.0 },
    'moonshotai/Kimi-K2-Instruct-0905':        { in_cny_per_1m: 0.4,  out_cny_per_1m: 2.0 },
    'Pro/moonshotai/Kimi-K2-Thinking':         { in_cny_per_1m: 4.0,  out_cny_per_1m: 16.0, note: '2026 estimate' },
    'moonshotai/Kimi-K2-Thinking':             { in_cny_per_1m: 4.0,  out_cny_per_1m: 16.0, note: '2026 estimate' },
    'tencent/Hunyuan-A13B-Instruct':           { in_cny_per_1m: 0.14, out_cny_per_1m: 0.57 },
    'MiniMaxAI/MiniMax-M2.5':                  { in_cny_per_1m: 0.3,  out_cny_per_1m: 1.2 },
    'Pro/MiniMaxAI/MiniMax-M2.5':              { in_cny_per_1m: 0.3,  out_cny_per_1m: 1.2 },
    'Qwen/Qwen3-VL-32B-Instruct':              { in_cny_per_1m: 0.2,  out_cny_per_1m: 0.6 },
    'Qwen/Qwen3-VL-8B-Instruct':               { in_cny_per_1m: 0.18, out_cny_per_1m: 0.68 },
    'BAAI/bge-m3':                             { in_cny_per_1m: 0,    out_cny_per_1m: 0,    note: 'SF promo: free' },
    'Pro/BAAI/bge-m3':                         { in_cny_per_1m: 0,    out_cny_per_1m: 0,    note: 'SF promo: free' },
};

/** mr = wholesale_¥_in / SF_DIVISOR. Gives ~20% markup at ¥7/USD. */
const SF_DIVISOR = 5.83;

/** SF fallback for models lacking wholesale data but having recent calls. */
const SF_FALLBACK_MR = 1.5;
const SF_FALLBACK_CR = 1;

/** Dry-run by default — only writes when --apply is passed. */
const APPLY = process.argv.includes('--apply');

// =============================================================================
// UTILITIES
// =============================================================================

interface Channel {
    id: number;
    name: string;
    type: number;
    models: string;
    model_ratio: string | null;
    completion_ratio: string | null;
    model_mapping?: string | null;
    [k: string]: unknown;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await fetch(NEWAPI_BASE_URL + path, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': NEWAPI_ADMIN_TOKEN!,
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

async function fetchChannel(id: number): Promise<Channel> {
    return api<Channel>(`/api/channel/${id}`);
}

function parseModels(csv: string | null): string[] {
    if (!csv) return [];
    return csv.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseJsonOrEmpty(s: string | null | undefined): Record<string, number> {
    if (!s) return {};
    try {
        const v = JSON.parse(s);
        return typeof v === 'object' && v !== null ? (v as Record<string, number>) : {};
    } catch {
        return {};
    }
}

/** Models with at least 1 type=2 (consume) log row in the last 30 days,
 *  by `model_name`. We use this to decide which SF models without
 *  wholesale data to delete vs keep + tag follow-up. */
async function fetchActiveModelsLast30d(): Promise<Set<string>> {
    // queryLogs admin endpoint with 30-day window. Page through up to 50
    // pages of 1000 = 50k log rows — enough for the post-Phase-1.5 state
    // (which has ~0 logs left in the 30-day window after dev cleanup).
    const cutoffSec = Math.floor(Date.now() / 1000) - 30 * 86400;
    const seen = new Set<string>();
    for (let page = 1; page <= 50; page++) {
        const r = await api<{ items: Array<{ model_name?: string; type: number }>; total: number }>(
            `/api/log/?p=${page}&page_size=1000&type=2&start_timestamp=${cutoffSec}`,
        );
        const items = r.items ?? [];
        for (const log of items) {
            if (log.type === 2 && log.model_name) seen.add(log.model_name);
        }
        if (items.length < 1000) break;
        if (page * 1000 >= (r.total ?? 0)) break;
    }
    return seen;
}

// =============================================================================
// PER-CHANNEL PLANNERS — return the new {models, model_ratio, completion_ratio}
// =============================================================================

interface ChannelPlan {
    /** Comma-separated models string for the channel. */
    models: string;
    /** JSON-encoded model_ratio dict. */
    model_ratio: string;
    /** JSON-encoded completion_ratio dict. */
    completion_ratio: string;
    /** Diff metadata for the dry-run report. */
    diff: {
        kept: string[];
        added: string[];
        removed: string[];
        followUp: string[]; // SF models without wholesale but with traffic
    };
}

function planSub2apiClaude(current: Channel): ChannelPlan {
    const currentModels = new Set(parseModels(current.models));
    const whitelist = Object.keys(SUB2API_CLAUDE_WHITELIST);
    const kept: string[] = [];
    const removed: string[] = [];
    for (const m of currentModels) {
        if ((whitelist as string[]).includes(m)) kept.push(m);
        else removed.push(m);
    }
    const added = whitelist.filter((m) => !currentModels.has(m));

    const mr: Record<string, number> = {};
    const cr: Record<string, number> = {};
    for (const m of whitelist) {
        const wl = SUB2API_CLAUDE_WHITELIST[m];
        // promo input USD = retailIn × 0.5; output cr stays as retail-ratio
        mr[m] = wl.retailIn * PROMO_DISCOUNT;
        cr[m] = wl.retailIn > 0 ? wl.retailOut / wl.retailIn : 1;
    }

    return {
        models: whitelist.join(','),
        model_ratio: JSON.stringify(mr),
        completion_ratio: JSON.stringify(cr),
        diff: { kept, added, removed, followUp: [] },
    };
}

function planSub2apiOpenAI(current: Channel): ChannelPlan {
    const currentModels = new Set(parseModels(current.models));
    const whitelist = Object.keys(SUB2API_OPENAI_WHITELIST);
    const kept: string[] = [];
    const removed: string[] = [];
    for (const m of currentModels) {
        if ((whitelist as string[]).includes(m)) kept.push(m);
        else removed.push(m);
    }
    const added = whitelist.filter((m) => !currentModels.has(m));

    const mr: Record<string, number> = {};
    const cr: Record<string, number> = {};
    for (const m of whitelist) {
        const wl = SUB2API_OPENAI_WHITELIST[m];
        if (wl.skipPerTokenRatio) continue;
        mr[m] = wl.retailIn * PROMO_DISCOUNT;
        cr[m] = wl.retailIn > 0 ? wl.retailOut / wl.retailIn : 1;
    }

    return {
        models: whitelist.join(','),
        model_ratio: JSON.stringify(mr),
        completion_ratio: JSON.stringify(cr),
        diff: { kept, added, removed, followUp: [] },
    };
}

function planSiliconflow(current: Channel, activeModels: Set<string>): ChannelPlan {
    const currentModels = parseModels(current.models);
    const kept: string[] = [];
    const removed: string[] = [];
    const followUp: string[] = [];
    const mr: Record<string, number> = {};
    const cr: Record<string, number> = {};

    for (const m of currentModels) {
        const ws = SF_WHOLESALE_CNY[m];
        if (ws) {
            // Has wholesale → priced via formula
            kept.push(m);
            // Free models (e.g. bge-m3 promo) still get mr=0 — new-api treats
            // 0 as "free" (no quota consumed).
            mr[m] = ws.in_cny_per_1m / SF_DIVISOR;
            cr[m] = ws.in_cny_per_1m > 0
                ? ws.out_cny_per_1m / ws.in_cny_per_1m
                : 1;
        } else if (activeModels.has(m)) {
            // No wholesale, but customers used it → keep + ceiling + flag
            kept.push(m);
            followUp.push(m);
            mr[m] = SF_FALLBACK_MR;
            cr[m] = SF_FALLBACK_CR;
        } else {
            // No wholesale, no traffic → drop
            removed.push(m);
        }
    }

    return {
        models: kept.join(','),
        model_ratio: JSON.stringify(mr),
        completion_ratio: JSON.stringify(cr),
        diff: { kept, added: [], removed, followUp },
    };
}

// =============================================================================
// REPORT
// =============================================================================

function fmt(n: number): string {
    return n.toFixed(4).replace(/\.?0+$/, '');
}

function reportPlan(channelLabel: string, current: Channel, plan: ChannelPlan): void {
    const oldModels = parseModels(current.models);
    const oldMr = parseJsonOrEmpty(current.model_ratio);
    const oldCr = parseJsonOrEmpty(current.completion_ratio);

    console.log(`\n────────────────────────────────────────────────────────────────────`);
    console.log(`Channel: ${channelLabel} (id=${current.id}, type=${current.type})`);
    console.log(`────────────────────────────────────────────────────────────────────`);
    console.log(`  models: ${oldModels.length} → ${plan.diff.kept.length + plan.diff.added.length} (kept ${plan.diff.kept.length} / added ${plan.diff.added.length} / removed ${plan.diff.removed.length})`);

    if (plan.diff.added.length > 0) {
        console.log(`  ADDED (in whitelist but not currently in channel):`);
        for (const m of plan.diff.added) console.log(`    + ${m}`);
    }
    if (plan.diff.removed.length > 0 && plan.diff.removed.length <= 30) {
        console.log(`  REMOVED:`);
        for (const m of plan.diff.removed) console.log(`    - ${m}`);
    } else if (plan.diff.removed.length > 30) {
        console.log(`  REMOVED ${plan.diff.removed.length} models (sample first 10):`);
        for (const m of plan.diff.removed.slice(0, 10)) console.log(`    - ${m}`);
        console.log(`    … and ${plan.diff.removed.length - 10} more`);
    }
    if (plan.diff.followUp.length > 0) {
        console.log(`  FOLLOW-UP (kept at fallback ratio, needs wholesale data):`);
        for (const m of plan.diff.followUp) console.log(`    ! ${m}`);
    }

    const newMr = parseJsonOrEmpty(plan.model_ratio);
    const newCr = parseJsonOrEmpty(plan.completion_ratio);
    console.log(`\n  RATIO TABLE (mr / cr in new-api units; with QPU=1M: mr ≈ USD/1M_input):`);
    const ratioModels = Array.from(new Set([...Object.keys(newMr), ...Object.keys(oldMr)])).sort();
    for (const m of ratioModels) {
        const oldM = oldMr[m] ?? '—';
        const newM = newMr[m] ?? '—';
        const oldC = oldCr[m] ?? '—';
        const newC = newCr[m] ?? '—';
        if (oldM === newM && oldC === newC) continue;
        console.log(`    ${m.padEnd(50)} mr ${String(oldM).padStart(8)} → ${String(typeof newM === 'number' ? fmt(newM) : newM).padStart(8)}    cr ${String(oldC).padStart(6)} → ${String(typeof newC === 'number' ? fmt(newC) : newC).padStart(6)}`);
    }
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
    console.log(`W7 D2 Phase 3 — pricing apply ${APPLY ? '(LIVE — will PUT to admin API)' : '(DRY-RUN — pass --apply to write)'}`);
    console.log(`new-api URL: ${NEWAPI_BASE_URL}`);

    const sf  = await fetchChannel(CHANNEL_IDS.siliconflow);
    const cl  = await fetchChannel(CHANNEL_IDS.sub2apiClaude);
    const ai  = await fetchChannel(CHANNEL_IDS.sub2apiOpenAI);

    console.log(`\nFetching active model usage (last 30 days, type=2 logs) for SF triage...`);
    const active = await fetchActiveModelsLast30d();
    console.log(`  active models in window: ${active.size}`);

    const planClaude = planSub2apiClaude(cl);
    const planOpenAI = planSub2apiOpenAI(ai);
    const planSF     = planSiliconflow(sf, active);

    reportPlan('sub2api Claude (Anthropic)', cl, planClaude);
    reportPlan('sub2api-openai',             ai, planOpenAI);
    reportPlan('siliconflow',                sf, planSF);

    if (!APPLY) {
        console.log(`\n────────────────────────────────────────────────────────────────────`);
        console.log(`Dry-run complete. Pass --apply to PUT changes to new-api admin API.`);
        console.log(`────────────────────────────────────────────────────────────────────`);
        return;
    }

    // Apply: PUT each channel with the new {models, model_ratio, completion_ratio}.
    // We MERGE with the existing channel JSON rather than overwrite — new-api
    // expects the full channel object on PUT, and clearing other fields would
    // wipe model_mapping (gotcha #15 hot zone).
    for (const [label, current, plan] of [
        ['sub2api Claude',     cl, planClaude],
        ['sub2api-openai',     ai, planOpenAI],
        ['siliconflow',        sf, planSF],
    ] as const) {
        const merged = {
            ...current,
            models: plan.models,
            model_ratio: plan.model_ratio,
            completion_ratio: plan.completion_ratio,
        };
        console.log(`\n→ PUT /api/channel/${current.id} (${label})...`);
        await api(`/api/channel/`, { method: 'PUT', body: JSON.stringify(merged) });
        console.log(`  ✓ updated`);
    }

    console.log(`\nAll three channels updated. Next steps:`);
    console.log(`  1. Run scripts/rebuild-channel-model-mapping.ts <sf-channel-id> --apply  (gotcha #15)`);
    console.log(`  2. Phase 5 verification (curl /api/pricing, post-fix audit xlsx)`);
}

main().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
