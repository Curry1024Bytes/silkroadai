#!/usr/bin/env tsx
/**
 * PR-S follow-up — drop the 3 unrouted gemini-2.5 entries from global
 * options. Operator decision (2026-05-09 post-merge): the 3 SKUs were
 * never added to any channel.models so they 503 anyway; cleaner to
 * remove their ratio entries than leave dangling. To re-introduce
 * later, add to apply-pr-s-pricing.ts PER_TOKEN_USD / PER_IMAGE_USD
 * + the matching channel.models.
 *
 * One-shot — does NOT live in CI / repeat applies. Filename starts
 * with `_` to keep it out of the routine `_bootstrap/*.ts` browse.
 */
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

const NEWAPI_BASE_URL = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';
const NEWAPI_ADMIN_TOKEN = process.env.NEWAPI_ADMIN_TOKEN!;
const NEWAPI_ADMIN_USER_ID = process.env.NEWAPI_ADMIN_USER_ID!;

const APPLY = process.argv.includes('--apply');

const PER_TOKEN_DROP = ['gemini-2.5-flash', 'gemini-2.5-pro'];
const PER_IMAGE_DROP = ['gemini-2.5-flash-image-preview'];

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await fetch(NEWAPI_BASE_URL + path, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            Authorization: NEWAPI_ADMIN_TOKEN,
            'New-Api-User': NEWAPI_ADMIN_USER_ID,
            ...(init.headers || {}),
        },
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`${init.method || 'GET'} ${path} ${r.status}: ${txt.slice(0, 200)}`);
    const env = txt ? JSON.parse(txt) : {};
    if (env.success === false) throw new Error(`${path} failure: ${env.message}`);
    return (env.data ?? env) as T;
}

interface Option {
    key: string;
    value: string;
}

async function main(): Promise<void> {
    console.log(`PR-S 2.5-cleanup ${APPLY ? '(LIVE)' : '(DRY-RUN — pass --apply to write)'}`);
    const opts = await api<Option[]>('/api/option/');
    const map: Record<string, string> = {};
    for (const o of opts) map[o.key] = o.value;

    const mr = JSON.parse(map['ModelRatio'] || '{}') as Record<string, number>;
    const cr = JSON.parse(map['CompletionRatio'] || '{}') as Record<string, number>;
    const mp = JSON.parse(map['ModelPrice'] || '{}') as Record<string, number>;

    console.log('\nWill drop:');
    for (const k of PER_TOKEN_DROP) {
        console.log(`  ModelRatio["${k}"]       = ${mr[k] ?? '(absent)'}`);
        console.log(`  CompletionRatio["${k}"]  = ${cr[k] ?? '(absent)'}`);
        delete mr[k];
        delete cr[k];
    }
    for (const k of PER_IMAGE_DROP) {
        console.log(`  ModelPrice["${k}"]       = $${mp[k] ?? '(absent)'}`);
        delete mp[k];
    }

    if (!APPLY) {
        console.log('\nDry-run only. Pass --apply to PUT.');
        return;
    }

    console.log('\n→ PUT ModelRatio');
    await api('/api/option/', { method: 'PUT', body: JSON.stringify({ key: 'ModelRatio', value: JSON.stringify(mr) }) });
    console.log('  ✓');
    console.log('→ PUT CompletionRatio');
    await api('/api/option/', { method: 'PUT', body: JSON.stringify({ key: 'CompletionRatio', value: JSON.stringify(cr) }) });
    console.log('  ✓');
    console.log('→ PUT ModelPrice');
    await api('/api/option/', { method: 'PUT', body: JSON.stringify({ key: 'ModelPrice', value: JSON.stringify(mp) }) });
    console.log('  ✓');
}

main().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
