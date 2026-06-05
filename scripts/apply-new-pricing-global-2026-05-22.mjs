#!/usr/bin/env node
/**
 * 永久新定价 — 写入 GLOBAL ModelRatio + CompletionRatio(2026-05-22 修复版)
 *
 * 背景:apply-new-pricing-2026-05-21.mjs 通过 channel PUT 写
 * channel.model_ratio + channel.completion_ratio,但 new-api v1.0.0-rc.2
 * **静默丢弃这两个字段**(同样套路写 channel.model_mapping 能成功,所以不是
 * URL/auth 问题 — 是这俩字段在此版本 new-api 里是只读 / UI-only / 别处)。
 * 实测证据见 task #17 + verify-sonnet-pricing.mjs §1 始终为空。
 *
 * 修法:直接改 global ModelRatio + CompletionRatio(已是客户实际计费层)。
 *   - GET /api/option/
 *   - 解析 ModelRatio + CompletionRatio JSON
 *   - 改 20 个 SKU 的 entry(14 ChatGPT + 6 Claude)
 *   - PUT /api/option/ 每条 option
 *
 * SiliconFlow 渠道(118 模型)不受影响 — model 名(deepseek/qwen 等)跟我们改的
 * gpt-x 和 claude-x 系列不重叠。
 *
 * 用法(SSH 隧道开着):
 *   node scripts/apply-new-pricing-global-2026-05-22.mjs            # dry-run + diff 报告
 *   node scripts/apply-new-pricing-global-2026-05-22.mjs --apply    # PUT + verify
 *
 * Verify 修了 NaN bug(undefined 比较返回 false 那个静默放过陷阱)。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const FX = 7;
// 2026-05-26 第二轮降价(海报 v3 + landing 重构):全线再降
//   ChatGPT 0.5 → 0.2(官方 7% → 2.9%,降 60%)— plus 号池
//   Claude  1.5 → 1.3(官方 21% → 19%,降 13%)— oai
//   Gemini  1.5 → 0.5(官方 21% → 7.3%,降 67%)— 接入更便宜号池
const DISCOUNT_CHATGPT_CNY = 0.2;
const DISCOUNT_CLAUDE_CNY = 1.3;
const DISCOUNT_GEMINI_CNY = 0.5;

// retail 表 — 跟 apply-new-pricing-2026-05-21.mjs 完全相同 + 2026-05-22 加入 gemini
const PRICING_BASE = {
    chatgpt: {
        discount_cny: DISCOUNT_CHATGPT_CNY,
        models: {
            'gpt-5.2': { in: 2, out: 8 },
            'gpt-5.2-chat-latest': { in: 2, out: 8 },
            'gpt-5.2-pro': { in: 2, out: 8 },
            'gpt-5.2-pro-2025-12-11': { in: 2, out: 8 },
            'gpt-5.2-2025-12-11': { in: 2, out: 8 },
            'gpt-5.3-codex': { in: 3, out: 12 },
            'gpt-5.3-codex-spark': { in: 3, out: 12 },
            'codex-auto-review': { in: 3, out: 12 },
            'gpt-5.4': { in: 5, out: 20 },
            'gpt-5.4-2026-03-05': { in: 5, out: 20 },
            'gpt-5.4-mini': { in: 0.5, out: 2 },
            'gpt-5.5': { in: 5, out: 25 },
            'gpt-4o-audio-preview': { in: 2.5, out: 10 },
            'gpt-4o-realtime-preview': { in: 5, out: 20 },
        },
    },
    claude: {
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
    gemini: {
        // Token-based 10 个(2026-05-22 第一批):video / audio / music 走 per-call 独立定价(本脚本不动)
        // Image 6 个(2026-05-22 第二批):per-image 计费,纳入本次 — 实际扣费机制需 --apply 后真实图生
        // 调用验证一次,若 quota 扣费跟预期(USD × 1.5/7 × QPU)不符,可能 new-api 对 image 用了
        // 跟 token 不同的 ratio 解释(如每 image 视作 N tokens),需调整 in/out 配比
        discount_cny: DISCOUNT_GEMINI_CNY,
        models: {
            // ↓ 4 个官方公布价 confirmed(text)
            'gemini-2.5-pro': { in: 1.25, out: 10.0 },
            'gemini-2.5-flash': { in: 0.3, out: 2.5 },
            'gemini-3.1-pro-preview': { in: 2.0, out: 12.0 },
            'gemini-3.1-pro-preview-customtools': { in: 2.0, out: 12.0 },
            // ↓ 6 个估计值(text),operator 2026-05-22 可手工改这里再 --apply
            'gemini-3-pro-preview': { in: 2.0, out: 12.0 },
            'gemini-3-flash-preview': { in: 0.3, out: 2.5 },
            'gemini-3.1-flash-lite': { in: 0.1, out: 0.4 },
            'gemini-2.0-flash': { in: 0.1, out: 0.4 },
            'gemma-4-31b-it': { in: 0.1, out: 0.4 },
            'gemini-embedding-2': { in: 0.025, out: 0 },
            // ↓ Image 6 个 — 2026-05-22 第二批加入(per-image $)
            // in/out 设相同 ⇒ cr=1,因为图生没有 "completion vs prompt" 的概念
            // wholesale USD 数字来自 _bootstrap/apply-pr-s-pricing.ts(PR-S 2026-05-10 operator 已知值)
            // 跟 src/data/image-models.ts 同步,公式 retail_¥ = wholesale_USD × 1.5(¥1.5 抵 $1)
            'imagen-4.0-ultra-generate-001': { in: 0.06, out: 0.06 }, // Imagen 4 Ultra wholesale
            'gemini-2.5-flash-image': { in: 0.039, out: 0.039 }, // Nano Banana base wholesale
            'gemini-3-pro-image-preview': { in: 0.187, out: 0.187 }, // Nano Banana Pro wholesale ($0.187/image)
            'gemini-3.1-flash-image-preview': { in: 0.1, out: 0.1 }, // Gemini 3.1 Flash Image wholesale
            'gemini-3.1-flash-image': { in: 0.1, out: 0.1 }, // 同上(variant in channel 5)
            'nano-banana-pro-preview': { in: 0.187, out: 0.187 }, // gemini-3-pro-image-preview 别名,同价
        },
    },
};

function computeRatios(retail, discountCny) {
    const mr = (retail.in * discountCny) / FX;
    const cr = retail.in > 0 ? retail.out / retail.in : 1;
    return { mr: Number(mr.toFixed(6)), cr: Number(cr.toFixed(4)) };
}

// 扁平化:{ 'gpt-5.5': {mr: 0.357, cr: 5}, ... }
function buildExpected() {
    const out = {};
    for (const family of Object.values(PRICING_BASE)) {
        for (const [model, retail] of Object.entries(family.models)) {
            out[model] = computeRatios(retail, family.discount_cny);
        }
    }
    return out;
}

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
        return { status: r.status, json: { _raw: text.slice(0, 500) } };
    }
}

function parseJson(s) {
    if (!s) return {};
    if (typeof s === 'object') return s;
    try {
        return JSON.parse(s);
    } catch {
        return {};
    }
}

async function fetchGlobalRatios() {
    const r = await api('/api/option/');
    if (r.status !== 200) {
        console.error('GET /api/option/ failed:', r.status);
        process.exit(2);
    }
    const items = r.json.data ?? r.json ?? [];
    const optMap = Array.isArray(items) ? Object.fromEntries(items.map((i) => [i.key, i.value])) : items;
    return {
        mr: parseJson(optMap.ModelRatio),
        cr: parseJson(optMap.CompletionRatio),
        raw: { ModelRatio: optMap.ModelRatio, CompletionRatio: optMap.CompletionRatio },
    };
}

async function putOption(key, value) {
    const put = await api('/api/option/', {
        method: 'PUT',
        body: JSON.stringify({ key, value }),
    });
    if (put.status !== 200 || put.json?.success === false) {
        return { ok: false, status: put.status, body: put.json };
    }
    return { ok: true };
}

async function main() {
    console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
    console.log(`║  Apply new pricing → GLOBAL ModelRatio (2026-05-22 修复版)      ║`);
    console.log(`╚════════════════════════════════════════════════════════════════╝`);
    console.log(`base=${BASE}  apply=${APPLY}`);
    console.log(
        `ChatGPT: mr = retail_in × ${DISCOUNT_CHATGPT_CNY}/${FX} = retail_in × ${(DISCOUNT_CHATGPT_CNY / FX).toFixed(4)}`,
    );
    console.log(
        `Claude:  mr = retail_in × ${DISCOUNT_CLAUDE_CNY}/${FX} = retail_in × ${(DISCOUNT_CLAUDE_CNY / FX).toFixed(4)}`,
    );

    const expected = buildExpected();
    console.log(`\n要更新的 SKU:${Object.keys(expected).length} 条(14 ChatGPT + 6 Claude)`);

    const current = await fetchGlobalRatios();
    console.log(`global ModelRatio 当前共 ${Object.keys(current.mr).length} 条`);
    console.log(`global CompletionRatio 当前共 ${Object.keys(current.cr).length} 条`);

    // diff
    const diffs = [];
    for (const [model, { mr, cr }] of Object.entries(expected)) {
        const oldMr = current.mr[model];
        const oldCr = current.cr[model];
        const mrDiff = oldMr === undefined || Math.abs(oldMr - mr) > 0.0001;
        const crDiff = oldCr === undefined || Math.abs(oldCr - cr) > 0.0001;
        if (mrDiff || crDiff) {
            diffs.push({ model, oldMr, newMr: mr, oldCr, newCr: cr });
        }
    }

    console.log(`\n实际要变 ${diffs.length} 条:`);
    if (diffs.length) {
        console.log(`  ┌─────────────────────────────────┬──────────┬──────────┬─────────┬─────────┬────────┐`);
        console.log(`  │ model                           │ old mr   │ new mr   │ old cr  │ new cr  │ note   │`);
        console.log(`  ├─────────────────────────────────┼──────────┼──────────┼─────────┼─────────┼────────┤`);
        for (const d of diffs) {
            const om = d.oldMr === undefined ? '(new)' : String(d.oldMr);
            const nm = String(d.newMr);
            const oc = d.oldCr === undefined ? '(new)' : String(d.oldCr);
            const nc = String(d.newCr);
            const pct =
                typeof d.oldMr === 'number' && d.oldMr > 0 ? `${Math.round((d.newMr / d.oldMr - 1) * 100)}%` : 'new';
            console.log(
                `  │ ${d.model.padEnd(31)} │ ${om.padEnd(8)} │ ${nm.padEnd(8)} │ ${oc.padEnd(7)} │ ${nc.padEnd(7)} │ ${pct.padEnd(6)} │`,
            );
        }
        console.log(`  └─────────────────────────────────┴──────────┴──────────┴─────────┴─────────┴────────┘`);
    }

    if (!APPLY) {
        console.log(`\n[dry-run] 没改任何东西。--apply 才真改。`);
        return;
    }

    if (diffs.length === 0) {
        console.log(`\n✅ 已经全部 match,无需 PUT。`);
        return;
    }

    // merge:其它 258 条不动,只改我们的 20 条
    const newMr = { ...current.mr };
    const newCr = { ...current.cr };
    for (const [model, { mr, cr }] of Object.entries(expected)) {
        newMr[model] = mr;
        newCr[model] = cr;
    }

    // PUT ModelRatio
    console.log(`\nPUT /api/option/ key=ModelRatio ...`);
    const r1 = await putOption('ModelRatio', JSON.stringify(newMr));
    if (!r1.ok) {
        console.error(`  ❌ ModelRatio PUT failed:`, r1.status, r1.body);
        process.exit(3);
    }
    console.log(`  ✅ ModelRatio updated (${Object.keys(newMr).length} entries total)`);

    // PUT CompletionRatio
    console.log(`PUT /api/option/ key=CompletionRatio ...`);
    const r2 = await putOption('CompletionRatio', JSON.stringify(newCr));
    if (!r2.ok) {
        console.error(`  ❌ CompletionRatio PUT failed:`, r2.status, r2.body);
        process.exit(4);
    }
    console.log(`  ✅ CompletionRatio updated (${Object.keys(newCr).length} entries total)`);

    // verify(fix NaN bug:显式判断 undefined / 严格数字比对)
    console.log(`\n等 6s 缓存刷新...`);
    await new Promise((r) => setTimeout(r, 6000));
    const after = await fetchGlobalRatios();
    let mismatches = 0;
    for (const [model, { mr, cr }] of Object.entries(expected)) {
        const am = after.mr[model];
        const ac = after.cr[model];
        if (typeof am !== 'number' || Math.abs(am - mr) > 0.0001) {
            console.log(`  ⚠️  ${model}: mr got=${am} want=${mr}`);
            mismatches++;
        }
        if (typeof ac !== 'number' || Math.abs(ac - cr) > 0.0001) {
            console.log(`  ⚠️  ${model}: cr got=${ac} want=${cr}`);
            mismatches++;
        }
    }
    if (mismatches === 0) {
        console.log(`\n✅ verified: 20/20 SKU entries 全部精确匹配新价(NaN bug 已修)`);
        console.log(`✅ 客户下次发请求即按新价计费(global ModelRatio 立即生效,无 channel cache)`);
        console.log(`\n下一步:跑 node scripts/verify-sonnet-pricing.mjs 看新发生的请求 implied_mr 应近 0.643`);
    } else {
        console.error(
            `\n❌ ${mismatches} 处 mismatch,PUT 没真写进去。可能 new-api 的 /api/option/ PUT 也有限制,要进 admin UI 手工改。`,
        );
        process.exit(5);
    }
}

main().catch((e) => {
    console.error('FATAL', e);
    process.exit(99);
});
