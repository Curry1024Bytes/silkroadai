/**
 * Rebuild a new-api channel's short aliases by:
 *   (a) appending short names to channel.models (so the request router matches)
 *   (b) writing channel.model_mapping[short] = canonical (so the channel
 *       translates the short back to upstream's canonical name on forward)
 *
 * Both writes are required: the router decides which channel handles a
 * request by literal lookup in channel.models BEFORE applying mapping. If
 * a short isn't in `models`, the request 503s with "no available channel"
 * regardless of what model_mapping says.
 *
 * Run after every channel edit / upstream expansion to prevent gotcha #15
 * regression (短名静默失效 → 客户 503).
 *
 * Short name rule: split canonical by '/', take last segment, lowercase.
 *   deepseek-ai/DeepSeek-V4-Flash      -> deepseek-v4-flash
 *   Qwen/Qwen2.5-72B-Instruct          -> qwen2.5-72b-instruct
 *   Pro/deepseek-ai/DeepSeek-V3        -> deepseek-v3
 *   LoRA/Qwen/Qwen2.5-72B-Instruct     -> qwen2.5-72b-instruct
 *   gpt-4o                              -> (no slash, skip)
 *
 * Tier resolution (when multiple canonicals collapse to same short):
 *   Pro/  (SiliconFlow paid tier)  > vendor/  (Free tier)  > LoRA/  (experimental fine-tunes)
 * Lower-priority canonical loses; the loss is logged as a "resolved" entry,
 * NOT a conflict. Same-tier ties (e.g. two Pro/ models with same last segment)
 * are reported as true conflicts and refuse to apply.
 *
 * Why Pro > Free as default: SiliconFlow free tier has rate limits / quotas
 * that surface as cryptic errors; Pro tier is what portal customers actually
 * pay for. (W3 D2.5, decision by user 2026-05-03.)
 *
 * Usage:
 *   pnpm tsx scripts/rebuild-channel-model-mapping.ts <channel_id>           # dry-run
 *   pnpm tsx scripts/rebuild-channel-model-mapping.ts <channel_id> --apply   # PUT to new-api
 *   pnpm tsx scripts/rebuild-channel-model-mapping.ts <channel_id> --no-tier-resolution
 *       Disable Pro>Free>LoRA precedence; report every multi-canonical short
 *       as a raw conflict. Diagnostic only.
 *
 * Reads NEWAPI_BASE_URL / NEWAPI_ADMIN_TOKEN / NEWAPI_ADMIN_USER_ID from .env.
 */
import 'dotenv/config';

/* eslint-disable @typescript-eslint/no-explicit-any */

const BASE = process.env.NEWAPI_BASE_URL!;
const TOKEN = process.env.NEWAPI_ADMIN_TOKEN!;
const ADMIN_UID = process.env.NEWAPI_ADMIN_USER_ID!;

const channelId = process.argv[2];
const apply = process.argv.includes('--apply');
const noTierResolution = process.argv.includes('--no-tier-resolution');
if (!channelId || channelId.startsWith('--')) {
    console.error(
        'usage: pnpm tsx scripts/rebuild-channel-model-mapping.ts <channel_id> [--apply] [--no-tier-resolution]',
    );
    process.exit(1);
}

function shortName(canonical: string): string | null {
    if (!canonical.includes('/')) return null;
    const last = canonical.split('/').pop();
    if (!last) return null;
    const lower = last.toLowerCase();
    if (lower === canonical.toLowerCase()) return null;
    return lower;
}

interface Tier {
    priority: number;
    label: string;
}
function tierOf(canonical: string): Tier {
    if (canonical.startsWith('Pro/')) return { priority: 1, label: 'Pro' };
    if (canonical.startsWith('LoRA/')) return { priority: 3, label: 'LoRA' };
    return { priority: 2, label: 'Free' };
}

async function api(path: string, init?: RequestInit) {
    const r = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
            Authorization: TOKEN,
            'New-Api-User': ADMIN_UID,
            'Content-Type': 'application/json',
            ...(init?.headers || {}),
        },
    });
    const text = await r.text();
    let json: any;
    try {
        json = JSON.parse(text);
    } catch {
        json = { _raw: text };
    }
    return { status: r.status, json };
}

async function main() {
    // 1. read current channel
    const get = await api(`/api/channel/${channelId}`);
    if (get.status !== 200) {
        console.error('GET channel failed', get.status, get.json);
        process.exit(2);
    }
    const ch: any = get.json.data ?? get.json;
    console.log(`channel: id=${ch.id} name=${ch.name} type=${ch.type}`);

    const models: string[] = (ch.models || '')
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
    console.log(`models count: ${models.length}`);

    // 2. parse existing mapping
    let existing: Record<string, string> = {};
    const raw = ch.model_mapping;
    if (typeof raw === 'string' && raw.trim()) {
        try {
            existing = JSON.parse(raw);
        } catch {
            console.warn('existing mapping not parseable JSON, treating as empty');
        }
    } else if (raw && typeof raw === 'object') {
        existing = raw as Record<string, string>;
    }
    console.log(`existing mapping entries: ${Object.keys(existing).length}`);

    // 3. compute desired (with tier-based resolution unless --no-tier-resolution)
    const desired: Record<string, string> = { ...existing };
    const conflicts: Array<[string, string, string]> = []; // truly tied (same tier)
    const resolved: Array<{ short: string; winner: string; loser: string; reason: string }> = [];
    let added = 0;
    let kept = 0;

    for (const canonical of models) {
        const short = shortName(canonical);
        if (!short) continue;
        const incumbent = desired[short];
        if (!incumbent) {
            desired[short] = canonical;
            added++;
            continue;
        }
        if (incumbent === canonical) {
            kept++;
            continue;
        }
        if (noTierResolution) {
            conflicts.push([short, incumbent, canonical]);
            continue;
        }
        const incomingT = tierOf(canonical);
        const incumbentT = tierOf(incumbent);
        if (incomingT.priority < incumbentT.priority) {
            // incoming wins — upgrade
            resolved.push({
                short,
                winner: canonical,
                loser: incumbent,
                reason: `${incomingT.label}(p${incomingT.priority}) > ${incumbentT.label}(p${incumbentT.priority})`,
            });
            desired[short] = canonical;
        } else if (incomingT.priority > incumbentT.priority) {
            // incumbent wins — log decision but no change
            resolved.push({
                short,
                winner: incumbent,
                loser: canonical,
                reason: `${incumbentT.label}(p${incumbentT.priority}) > ${incomingT.label}(p${incomingT.priority})`,
            });
        } else {
            // tie at same priority — real conflict
            conflicts.push([short, incumbent, canonical]);
        }
    }

    console.log(`will add: ${added}`);
    console.log(`already mapped (kept): ${kept}`);
    console.log(`resolved by tier policy: ${resolved.length}`);
    console.log(`conflicts (same-tier ties): ${conflicts.length}`);

    if (resolved.length) {
        console.log('tier resolutions (short, winner -> loser, reason):');
        for (const r of resolved) {
            console.log(`  ${r.short}  WIN=${r.winner}  LOSE=${r.loser}  [${r.reason}]`);
        }
    }
    if (conflicts.length) {
        console.log('conflict details (short -> existing | new):');
        for (const [s, ex, nw] of conflicts) console.log(`  ${s}  ->  ${ex}  |  ${nw}`);
    }

    // 4. show sample new entries
    const sampleEntries = Object.entries(desired)
        .filter(([k]) => !existing[k])
        .slice(0, 12);
    console.log('sample new entries:');
    for (const [k, v] of sampleEntries) console.log(`  ${k}  ->  ${v}`);

    if (!apply) {
        console.log('\n[dry-run] not applied. re-run with --apply to PUT.');
        return;
    }

    if (conflicts.length) {
        console.error('\n❌ same-tier conflicts present, refusing to apply. Resolve manually first.');
        process.exit(3);
    }

    // 5. compute new models field (existing models + winner shorts not already there).
    // Short additions are required for the router to match the request — see
    // header comment for why this is separate from model_mapping.
    const modelSet = new Set(models);
    const shortsToAdd: string[] = [];
    for (const short of Object.keys(desired)) {
        if (!modelSet.has(short)) shortsToAdd.push(short);
    }
    console.log(`shorts to append to channel.models: ${shortsToAdd.length}`);
    const newModels = [...models, ...shortsToAdd].join(',');

    // 6. PUT — must include full channel object (gotcha #15: omitted fields get
    // silently cleared, that's exactly how we ended up here in the first place).
    ch.model_mapping = JSON.stringify(desired);
    ch.models = newModels;
    const put = await api('/api/channel/', {
        method: 'PUT',
        body: JSON.stringify(ch),
    });
    console.log(`PUT status: ${put.status}`, put.json?.message || put.json);
    if (put.status !== 200 || put.json?.success === false) {
        console.error('PUT failed');
        process.exit(4);
    }

    // 7. verify (cache bust ~6s). new-api caches channel data for ~60s, but
    // 6s catches the obvious "PUT didn't take" case. Real model-call routing
    // can take longer to refresh; the regression test step is the truth.
    await new Promise((r) => setTimeout(r, 6000));
    const verify = await api(`/api/channel/${channelId}`);
    const verifyCh: any = verify.json.data ?? verify.json;
    let after: Record<string, string> = {};
    const arawAfter = verifyCh.model_mapping;
    if (typeof arawAfter === 'string' && arawAfter.trim()) after = JSON.parse(arawAfter);
    else if (arawAfter && typeof arawAfter === 'object') after = arawAfter as Record<string, string>;
    const verifyModels = (verifyCh.models || '').split(',').filter(Boolean);
    console.log(`verified models in channel.models: ${verifyModels.length}`);
    console.log(`verified mapping entries after PUT: ${Object.keys(after).length}`);
    console.log(`deepseek-v4-flash mapped:`, after['deepseek-v4-flash'] || '(missing)');
    console.log(`deepseek-v4-flash in models?`, verifyModels.includes('deepseek-v4-flash'));
    console.log(`deepseek-v3 mapped:`, after['deepseek-v3'] || '(missing)');
    console.log(`deepseek-v3 in models?`, verifyModels.includes('deepseek-v3'));
}

main().catch((e) => {
    console.error(e);
    process.exit(99);
});
