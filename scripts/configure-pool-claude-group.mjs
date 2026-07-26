#!/usr/bin/env node
/**
 * pool-claude 组迁移(镜像 2026-07-20 pool-gpt 拆组;背景:07-26 operator 想给 Claude
 * 号池涨到 2.4 误把 GroupRatio.default 整组拨到 2.4,default 全系翻倍多收):
 *
 *   --create-group :
 *     GroupRatio[pool-claude]=2.4 + group_ratio_setting.group_ratio[pool-claude]=2.4
 *     + UserUsableGroups[pool-claude]='Claude 号池'(三键,缺一 token 建组 403「已被弃用」)
 *
 *   --cutover :
 *     ch119/124/68(ccmax 号池)group 'claude-aws-platform-t2,default' → 'claude-aws-platform-t2,pool-claude'
 *     + GroupRatio.default 2.4→1.2 + group_ratio_setting.group_ratio.default 2.4→1.2
 *     (cutover 后需 docker restart new-api,见 memory「GroupRatio 三键陷阱」)
 *
 * 顺序:--create-group → portal channel_groups 加行 → 给 15 个受影响客户发 pool-claude key
 *      → --cutover → restart → probe。
 * 默认 dry-run;加 --apply 真改。
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
const MODE = process.argv.includes('--cutover')
    ? 'cutover'
    : process.argv.includes('--create-group')
      ? 'create-group'
      : null;
if (!MODE) {
    console.error('用法: node scripts/configure-pool-claude-group.mjs --create-group|--cutover [--apply]');
    process.exit(1);
}

const GROUP = 'pool-claude';
const RATIO = 2.4;
const LABEL = 'Claude 号池';
const POOL_CHANNELS = [119, 124, 68];
const NEW_CH_GROUP = 'claude-aws-platform-t2,pool-claude';
const DEFAULT_RESTORE = 1.2;

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
    let j;
    try {
        j = JSON.parse(t);
    } catch {
        j = { _raw: t.slice(0, 200) };
    }
    return { status: r.status, json: j, text: t };
}

const opt = await api('/api/option/');
const items = opt.json.data ?? opt.json;
const om = Array.isArray(items) ? Object.fromEntries(items.map((i) => [i.key, i.value])) : items;
const putOption = async (key, valueObj) => {
    const value = JSON.stringify(valueObj);
    if (!APPLY) return true;
    const r = await api('/api/option/', { method: 'PUT', body: JSON.stringify({ key, value }) });
    const ok = r.status === 200 && r.json?.success !== false;
    console.log(`   PUT ${key}: ${r.status} ${ok ? '✅' : '❌ ' + (r.json?.message || r.text.slice(0, 150))}`);
    return ok;
};

console.log(`\n═══ pool-claude ${MODE} (apply=${APPLY}) ═══\n`);

if (MODE === 'create-group') {
    for (const [key, val] of [
        ['GroupRatio', RATIO],
        ['group_ratio_setting.group_ratio', RATIO],
        ['UserUsableGroups', LABEL],
    ]) {
        const parsed = JSON.parse(om[key]);
        console.log(`${key}[${GROUP}]: ${parsed[GROUP] ?? '(新增)'} → ${val}`);
        parsed[GROUP] = val;
        if (!(await putOption(key, parsed))) process.exit(1);
    }
} else {
    // cutover: 渠道摘 default + default 拨回 1.2
    for (const id of POOL_CHANNELS) {
        const c = (await api(`/api/channel/${id}`)).json.data;
        if (!c) {
            console.error(`❌ ch#${id} GET 失败`);
            process.exit(1);
        }
        console.log(`ch#${id} "${c.name}": group '${c.group}' → '${NEW_CH_GROUP}'`);
        if (APPLY) {
            const r = await api('/api/channel/', { method: 'PUT', body: JSON.stringify({ id, group: NEW_CH_GROUP }) });
            const ok = r.status === 200 && r.json?.success !== false;
            console.log(`   PUT: ${r.status} ${ok ? '✅' : '❌ ' + (r.json?.message || '')}`);
            if (!ok) process.exit(1);
        }
    }
    for (const key of ['GroupRatio', 'group_ratio_setting.group_ratio']) {
        const parsed = JSON.parse(om[key]);
        console.log(`${key}[default]: ${parsed.default} → ${DEFAULT_RESTORE}`);
        parsed.default = DEFAULT_RESTORE;
        if (!(await putOption(key, parsed))) process.exit(1);
    }
    console.log('\n⚠️ cutover 后必须: ssh vps "docker restart new-api"(三键陷阱,billing 内存值要重载)');
}

if (!APPLY) {
    console.log('\n[dry-run] --apply 才真改。\n');
    process.exit(0);
}

await new Promise((r) => setTimeout(r, 2000));
const v = await api('/api/option/');
const vi = v.json.data ?? v.json;
const vm = Array.isArray(vi) ? Object.fromEntries(vi.map((i) => [i.key, i.value])) : vi;
console.log('\n═══ Verify ═══');
console.log(`  GroupRatio[${GROUP}] = ${JSON.parse(vm.GroupRatio)[GROUP]}`);
console.log(
    `  group_ratio_setting.group_ratio[${GROUP}] = ${JSON.parse(vm['group_ratio_setting.group_ratio'])[GROUP]}`,
);
console.log(`  UserUsableGroups[${GROUP}] = ${JSON.parse(vm.UserUsableGroups)[GROUP]}`);
console.log(`  GroupRatio[default] = ${JSON.parse(vm.GroupRatio).default}`);
console.log(
    `  group_ratio_setting.group_ratio[default] = ${JSON.parse(vm['group_ratio_setting.group_ratio']).default}`,
);
console.log(
    `  group_ratio_setting(嵌套父键).group_ratio.default = ${JSON.parse(vm['group_ratio_setting']).group_ratio?.default}`,
);
if (MODE === 'cutover') {
    for (const id of POOL_CHANNELS) {
        const c = (await api(`/api/channel/${id}`)).json.data;
        console.log(`  ch#${id} group = ${c.group}`);
    }
}
