#!/usr/bin/env node
/**
 * 给 gemini-3-pro-image-preview 开一个【2K 折扣计费 SKU】别名:
 *   gemini-3-pro-image-preview-2k  →  retail ¥0.30(4K 原名仍 ¥0.50)
 *
 * 做两件事(都 additive,保留现有一切):
 *  A) 全局 /api/option/ ：ModelPrice[alias]=0.04286(¥0.30/7),ModelRatio=0,CompletionRatio=0
 *     (镜像 image 模型惯例 ModelPrice 接管,见 apply-gemini-channel-17-pricing.mjs)
 *  B) channel ch#24 + ch#17(都 type=24 Gemini,serve 真名)：
 *     - models 追加 alias(路由用)
 *     - model_mapping 追加 alias → gemini-3-pro-image-preview(上游收到真名)
 *     GET 整个 channel → 只改这两字段 → PUT 整个对象回去(gotcha #15:绝不丢字段)
 *
 * proxy 侧另外把 alias 加进 GEMINI_IMAGE_MODELS(→2K)+ GEMINI_ASPECT_RATIOS(同 pro 档),
 * 翻译到 native 时注入 imageSize=2K。
 *
 * 用法(SSH 隧道开着):
 *   node scripts/configure-pro-2k-sku.mjs            # dry-run
 *   node scripts/configure-pro-2k-sku.mjs --apply    # 真改 + verify
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}
const BASE = process.env.NEWAPI_BASE_URL,
    TOKEN = process.env.NEWAPI_ADMIN_TOKEN,
    UID = process.env.NEWAPI_ADMIN_USER_ID;
const APPLY = process.argv.includes('--apply');

const REAL = 'gemini-3-pro-image-preview';
const ALIAS = 'gemini-3-pro-image-preview-2k';
const PRICE = 0.04286; // ¥0.30 / 7  → quota 42860 = ¥0.30
const CHANNELS = [24, 17];

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
    const t = await r.text();
    try {
        return { status: r.status, json: JSON.parse(t), text: t };
    } catch {
        return { status: r.status, json: { _raw: t.slice(0, 300) }, text: t };
    }
}

console.log(`\n═══ 配置 2K 折扣 SKU  ${ALIAS}  (apply=${APPLY}) ═══`);
console.log(`  ModelPrice=${PRICE} → ¥${(PRICE * 7).toFixed(2)}/张 (4K 原名 ${REAL} 不动,仍 ¥0.50)\n`);

// ───────── A) 全局 options ─────────
const optR = await api('/api/option/');
const optItems = optR.json.data ?? optR.json ?? [];
const optMap = Array.isArray(optItems) ? Object.fromEntries(optItems.map((i) => [i.key, i.value])) : optItems;
const wantOpt = { ModelPrice: PRICE, ModelRatio: 0, CompletionRatio: 0 };
const optPuts = [];
console.log('A) 全局 options:');
for (const [key, val] of Object.entries(wantOpt)) {
    const parsed = JSON.parse(optMap[key] ?? '{}');
    const before = parsed[ALIAS];
    if (before === val) {
        console.log(`   ${key}[${ALIAS}] 已是 ${val},跳过`);
        continue;
    }
    parsed[ALIAS] = val;
    optPuts.push({ key, value: JSON.stringify(parsed) });
    console.log(`   ${key}[${ALIAS}]: ${before ?? '(missing)'} → ${val}`);
}

// ───────── B) channels ─────────
console.log('\nB) channels(models 追加 alias + model_mapping alias→真名):');
const chPlans = [];
for (const id of CHANNELS) {
    const cr = await api(`/api/channel/${id}`);
    const c = cr.json.data;
    if (!c) {
        console.error(`   ❌ ch#${id} GET 失败: ${cr.text.slice(0, 200)}`);
        process.exit(1);
    }
    const models = String(c.models || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    let mm = {};
    try {
        mm = JSON.parse(c.model_mapping || '{}');
    } catch {
        /* treat as empty */
    }
    const needModel = !models.includes(ALIAS);
    const needMap = mm[ALIAS] !== REAL;
    if (!needModel && !needMap) {
        console.log(`   ch#${id} "${c.name}": 已配置,跳过`);
        continue;
    }
    if (needModel) models.push(ALIAS);
    mm[ALIAS] = REAL;
    const next = { ...c, models: models.join(','), model_mapping: JSON.stringify(mm) };
    chPlans.push({ id, name: c.name, next });
    console.log(
        `   ch#${id} "${c.name}": models +${needModel ? ALIAS : '(已在)'} ; model_mapping[${ALIAS}]→${REAL}  (现有 mapping ${Object.keys(mm).length - 1} 条保留)`,
    );
}

if (!APPLY) {
    console.log('\n[dry-run] 未改动。--apply 才真改。\n');
    process.exit(0);
}

console.log('\n═══ PUT 应用 ═══');
for (const { key, value } of optPuts) {
    const r = await api('/api/option/', { method: 'PUT', body: JSON.stringify({ key, value }) });
    const ok = r.status === 200 && r.json?.success !== false;
    console.log(
        `  option ${key.padEnd(16)}: ${r.status} ${ok ? '✅' : '❌ ' + (r.json?.message || r.text.slice(0, 200))}`,
    );
    if (!ok) process.exit(1);
}
for (const { id, name, next } of chPlans) {
    const r = await api('/api/channel/', { method: 'PUT', body: JSON.stringify(next) });
    const ok = r.status === 200 && r.json?.success !== false;
    console.log(
        `  channel ch#${id} "${name}": ${r.status} ${ok ? '✅' : '❌ ' + (r.json?.message || r.text.slice(0, 200))}`,
    );
    if (!ok) process.exit(1);
}

console.log('\n等 3s reload…');
await new Promise((r) => setTimeout(r, 3000));

console.log('\n═══ Verify ═══');
let allOk = true;
const v = await api('/api/option/');
const vItems = v.json.data ?? v.json ?? [];
const vMap = Array.isArray(vItems) ? Object.fromEntries(vItems.map((i) => [i.key, i.value])) : vItems;
for (const [key, val] of Object.entries(wantOpt)) {
    const got = JSON.parse(vMap[key] ?? '{}')[ALIAS];
    const ok = Math.abs((got ?? -1) - val) < 1e-6;
    console.log(`  ${key}[${ALIAS}] = ${got}  ${ok ? '✅' : '❌ expected ' + val}`);
    if (!ok) allOk = false;
}
for (const id of CHANNELS) {
    const c = (await api(`/api/channel/${id}`)).json.data;
    const models = String(c.models || '').split(',');
    const mm = JSON.parse(c.model_mapping || '{}');
    const ok = models.includes(ALIAS) && mm[ALIAS] === REAL;
    console.log(
        `  ch#${id}: alias in models=${models.includes(ALIAS)} mapping=${mm[ALIAS] ?? '(none)'}  ${ok ? '✅' : '❌'}`,
    );
    console.log(`     (该渠道 model_mapping 现 ${Object.keys(mm).length} 条;models ${models.length} 个)`);
    if (!ok) allOk = false;
}
console.log(allOk ? '\n✅ new-api 侧配置完成。' : '\n❌ verify 失败,看上面 ❌');
