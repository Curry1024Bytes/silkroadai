#!/usr/bin/env node
/**
 * 配置 new-api 的「seedream 5 pro」线(Seedream 5.0 Pro · service-inference.ai,经 portal 适配器
 * /seedream-adapter,2026-09-06)。镜像 setup-seedance-cn-enterprise.mjs 的做法:
 *   1. GroupRatio                       : "seedream 5 pro" = 1(售价烤进适配器合成的 usage,组只做隔离/显示;
 *      已是 1 则不 PUT —— 任何 option PUT 都会即时改内存态,能不动就不动)
 *   2/3. group_ratio_setting(.group_ratio):**缺省不写**。2026-09-07 部署前核查:prod 三键早已分叉 ——
 *      GroupRatio 15 键 / flat 18 键 / nested 17 键,9 个【在用】组(awsb 无f5 / awsb 稀缺 / pool-gpt-elon /
 *      weirdo / 文本+生图 按量 / 静止蒸馏… / kimi / image 2 专属 / auto)三键都没有、全靠内存态放行,
 *      且 default / pool-gpt / pool-claude 三组 GroupRatio 与 flat 的值不同。此时 PUT flat 会让所有不在
 *      map 里的组立刻 403「已被弃用」(2026-06-30 事故),而合并两份值又是 operator 的定价决策 ——
 *      所以本脚本只打印分叉报告;要写必须显式 `--sync-group-setting`(会把 GroupRatio ∪ flat ∪ nested
 *      ∪【在用组=1】全镜像进去,flat 已有值优先),写完必须真打各组各一单看 log other.group_ratio。
 *      seedream 5 pro 与其他 6 个「只在 GroupRatio」的组一样,目前靠内存态放行,已真机验证计费正确。
 *   4. UserUsableGroups                 : "seedream 5 pro" = "seedream 5 pro"(/keys 档位选择器显示名;已存在则不动)
 *   5. ModelRatio / CompletionRatio     : seedream-5-0-pro = 1 / 1 —— 适配器合成的 usage.input/output_tokens
 *      直接就是 quota(500k quota = ¥1),两个倍率必须都是 1,否则售价整体缩放。
 *   6. Channel                          : type=1 → portal 适配器,group=seedream 5 pro,models=seedream-5-0-pro,
 *      key=上游 key,**setting.pass_through_body_enabled=true**(否则 layer_decomposition / image 等字段
 *      到不了适配器),auto_ban=0(单渠道,别让 new-api 因上游抖动把整档禁了)。
 *
 * 用法: SEEDREAM_INF_KEY=sk-inf-v1-... node scripts/setup-seedream-5-pro.mjs [--apply]
 *   需 NEWAPI_BASE_URL 指向 new-api(本地隧道 ssh -fN -L 3000:localhost:3000 vps2;或在 server2 的
 *   portal 容器里跑:docker exec -e SEEDREAM_INF_KEY=... silkroadai-portal-api-1 node scripts/setup-seedream-5-pro.mjs --apply)。
 *
 * === 改完必验(脚本做不了)===
 *   拿一把该组 key 真打一张 1K:log 的 other.model_ratio 应为 1、group_ratio 为 1、quota = 84150(¥0.1683)。
 *   portal channel_groups 行(/keys 档位)由 UserUsableGroups 自动同步生成,已存在(2026-09-06)。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
    const envText = readFileSync(resolve(__dirname, '..', '.env'), 'utf8');
    for (const line of envText.split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
} catch {
    /* 容器里没有 .env 文件时靠环境变量 */
}
const BASE = process.env.NEWAPI_BASE_URL,
    TOKEN = process.env.NEWAPI_ADMIN_TOKEN,
    UID = process.env.NEWAPI_ADMIN_USER_ID || '1';
const APPLY = process.argv.includes('--apply');
const KEY = process.env.SEEDREAM_INF_KEY || '';
const GROUP = 'seedream 5 pro';
const LABEL = 'seedream 5 pro';
const MODEL = 'seedream-5-0-pro';
const ADAPTER_BASE = process.env.SEEDREAM_ADAPTER_BASE || 'http://172.20.0.1:3010/seedream-adapter';
const CH_NAME = 'seedream 5 pro (service-inference · seedream-adapter)';

if (!BASE || !TOKEN) {
    console.error('NEWAPI_BASE_URL / NEWAPI_ADMIN_TOKEN 未设');
    process.exit(1);
}

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
    const d = j?.data ?? j;
    if (Array.isArray(d)) {
        const f = d.find((i) => i && i.key === key);
        return f && f.value != null ? String(f.value) : null;
    }
    if (d && typeof d === 'object') return d[key] == null ? null : String(d[key]);
    return null;
}
const parse = (raw) => {
    try {
        return JSON.parse(raw ?? '') ?? {};
    } catch {
        return {};
    }
};
async function putOption(key, value) {
    console.log(`  PUT ${key}`);
    if (!APPLY) return;
    const r = await api('PUT', '/api/option/', { key, value: JSON.stringify(value) });
    console.log('    ->', r.status, r.j?.success === true ? 'ok' : JSON.stringify(r.j).slice(0, 160));
}

console.log(`=== setup-seedream-5-pro [${APPLY ? 'APPLY' : 'DRY-RUN'}] ===`);
console.log(`adapter base_url: ${ADAPTER_BASE}\ngroup: ${GROUP}  model: ${MODEL}\n`);

// 1: GroupRatio(已是 1 则不动)
const gr = parse(await getOption('GroupRatio'));
const flat = parse(await getOption('group_ratio_setting.group_ratio'));
const nested = parse(await getOption('group_ratio_setting'));
const nestedMap = nested && typeof nested.group_ratio === 'object' && nested.group_ratio ? nested.group_ratio : {};
console.log(`[GroupRatio] ${GROUP} => 1 (before: ${JSON.stringify(gr[GROUP] ?? null)})`);
if (gr[GROUP] !== 1) await putOption('GroupRatio', { ...gr, [GROUP]: 1 });

// 2/3: 分叉报告(缺省只报告不写;见文件头)
const onlyGr = Object.keys(gr).filter((k) => !(k in flat));
const onlyFlat = Object.keys(flat).filter((k) => !(k in gr));
const diffs = Object.keys(gr).filter((k) => k in flat && gr[k] !== flat[k]);
console.log(`[group_ratio_setting.group_ratio] 只在 GroupRatio: ${onlyGr.join(', ') || '(无)'}`);
console.log(`[group_ratio_setting.group_ratio] 只在 flat: ${onlyFlat.join(', ') || '(无)'}`);
console.log(
    `[group_ratio_setting.group_ratio] 值不同: ${diffs.map((k) => `${k} ${gr[k]}≠${flat[k]}`).join(', ') || '(无)'}`,
);
if (process.argv.includes('--sync-group-setting')) {
    // 在用组(渠道 / token)从 channel 列表取;token 的组拿不到(admin API 无全量 token 列表)→ 用 UUG 兜底
    const chList = (await api('GET', '/api/channel/?p=1&page_size=500')).j?.data;
    const chItems = Array.isArray(chList) ? chList : (chList?.items ?? []);
    const used = new Set();
    for (const c of chItems) for (const g of String(c?.group || '').split(',')) if (g.trim()) used.add(g.trim());
    for (const g of Object.keys(parse(await getOption('UserUsableGroups')))) used.add(g);
    const merged = { ...gr, ...nestedMap, ...flat, [GROUP]: 1 };
    for (const g of used) if (!(g in merged)) merged[g] = 1;
    console.log(`[--sync-group-setting] 将写入 ${Object.keys(merged).length} 组:`, JSON.stringify(merged));
    await putOption('group_ratio_setting.group_ratio', merged);
    await putOption('group_ratio_setting', { ...nested, group_ratio: merged });
} else {
    console.log('[group_ratio_setting] 缺省不写(加 --sync-group-setting 才写,见文件头风险说明)');
}

// 4: UserUsableGroups(已有则不动)
const uu = parse(await getOption('UserUsableGroups'));
console.log(`[UserUsableGroups] ${GROUP} => ${JSON.stringify(uu[GROUP] ?? LABEL)} ${uu[GROUP] ? '(exists)' : '(add)'}`);
if (!uu[GROUP]) await putOption('UserUsableGroups', { ...uu, [GROUP]: LABEL });

// 5: ModelRatio / CompletionRatio = 1
for (const key of ['ModelRatio', 'CompletionRatio']) {
    const m = parse(await getOption(key));
    console.log(`[${key}] ${MODEL} => 1 (before: ${JSON.stringify(m[MODEL] ?? null)})`);
    if (m[MODEL] !== 1) await putOption(key, { ...m, [MODEL]: 1 });
}

// 6: channel — create if absent (idempotent by name)
const list = (await api('GET', '/api/channel/?p=1&page_size=500')).j?.data;
const items = Array.isArray(list) ? list : (list?.items ?? []);
const existing = items.find((c) => c?.name === CH_NAME);
console.log(`\n[channel] "${CH_NAME}"  ${existing ? `EXISTS (id=${existing.id})` : 'will CREATE'}`);
const setting = JSON.stringify({
    force_format: false,
    thinking_to_content: false,
    proxy: '',
    pass_through_body_enabled: true,
    system_prompt: '',
    system_prompt_override: false,
});
if (!existing) {
    if (!KEY) {
        console.log('  ⚠️ SEEDREAM_INF_KEY 未设 — 跳过创建(设了再 --apply)');
    } else {
        const payload = {
            type: 1,
            key: KEY,
            openai_organization: '',
            test_model: MODEL,
            status: 1,
            name: CH_NAME,
            weight: 0,
            base_url: ADAPTER_BASE,
            other: '',
            models: MODEL,
            group: GROUP,
            model_mapping: '',
            status_code_mapping: '',
            priority: 0,
            auto_ban: 0,
            other_info: '',
            tag: '',
            setting,
            param_override: '',
            header_override: '',
            remark: 'Seedream 5.0 Pro via portal seedream-adapter (service-inference.ai); pass_through_body_enabled 必须为 true',
            channel_info: {
                is_multi_key: false,
                multi_key_size: 0,
                multi_key_status_list: null,
                multi_key_polling_index: 0,
                multi_key_mode: '',
            },
        };
        console.log(
            `  create: type=1 base_url=${ADAPTER_BASE} group=${GROUP} models=${MODEL} key=${KEY.slice(0, 12)}… pass_through=true auto_ban=0`,
        );
        if (APPLY) {
            const r = await api('POST', '/api/channel/', { mode: 'single', channel: payload });
            console.log('  POST ->', r.status, r.j?.success === true ? 'ok' : JSON.stringify(r.j).slice(0, 200));
        }
    }
} else {
    // 已存在:确保 pass_through 开着(最小 PUT 不动 key)
    let cur = {};
    try {
        cur = JSON.parse(existing.setting || '{}');
    } catch {
        /* ignore */
    }
    if (cur.pass_through_body_enabled !== true) {
        console.log('  pass_through_body_enabled 未开 → PUT 打开');
        if (APPLY) {
            const r = await api('PUT', '/api/channel/', { id: existing.id, setting });
            console.log('  PUT ->', r.status, r.j?.success === true ? 'ok' : JSON.stringify(r.j).slice(0, 200));
        }
    }
}

if (APPLY) {
    console.log('\n=== verify ===');
    const gr2 = parse(await getOption('GroupRatio')),
        flat2 = parse(await getOption('group_ratio_setting.group_ratio')),
        uu2 = parse(await getOption('UserUsableGroups')),
        mr2 = parse(await getOption('ModelRatio')),
        cr2 = parse(await getOption('CompletionRatio'));
    const l2 = (await api('GET', '/api/channel/?p=1&page_size=500')).j?.data;
    const it2 = Array.isArray(l2) ? l2 : (l2?.items ?? []);
    const ch = it2.find((c) => c?.name === CH_NAME);
    let chSetting = {};
    try {
        chSetting = JSON.parse(ch?.setting || '{}');
    } catch {
        /* ignore */
    }
    console.log('  GroupRatio:', gr2[GROUP], ' flat:', flat2[GROUP], ' UUG:', JSON.stringify(uu2[GROUP]));
    console.log('  ModelRatio:', mr2[MODEL], ' CompletionRatio:', cr2[MODEL]);
    console.log(
        '  channel:',
        ch
            ? `id=${ch.id} group=${ch.group} status=${ch.status} pass_through=${chSetting.pass_through_body_enabled}`
            : 'NOT FOUND',
    );
    const missing = Object.keys(gr2).filter((k) => !(k in flat2));
    console.log('  GroupRatio 组未镜像进 flat 的(靠内存态放行):', missing.join(', ') || '(无)');
    const ok =
        gr2[GROUP] === 1 &&
        (flat2[GROUP] === 1 || !process.argv.includes('--sync-group-setting')) &&
        !!uu2[GROUP] &&
        mr2[MODEL] === 1 &&
        cr2[MODEL] === 1 &&
        ch &&
        String(ch.group) === GROUP &&
        chSetting.pass_through_body_enabled === true;
    console.log(ok ? '\n✅ seedream 5 pro configured' : '\n❌ mismatch — check above');
}
