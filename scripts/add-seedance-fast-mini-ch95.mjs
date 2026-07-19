/**
 * 2026-07-19 fast/mini 变体上线:把 8 个新档位模型名 append 到 new-api channel 95 的
 * models 清单(主站 seedance-cn 档展示/档次选择器用;路由本身走 portal 代理拦截,不经 new-api)。
 *
 * 用法(VPS 上,new-api 本机 3000):
 *   NEWAPI_ADMIN_TOKEN=xxx node scripts/add-seedance-fast-mini-ch95.mjs           # dry-run
 *   NEWAPI_ADMIN_TOKEN=xxx node scripts/add-seedance-fast-mini-ch95.mjs --apply   # 实际 PUT
 *
 * 安全:GET 现有 channel → 只 append 缺的名(幂等)→ PUT 带回 models + model_mapping + group
 * (防 gotcha #15 静默清 mapping);其余字段不动(minimal-body PUT 保留 key)。
 */
const BASE = process.env.NEWAPI_BASE_URL || 'http://127.0.0.1:3000';
const TOKEN = process.env.NEWAPI_ADMIN_TOKEN;
const ADMIN_UID = process.env.NEWAPI_ADMIN_USER_ID || '1';
const CHANNEL_ID = Number(process.env.SEEDANCE_CN_CHANNEL_ID || 95);
const APPLY = process.argv.includes('--apply');

if (!TOKEN) {
    console.error('NEWAPI_ADMIN_TOKEN required');
    process.exit(1);
}

const NEW_MODELS = [
    'seedance2.0-fast-720p',
    'seedance2.0-fast-1080p',
    'seedance2.0-fast-720p-ref',
    'seedance2.0-fast-1080p-ref',
    'seedance2.0-mini-720p',
    'seedance2.0-mini-1080p',
    'seedance2.0-mini-720p-ref',
    'seedance2.0-mini-1080p-ref',
];

const headers = { Authorization: TOKEN, 'New-Api-User': ADMIN_UID, 'Content-Type': 'application/json' };

const res = await fetch(`${BASE}/api/channel/${CHANNEL_ID}`, { headers });
const j = await res.json();
if (!j?.success || !j?.data) {
    console.error('GET channel failed:', res.status, JSON.stringify(j).slice(0, 200));
    process.exit(1);
}
const ch = j.data;
const existing = String(ch.models || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const missing = NEW_MODELS.filter((m) => !existing.includes(m));
console.log(`channel ${CHANNEL_ID} "${ch.name}" — 现有 ${existing.length} 模型;待加 ${missing.length}:`, missing);
if (missing.length === 0) {
    console.log('已齐,无需变更。');
    process.exit(0);
}
const nextModels = [...existing, ...missing].join(',');
console.log('PUT 后 models =', nextModels);

if (!APPLY) {
    console.log('\n(dry-run;--apply 执行)');
    process.exit(0);
}

const put = await fetch(`${BASE}/api/channel/`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
        id: CHANNEL_ID,
        models: nextModels,
        // 防 gotcha #15:PUT 不带这些字段可能被静默清 → 原样带回
        model_mapping: ch.model_mapping ?? '',
        group: ch.group,
    }),
});
const pj = await put.json();
console.log('PUT ->', put.status, pj?.success === true ? 'ok' : JSON.stringify(pj).slice(0, 200));

// verify
const v = await (await fetch(`${BASE}/api/channel/${CHANNEL_ID}`, { headers })).json();
const after = String(v?.data?.models || '')
    .split(',')
    .map((s) => s.trim());
const ok = NEW_MODELS.every((m) => after.includes(m));
console.log('verify:', ok ? `全部 ${NEW_MODELS.length} 个已在 models 清单` : 'MISSING — 检查!');
process.exit(ok ? 0 : 1);
