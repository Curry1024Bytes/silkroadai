#!/usr/bin/env node
/**
 * 配置 new-api 的「seedance 国内企业级端口」(火山方舟 doubao-seedance / token.xinhankr.com,
 * 经 portal 适配器 /seedance-cn-adapter)。镜像 setup-seedance-overseas.mjs 的四步:
 *   1. GroupRatio                      : seedance-cn-enterprise = 1.0(卖价烤进 ModelPrice,组只隔离/显示)
 *   2. group_ratio_setting.group_ratio : seedance-cn-enterprise = 1.0 —— 本台【强制】此结构化 key,
 *      缺了客户请求会 403「分组 X 已被弃用」(2026-07-15 部署实测)。merge 只加本 group、保留其余。
 *   3. UserUsableGroups                : seedance-cn-enterprise = "seedance 国内企业级端口"(前端显示名)
 *   4. ModelPrice                      : 8 档(4 分辨率 × {无参考, -ref}),$/秒。由实测 token/秒 换算(见下)
 *   5. Channel                         : type=1 → portal 适配器,group=seedance-cn-enterprise,models=8 档
 *
 * 计费 = new-api 按 duration × ModelPrice × GroupRatio(=1)算,与适配器无关(与现有 seedance 一致)。
 *
 * === 定价推导(按秒承载「按 token」价目表)===
 * 上游按 token 计价、我们对客按秒。因视频 token ≈ 分辨率×时长(近确定),按秒可无损承载,
 * 且 8 个模型名同时承载「分辨率档 × 有/无参考」两维。ModelPrice(¥/秒) = 零售(¥/1M) × token/秒。
 *   零售 = 上游官方挂牌价 × 0.85(8.5 折);上游给我们是 0.75(7.5 折)→ 内含 ~13.3% 毛利,
 *   足以吸收 token/秒 抖动,故 SAFETY=1.0(对客即挂牌表价)。观察到毛利被压再调高。
 *   token/秒 实测(5s 文生,2026-07-14):720p=10128 / 1080p=21780 / 2k=49005 / 4k=49005
 *   (4k 输出 token 数与 2k 完全相同,上游价目表 2k/4k 亦同价 → 4k=2k)。
 *
 * 用法: SEEDANCE_XHK_KEY=sk-... node scripts/setup-seedance-cn-enterprise.mjs [--apply]
 *   需 :3000 隧道(ssh -fN -L 3000:localhost:3000 vps)。
 *
 * === deploy 另需(本脚本不做)===
 *   - portal .env:SEEDANCE_XHK_KEY(=channel key)、可选 SEEDANCE_CN_ADAPTER_BASE / SEEDANCE_XHK_BASE_URL
 *   - portal channel_groups 行(/keys 档次选择器读它):admin 控制台「渠道分组」新建
 *       key=seedance-cn-enterprise / newapi_group=seedance-cn-enterprise / display_name=「seedance 国内企业级端口」
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, '..', '.env'), 'utf8');
for (const line of envText.split('\n')) {
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
const KEY = process.env.SEEDANCE_XHK_KEY || '';
const GROUP = 'seedance-cn-enterprise';
const LABEL = 'seedance 国内企业级端口';
const ADAPTER_BASE = process.env.SEEDANCE_CN_ADAPTER_BASE || 'http://172.21.0.1:3002/seedance-cn-adapter';
const FX = 7; // prod:1 USD = ¥7(QPU=1e6)

// 定价输入(改这里即可)。token/秒 实测;retail = 官方挂牌 × 0.85(¥/1M token)。
const SAFETY = 1.0;
// token/秒 实测(5s 文生,2026-07-14):4k 与 2k 输出 token 数完全相同(245025),
// 上游价目表也把 2k/4k 同价 —— 故 4k = 2k(49005),两者 ¥/秒 完全一致。
const TOK_PER_SEC = { '720p': 10128, '1080p': 21780, '2k': 49005, '4k': 49005 };
const RETAIL_CNY_PER_M = {
    noref: { '720p': 39.1, '1080p': 39.1, '2k': 43.35, '4k': 43.35 },
    ref: { '720p': 23.8, '1080p': 23.8, '2k': 26.35, '4k': 26.35 },
};
// ModelPrice($/秒) = retail(¥/1M) × token/秒 / 1e6 × SAFETY / FX
const priceUsd = (mode, res) => +((RETAIL_CNY_PER_M[mode][res] * TOK_PER_SEC[res] * SAFETY) / 1e6 / FX).toFixed(6);
const PRICES = {};
for (const res of ['720p', '1080p', '2k', '4k']) {
    PRICES[`artsdance2.0-pro-${res}`] = priceUsd('noref', res);
    PRICES[`artsdance2.0-pro-${res}-ref`] = priceUsd('ref', res);
}
const MODELS = Object.keys(PRICES).join(',');

const api = async (method, p, body) => {
    const r = await fetch(`${BASE}${p}`, {
        method,
        headers: { Authorization: TOKEN, 'New-Api-User': UID, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await r.text();
    try {
        return { status: r.status, j: JSON.parse(t) };
    } catch {
        return { status: r.status, j: { _raw: t.slice(0, 200) } };
    }
};
async function getOption(key) {
    const { j } = await api('GET', '/api/option/');
    let d = j?.data ?? j;
    if (Array.isArray(d)) {
        const f = d.find((i) => i && i.key === key);
        return f && f.value != null ? String(f.value) : null;
    }
    if (d && typeof d === 'object') return d[key] == null ? null : String(d[key]);
    return null;
}
const parse = (raw) => {
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
};

console.log(`=== setup-seedance-cn-enterprise [${APPLY ? 'APPLY' : 'DRY-RUN'}] ===`);
console.log(`adapter base_url: ${ADAPTER_BASE}`);
console.log(`group: ${GROUP} ("${LABEL}")\nmodels(8): ${MODELS}\n`);
console.log('ModelPrice($/秒,含 SAFETY=' + SAFETY + '):');
for (const [m, p] of Object.entries(PRICES)) console.log(`  ${m.padEnd(30)} $${p}/秒  = ¥${(p * FX).toFixed(4)}/秒`);
console.log('');

// 1+2+3: group options。本台【强制】group_ratio_setting.group_ratio —— 缺了该结构化 key
// 客户请求会 403「分组 X 已被弃用」(2026-07-15 部署实测)。三张 map 都 merge(只加本 group、
// 保留其余,故不会波及 official-gpt 等);group_ratio_setting.group_ratio 本台已是 populated map,
// merge 安全。⚠️ 若某台该项为 null,merge 会把它变成单 key map(可能启用 enforcement),届时先确认。
for (const [key, val] of [
    ['GroupRatio', 1.0],
    ['group_ratio_setting.group_ratio', 1.0],
    ['UserUsableGroups', LABEL],
]) {
    const obj = parse(await getOption(key));
    const next = { ...obj, [GROUP]: val };
    console.log(`[${key}] ${GROUP} => ${JSON.stringify(val)}  (before: ${JSON.stringify(obj[GROUP] ?? null)})`);
    if (APPLY) {
        const r = await api('PUT', '/api/option/', { key, value: JSON.stringify(next) });
        console.log('  PUT ->', r.status, r.j?.success === true ? 'ok' : JSON.stringify(r.j).slice(0, 140));
    }
}

// 3: ModelPrice merge
const mp = parse(await getOption('ModelPrice'));
const mpNext = { ...mp, ...PRICES };
console.log('\n[ModelPrice] merge 8 entries');
if (APPLY) {
    const r = await api('PUT', '/api/option/', { key: 'ModelPrice', value: JSON.stringify(mpNext) });
    console.log('  PUT ->', r.status, r.j?.success === true ? 'ok' : JSON.stringify(r.j).slice(0, 140));
}

// 4: channel — create if absent (idempotent by name)
const CH_NAME = 'seedance国内企业级 (火山方舟 token.xinhankr)';
const list = (await api('GET', '/api/channel/?p=1&page_size=200')).j?.data;
const items = Array.isArray(list) ? list : (list?.items ?? []);
const existing = items.find((c) => c?.name === CH_NAME);
console.log(`\n[channel] "${CH_NAME}"  ${existing ? `EXISTS (id=${existing.id})` : 'will CREATE'}`);
if (!existing) {
    if (!KEY) {
        console.log('  ⚠️ SEEDANCE_XHK_KEY 未设 — 跳过创建(设了再 --apply)');
    } else {
        const payload = {
            type: 1,
            name: CH_NAME,
            key: KEY,
            base_url: ADAPTER_BASE,
            models: MODELS,
            group: GROUP,
            groups: [GROUP],
            model_mapping: '',
            priority: 0,
            weight: 0,
            status: 1,
        };
        console.log(`  create: type=1 base_url=${ADAPTER_BASE} group=${GROUP} models=8 key=${KEY.slice(0, 12)}…`);
        if (APPLY) {
            const r = await api('POST', '/api/channel/', { mode: 'single', channel: payload });
            console.log('  POST ->', r.status, r.j?.success === true ? 'ok' : JSON.stringify(r.j).slice(0, 200));
        }
    }
}

if (APPLY) {
    console.log('\n=== verify ===');
    const gr = parse(await getOption('GroupRatio')),
        uu = parse(await getOption('UserUsableGroups')),
        mpv = parse(await getOption('ModelPrice'));
    const l2 = (await api('GET', '/api/channel/?p=1&page_size=200')).j?.data;
    const it2 = Array.isArray(l2) ? l2 : (l2?.items ?? []);
    const ch = it2.find((c) => c?.name === CH_NAME);
    console.log('  GroupRatio:', gr[GROUP], ' UserUsableGroups:', JSON.stringify(uu[GROUP]));
    console.log('  ModelPrice:', JSON.stringify(Object.fromEntries(Object.keys(PRICES).map((m) => [m, mpv[m]]))));
    console.log('  channel:', ch ? `id=${ch.id} group=${ch.group} status=${ch.status}` : 'NOT FOUND');
    const ok =
        gr[GROUP] === 1.0 &&
        uu[GROUP] === LABEL &&
        Object.keys(PRICES).every((m) => mpv[m] === PRICES[m]) &&
        ch &&
        String(ch.group) === GROUP;
    console.log(ok ? '\n✅ seedance-cn-enterprise configured' : '\n❌ mismatch — check above');
}
