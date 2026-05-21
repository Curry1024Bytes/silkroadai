#!/usr/bin/env tsx
/**
 * ⚠️ OBSOLETE — 2026-05-21 起永久作废
 *
 * 本脚本是 W7 promo 6/9 退场 runbook(原计划:6/9 自动把价格 revert 回 retail
 * × 1.0 也就是 PROMO_DISCOUNT 拆掉)。永久新定价替换 W7 promo 后,**不存在
 * 退场动作** — 不要在 6/9 触发本脚本,会让客户价格暴涨。
 * 历史代码保留作 W7 retro 参考。
 *
 * ───────────── 以下是原 W7 D2 注释 ─────────────
 *
 * W7 promo exit — restore sub2api retail pricing on 2026-06-09.
 *
 * Multiplies the current `model_ratio` of the two sub2api channels by 2.
 * `completion_ratio` stays unchanged (output/input ratio doesn't change
 * with the promo discount). The siliconflow channel is NOT touched —
 * SF is on cost-plus pricing, never had a promo.
 *
 * Pre-req: `_bootstrap/apply-w7-pricing.ts --apply` was run during W7 D2.
 * If the channel ratios are still NULL (apply was never run), this script
 * is a no-op and prints a warning.
 *
 * Usage
 * -----
 *   tsx _bootstrap/exit-w7-promo.ts             # dry-run (default)
 *   tsx _bootstrap/exit-w7-promo.ts --apply     # actually PUT
 *
 * See docs/W7-PROMO-EXIT-RUNBOOK.md for the operator playbook.
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

/** Same channel IDs as apply-w7-pricing.ts. siliconflow (id=1) intentionally
 *  excluded — only sub2api channels are on promo. */
const PROMO_CHANNEL_IDS = [2, 3] as const;

interface Channel {
    id: number;
    name: string;
    model_ratio: string | null;
    completion_ratio: string | null;
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

async function main(): Promise<void> {
    console.log(`W7 promo exit ${APPLY ? '(LIVE — will PUT)' : '(DRY-RUN)'}`);
    console.log(`new-api URL: ${NEWAPI_BASE_URL}`);
    console.log();

    for (const id of PROMO_CHANNEL_IDS) {
        const ch = await api<Channel>(`/api/channel/${id}`);
        console.log(`──── ${ch.name} (id=${ch.id}) ────`);

        const oldMr = ch.model_ratio ? JSON.parse(ch.model_ratio) as Record<string, number> : null;
        if (!oldMr || Object.keys(oldMr).length === 0) {
            console.log(`  SKIP — channel has no model_ratio set (apply-w7-pricing.ts --apply was never run, or already exited).`);
            continue;
        }

        const newMr: Record<string, number> = {};
        for (const [model, ratio] of Object.entries(oldMr)) {
            newMr[model] = ratio * 2;
        }

        for (const m of Object.keys(newMr).sort()) {
            console.log(`  ${m.padEnd(35)} ${oldMr[m]?.toFixed(4)} → ${newMr[m].toFixed(4)}  (×2)`);
        }

        if (APPLY) {
            const merged = { ...ch, model_ratio: JSON.stringify(newMr) };
            console.log(`  → PUT /api/channel/`);
            await api(`/api/channel/`, { method: 'PUT', body: JSON.stringify(merged) });
            console.log(`  ✓ updated`);
        }
        console.log();
    }

    if (!APPLY) {
        console.log(`Dry-run complete. Pass --apply to PUT.`);
        console.log(`See docs/W7-PROMO-EXIT-RUNBOOK.md for the full playbook.`);
    } else {
        console.log(`Promo exit complete. Verify next:`);
        console.log(`  - curl /api/pricing → confirm new mr values`);
        console.log(`  - landing-page banner removed in portal /pricing rebuild`);
    }
}

main().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
