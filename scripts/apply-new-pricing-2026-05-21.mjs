#!/usr/bin/env node
/**
 * 永久新定价应用脚本(2026-05-21 operator 决策):
 *
 *   ChatGPT 系(channel id=3 sub2api OpenAI):¥0.5 / 官方 $1 token 额度
 *   Claude  系(channel id=2 sub2api Anthropic):¥1.5 / 官方 $1 token 额度
 *
 * 换算公式(USD_TO_CNY_RATE = 7):
 *   new_model_ratio       = retail_in_USD × discount_CNY / 7
 *   new_completion_ratio  = retail_out_USD / retail_in_USD(不变,沿用官方)
 *
 * 替换 _bootstrap/apply-w7-pricing.ts 的 PROMO_DISCOUNT = 0.5(W7 D2 那个 50% 促销永久结束)。
 *
 * 实施细节:
 *   - per-channel `model_ratio` + `completion_ratio` 写入,不动 global ModelRatio(278 entries)
 *   - 覆盖 channel id=3 + id=2 全部当前已知 SKU(含目前调不通的 — 为未来恢复留好价)
 *   - 不动 channel.models / .model_mapping / .other / .setting(per gotcha #15,PUT 时回传整个对象)
 *   - gpt-image-1 / 1.5 / 2 per-image 定价独立机制,本脚本跳过
 *
 * 用法(SSH 隧道开着):
 *   node scripts/apply-new-pricing-2026-05-21.mjs           # dry-run + diff 报告
 *   node scripts/apply-new-pricing-2026-05-21.mjs --apply   # PUT + verify
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* eslint-disable @typescript-eslint/no-explicit-any */

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
const envText = readFileSync(envPath, 'utf8');
for (const line of envText.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const BASE = process.env.NEWAPI_BASE_URL;
const TOKEN = process.env.NEWAPI_ADMIN_TOKEN;
const UID = process.env.NEWAPI_ADMIN_USER_ID;
const APPLY = process.argv.includes('--apply');

if (!BASE || !TOKEN || !UID) {
    console.error('Missing NEWAPI_BASE_URL / NEWAPI_ADMIN_TOKEN / NEWAPI_ADMIN_USER_ID');
    process.exit(1);
}

const FX = 7; // USD_TO_CNY_RATE
const DISCOUNT_CHATGPT_CNY = 0.5;
const DISCOUNT_CLAUDE_CNY = 1.5;

/**
 * 官方零售价基线(USD per 1M tokens),按 Anthropic / OpenAI 公开 pricing。
 * dated / pro 变体默认沿用 base SKU 价(per operator 2026-05-21 Q3)。
 */
const PRICING = {
    3: {
        // sub2api OpenAI(ChatGPT 系)
        label: 'sub2api OpenAI (ChatGPT 系)',
        discount_cny: DISCOUNT_CHATGPT_CNY,
        models: {
            // gpt-5.2 base + variants(dated / pro / chat-latest 同价)
            'gpt-5.2': { in: 2, out: 8 },
            'gpt-5.2-chat-latest': { in: 2, out: 8 },
            'gpt-5.2-pro': { in: 2, out: 8 },
            'gpt-5.2-pro-2025-12-11': { in: 2, out: 8 },
            'gpt-5.2-2025-12-11': { in: 2, out: 8 },
            // gpt-5.3-codex 全家
            'gpt-5.3-codex': { in: 3, out: 12 },
            'gpt-5.3-codex-spark': { in: 3, out: 12 },
            'codex-auto-review': { in: 3, out: 12 },
            // gpt-5.4 base + dated
            'gpt-5.4': { in: 5, out: 20 },
            'gpt-5.4-2026-03-05': { in: 5, out: 20 },
            // gpt-5.4-mini
            'gpt-5.4-mini': { in: 0.5, out: 2 },
            // gpt-5.5
            'gpt-5.5': { in: 5, out: 25 },
            // gpt-4o audio / realtime
            'gpt-4o-audio-preview': { in: 2.5, out: 10 },
            'gpt-4o-realtime-preview': { in: 5, out: 20 },
            // gpt-image-1 / 1.5 / 2: per-image 定价,不走 mr/cr,本脚本跳过
            // 由 admin UI / portal /image 页面独立处理
        },
    },
    2: {
        // sub2api Anthropic(Claude 系)
        label: 'sub2api Anthropic (Claude 系)',
        discount_cny: DISCOUNT_CLAUDE_CNY,
        models: {
            'claude-opus-4-7': { in: 15, out: 75 },
            'claude-opus-4-6': { in: 15, out: 75 },
            'claude-opus-4-5': { in: 15, out: 75 },
            'claude-sonnet-4-6': { in: 3, out: 15 },
            'claude-sonnet-4-5': { in: 3, out: 15 },
            'claude-haiku-4-5': { in: 1, out: 5 },
        },
    },
};

async function api(path, init = {}) {
    const r = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
            Authorization: TOKEN,
            'New-Api-User': UID,
            'Content-Type': 'application/json',
            ...(init.headers || {}),
        },
    });
    const text = await r.text();
    try {
        return { status: r.status, json: JSON.parse(text) };
    } catch {
        return { status: r.status, json: { _raw: text.slice(0, 400) } };
    }
}

function fmtRatio(n) {
    if (n === 0) return '0';
    if (Math.abs(n) >= 1) return n.toFixed(3).replace(/\.?0+$/, '');
    return n.toFixed(4).replace(/\.?0+$/, '');
}

function computeRatios(retail, discountCny) {
    const mr = (retail.in * discountCny) / FX;
    const cr = retail.in > 0 ? retail.out / retail.in : 1;
    return { mr, cr };
}

function parseExistingDict(s) {
    if (!s) return {};
    if (typeof s === 'object') return s;
    try {
        return JSON.parse(s);
    } catch {
        return {};
    }
}

async function processChannel(channelId, channelCfg) {
    console.log(`\n──── Channel id=${channelId} · ${channelCfg.label} ────`);
    const get = await api(`/api/channel/${channelId}`);
    if (get.status !== 200) {
        console.error(`  GET failed:`, get.status, get.json);
        return { ok: false };
    }
    const ch = get.json.data ?? get.json;

    const existingMr = parseExistingDict(ch.model_ratio);
    const existingCr = parseExistingDict(ch.completion_ratio);

    // 新 mr / cr dict 在原基础上 merge —— 我们的 SKU 用新值,其它(可能 admin
    // 手工加过的)保持不动
    const newMr = { ...existingMr };
    const newCr = { ...existingCr };
    const diffs = [];

    for (const [model, retail] of Object.entries(channelCfg.models)) {
        const { mr, cr } = computeRatios(retail, channelCfg.discount_cny);
        const oldMr = existingMr[model];
        const oldCr = existingCr[model];
        const mrChanged = oldMr === undefined || Math.abs((oldMr ?? 0) - mr) > 0.0001;
        const crChanged = oldCr === undefined || Math.abs((oldCr ?? 0) - cr) > 0.0001;
        if (mrChanged || crChanged) {
            diffs.push({ model, oldMr, newMr: mr, oldCr, newCr: cr, retail });
        }
        newMr[model] = Number(mr.toFixed(6));
        newCr[model] = Number(cr.toFixed(4));
    }

    // 报告
    console.log(`  retail discount: ¥${channelCfg.discount_cny} 抵 $1 官方(fx=${FX})`);
    console.log(`  existing entries: mr=${Object.keys(existingMr).length}  cr=${Object.keys(existingCr).length}`);
    console.log(`  models to update: ${Object.keys(channelCfg.models).length}`);
    console.log(`  actual diff:      ${diffs.length}`);
    if (diffs.length) {
        console.log(`  ┌─────────────────────────────────┬──────────┬──────────┬───────┬──────┬───────────┐`);
        console.log(`  │ model                           │ retail in│ old mr   │ new mr│ cr   │ note      │`);
        console.log(`  ├─────────────────────────────────┼──────────┼──────────┼───────┼──────┼───────────┤`);
        for (const d of diffs) {
            const ret = `$${d.retail.in}/$${d.retail.out}`.padEnd(8);
            const om = (d.oldMr === undefined ? '(new)' : fmtRatio(d.oldMr)).padEnd(8);
            const nm = fmtRatio(d.newMr).padEnd(5);
            const nc = fmtRatio(d.newCr).padEnd(4);
            const note =
                d.oldMr === undefined
                    ? 'new'
                    : d.newMr < d.oldMr
                      ? `−${Math.round((1 - d.newMr / d.oldMr) * 100)}%`
                      : `+${Math.round((d.newMr / d.oldMr - 1) * 100)}%`;
            console.log(`  │ ${d.model.padEnd(31)} │ ${ret} │ ${om} │ ${nm} │ ${nc} │ ${note.padEnd(9)} │`);
        }
        console.log(`  └─────────────────────────────────┴──────────┴──────────┴───────┴──────┴───────────┘`);
    }

    if (!APPLY) {
        return { ok: true, diffs: diffs.length };
    }

    // 真改 — 完整 PUT channel 对象,只换 model_ratio / completion_ratio
    ch.model_ratio = JSON.stringify(newMr);
    ch.completion_ratio = JSON.stringify(newCr);
    const put = await api('/api/channel/', { method: 'PUT', body: JSON.stringify(ch) });
    if (put.status !== 200 || put.json?.success === false) {
        console.error(`  ❌ PUT failed:`, put.status, put.json);
        return { ok: false };
    }
    console.log(`  ✅ PUT 200`);

    // verify
    console.log(`  waiting 6s for cache refresh...`);
    await new Promise((r) => setTimeout(r, 6000));
    const verify = await api(`/api/channel/${channelId}`);
    const vc = verify.json.data ?? verify.json;
    const vMr = parseExistingDict(vc.model_ratio);
    const vCr = parseExistingDict(vc.completion_ratio);
    let mismatches = 0;
    for (const [model, retail] of Object.entries(channelCfg.models)) {
        const { mr, cr } = computeRatios(retail, channelCfg.discount_cny);
        if (Math.abs(vMr[model] - Number(mr.toFixed(6))) > 0.0001) {
            console.log(`  ⚠️  mismatch ${model}: got mr=${vMr[model]} want ${fmtRatio(mr)}`);
            mismatches++;
        }
        if (Math.abs(vCr[model] - Number(cr.toFixed(4))) > 0.0001) {
            console.log(`  ⚠️  mismatch ${model}: got cr=${vCr[model]} want ${fmtRatio(cr)}`);
            mismatches++;
        }
    }
    if (mismatches === 0) {
        console.log(
            `  ✅ verified: ${Object.keys(channelCfg.models).length}/${Object.keys(channelCfg.models).length} entries match`,
        );
    }
    return { ok: true, mismatches };
}

async function main() {
    console.log(`\n=== Apply new pricing 2026-05-21 ===`);
    console.log(`base ${BASE} · apply=${APPLY}`);
    console.log(
        `ChatGPT 系: ¥${DISCOUNT_CHATGPT_CNY} 抵 $1 官方 → new_mr = retail_in × ${DISCOUNT_CHATGPT_CNY}/${FX} = retail_in × ${(DISCOUNT_CHATGPT_CNY / FX).toFixed(4)}`,
    );
    console.log(
        `Claude 系: ¥${DISCOUNT_CLAUDE_CNY} 抵 $1 官方 → new_mr = retail_in × ${DISCOUNT_CLAUDE_CNY}/${FX} = retail_in × ${(DISCOUNT_CLAUDE_CNY / FX).toFixed(4)}`,
    );
    console.log(`completion_ratio = retail_out / retail_in(沿用官方比例)`);

    for (const [chId, cfg] of Object.entries(PRICING)) {
        const r = await processChannel(parseInt(chId, 10), cfg);
        if (!r.ok) {
            console.error(`\n❌ channel ${chId} failed, bailing out`);
            process.exit(2);
        }
    }

    console.log(`\n=== Done. ${APPLY ? 'Applied + verified.' : 'Dry-run only, re-run with --apply.'} ===\n`);
    if (APPLY) {
        console.log(`后续动作(需另起 PR):`);
        console.log(`  1. 改 portal landing PRICING_ROWS(src/app/page.tsx)同步显示价`);
        console.log(`  2. 如 /pricing 页存在,同步`);
        console.log(
            `  3. _bootstrap/apply-w7-pricing.ts 标 OBSOLETE 注释 + _bootstrap/exit-w7-promo.ts 标 OBSOLETE(永久价后不再 promo 退场)`,
        );
        console.log(`  4. CLAUDE.md 进度段加 W8 D1 新定价上线`);
    }
}

main().catch((e) => {
    console.error('FATAL', e);
    process.exit(99);
});
