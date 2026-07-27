#!/usr/bin/env node
/**
 * 上两个【4K 计费 SKU】别名(ch67 amutes 上游支持 flash/pro 真 4K 出图):
 *   gemini-3.1-flash-image-preview-4k  →  retail ¥0.35
 *   gemini-3-pro-image-preview-4k      →  retail ¥0.55
 *
 * 做两件事(都 additive,保留现有一切),镜像 configure-pro-2k-sku.mjs:
 *  A) 全局 /api/option/ ：ModelPrice[alias] = ¥ / 1.2(default 组 group_ratio=1.2,
 *     计费读 group_ratio_setting.group_ratio 平铺键;2026-07-19 计价单位迁移后
 *     retail ¥ = ModelPrice × group_ratio,参照现值 pro-2k 0.250017×1.2=¥0.30),
 *     ModelRatio=0,CompletionRatio=0(image 模型惯例 ModelPrice 接管)
 *  B) channel ch#67(type=24 Gemini,group default)：
 *     - models 追加两个 alias(路由用)
 *     - model_mapping 追加 alias → 真名(上游收到真名)
 *     GET 整个 channel → 只改这两字段 → PUT 整个对象回去(gotcha #15:绝不丢字段)
 *
 * proxy 侧另外把 alias 加进 GEMINI_IMAGE_MODELS(→4K)+ GEMINI_ASPECT_RATIOS(同对应档),
 * 翻译到 native 时注入 imageSize=4K。
 *
 * 用法(SSH 隧道开着):
 *   node scripts/configure-gemini-4k-skus.mjs            # dry-run
 *   node scripts/configure-gemini-4k-skus.mjs --apply    # 真改 + verify
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

const GROUP_RATIO = 1.2; // default 组,计费读 group_ratio_setting.group_ratio
const SKUS = [
    {
        alias: 'gemini-3.1-flash-image-preview-4k',
        real: 'gemini-3.1-flash-image-preview',
        retailCny: 0.35,
    },
    {
        alias: 'gemini-3-pro-image-preview-4k',
        real: 'gemini-3-pro-image-preview',
        retailCny: 0.55,
    },
].map((s) => ({ ...s, price: Number((s.retailCny / GROUP_RATIO).toFixed(6)) }));
const CHANNELS = [67];

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

console.log(`\n═══ 配置 Gemini 4K SKU ×2  (apply=${APPLY}) ═══`);
for (const s of SKUS) {
    console.log(
        `  ${s.alias}: ModelPrice=${s.price} → ¥${(s.price * GROUP_RATIO).toFixed(2)}/张 (真名 ${s.real} 不动)`,
    );
}
console.log('');

// ───────── A) 全局 options ─────────
const optR = await api('/api/option/');
const optItems = optR.json.data ?? optR.json ?? [];
const optMap = Array.isArray(optItems) ? Object.fromEntries(optItems.map((i) => [i.key, i.value])) : optItems;
const optPuts = [];
console.log('A) 全局 options:');
for (const key of ['ModelPrice', 'ModelRatio', 'CompletionRatio']) {
    const parsed = JSON.parse(optMap[key] ?? '{}');
    let dirty = false;
    for (const s of SKUS) {
        const val = key === 'ModelPrice' ? s.price : 0;
        const before = parsed[s.alias];
        if (before === val) {
            console.log(`   ${key}[${s.alias}] 已是 ${val},跳过`);
            continue;
        }
        parsed[s.alias] = val;
        dirty = true;
        console.log(`   ${key}[${s.alias}]: ${before ?? '(missing)'} → ${val}`);
    }
    if (dirty) optPuts.push({ key, value: JSON.stringify(parsed) });
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
    let dirty = false;
    for (const s of SKUS) {
        const needModel = !models.includes(s.alias);
        const needMap = mm[s.alias] !== s.real;
        if (!needModel && !needMap) {
            console.log(`   ch#${id} "${c.name}": ${s.alias} 已配置,跳过`);
            continue;
        }
        if (needModel) models.push(s.alias);
        mm[s.alias] = s.real;
        dirty = true;
        console.log(
            `   ch#${id} "${c.name}": models +${needModel ? s.alias : '(已在)'} ; model_mapping[${s.alias}]→${s.real}`,
        );
    }
    if (dirty)
        chPlans.push({ id, name: c.name, next: { ...c, models: models.join(','), model_mapping: JSON.stringify(mm) } });
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
for (const key of ['ModelPrice', 'ModelRatio', 'CompletionRatio']) {
    const parsed = JSON.parse(vMap[key] ?? '{}');
    for (const s of SKUS) {
        const want = key === 'ModelPrice' ? s.price : 0;
        const got = parsed[s.alias];
        const ok = Math.abs((got ?? -1) - want) < 1e-6;
        console.log(`  ${key}[${s.alias}] = ${got}  ${ok ? '✅' : '❌ expected ' + want}`);
        if (!ok) allOk = false;
    }
}
for (const id of CHANNELS) {
    const c = (await api(`/api/channel/${id}`)).json.data;
    const models = String(c.models || '')
        .split(',')
        .map((x) => x.trim());
    const mm = JSON.parse(c.model_mapping || '{}');
    for (const s of SKUS) {
        const ok = models.includes(s.alias) && mm[s.alias] === s.real;
        console.log(
            `  ch#${id}: ${s.alias} in models=${models.includes(s.alias)} mapping=${mm[s.alias] ?? '(none)'}  ${ok ? '✅' : '❌'}`,
        );
        if (!ok) allOk = false;
    }
    console.log(`     (ch#${id} model_mapping 现 ${Object.keys(mm).length} 条;models ${models.length} 个)`);
}
console.log(allOk ? '\n✅ new-api 侧配置完成。' : '\n❌ verify 失败,看上面 ❌');
