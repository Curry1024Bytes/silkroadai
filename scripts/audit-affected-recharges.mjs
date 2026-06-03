#!/usr/bin/env node
/**
 * 阶段 C — 扫描受 W8 D8 executeRecharge bug 影响的历史客户(只读,绝不动余额)。
 *
 * bug 症状:旧 executeRecharge 把 raw quota 写进 numeric(12,4) → overflow → 充值
 * 事务回滚但不可回滚的 applyTopup 已生效 → 易支付 webhook 重试 → 同一订单被重复
 * 入账 N×。受害订单的指纹 = **status=FAILED 且 paid_at != null**(客户付了钱,但
 * portal 把订单记成失败,recharge_logs 没有成功行)。
 *
 * 本脚本:
 *   1. 查所有 FAILED + paid_at!=null 的订单,按用户去重。
 *   2. 对每个受影响用户,直读 new-api 真实 quota + used_quota(= 客户实际拿到的总额)。
 *   3. 跟该用户「全部已付订单金额合计」对比,算多发倍数,> 1.5× 标⚠️。
 *   4. 汇总:受影响用户数 + 估算多发(零售 ¥ + 按 ¥0.6/$1 拿货价的真实成本)。
 *
 * ⚠️ 只读 + 报告。**不调** add_quota / set_quota / 任何写操作。回收 / 退款 / 留余额
 *    由 operator 看完报告决策(boundary:不在脚本里动客户余额)。
 *
 * 用法(需 prod portal DATABASE_URL + new-api SSH 隧道开着):
 *   ssh -fN -L 3000:localhost:3000 -o ServerAliveInterval=60 vps   # new-api 隧道
 *   node scripts/audit-affected-recharges.mjs
 *
 * 退出码:0 = 跑完(无论有没有受影响用户);非 0 = 脚本自身出错。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// ── .env 加载(镜像 scripts/diagnose-user-quota.mjs)──
const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, '..', '.env'), 'utf8');
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
// 与 portal quota-units 同源(读 env,默认值对齐 src/lib/newapi/quota-units.ts)。
// 这样「应给 raw quota」与 executeRecharge 实际 cnyToQuota 的算法一致。
const QUOTA_PER_USD = parseInt(process.env.NEWAPI_QUOTA_PER_USD || '500000', 10);
const FX = parseFloat(process.env.USD_TO_CNY_RATE || '7.2');
// operator 拿货价(¥/$1)。仅用于估算真实成本,不影响判定。
const COST_CNY_PER_USD = parseFloat(process.env.OPERATOR_COST_CNY_PER_USD || '0.6');
// 多发判定阈值:实际持有 > 应给 × 此倍数 → 标记。1.5 容纳 ≤30% 首充 bonus。
const FLAG_RATIO = 1.5;

if (!BASE || !TOKEN || !UID) {
    console.error('❌ 缺 NEWAPI_BASE_URL / NEWAPI_ADMIN_TOKEN / NEWAPI_ADMIN_USER_ID,请检查 .env');
    process.exit(1);
}

const rawToCny = (raw) => (raw / QUOTA_PER_USD) * FX;
const cny2 = (n) => `¥${n.toFixed(2)}`;

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/** GET new-api,只读。返回 { status, data } 或抛。 */
async function newapiGet(path) {
    const r = await fetch(`${BASE}${path}`, {
        headers: { Authorization: TOKEN, 'New-Api-User': UID, 'Content-Type': 'application/json' },
    });
    const text = await r.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        /* */
    }
    if (!r.ok || (json && json.success === false)) {
        throw new Error(`new-api ${path} ${r.status}: ${json?.message ?? text?.slice(0, 200)}`);
    }
    return json?.data ?? json;
}

async function main() {
    console.log('\n═══ 受 executeRecharge bug(W8 D8)影响的客户 ═══\n');
    console.log(
        `汇率口径: 1 USD = ${QUOTA_PER_USD.toLocaleString()} quota = ${cny2(FX)} | 拿货价 ${cny2(COST_CNY_PER_USD)}/$1 | 判定阈值 ${FLAG_RATIO}×\n`,
    );

    // 1. 受害指纹:FAILED + paid_at != null
    const failedPaid = await prisma.order.findMany({
        where: { status: 'FAILED', paidAt: { not: null } },
        select: {
            id: true,
            user_id: true,
            amount: true,
            paidAt: true,
            failedReason: true,
        },
        orderBy: { paidAt: 'asc' },
    });

    if (failedPaid.length === 0) {
        console.log('✅ 没有 FAILED + 已付款 订单 — 无受影响客户。\n');
        return;
    }
    console.log(`发现 ${failedPaid.length} 笔 FAILED+已付款 订单,涉及以下用户:\n`);

    // 按 user_id 去重
    const byUser = new Map();
    for (const o of failedPaid) {
        if (!o.user_id) {
            console.log(`  ⚠️ 订单 ${o.id} 无 user_id(orphan),跳过,需人工查。`);
            continue;
        }
        if (!byUser.has(o.user_id)) byUser.set(o.user_id, []);
        byUser.get(o.user_id).push(o);
    }

    let idx = 0;
    let affectedCount = 0;
    let totalOverRetailCny = 0;
    let totalOverRaw = 0;

    for (const [userId, failedOrders] of byUser) {
        idx += 1;
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, email: true, newapi_user_id: true, first_recharge_bonus_granted: true },
        });
        if (!user) {
            console.log(`\n(${idx}) portal user ${userId} 不存在(已删?)— 跳过。`);
            continue;
        }
        if (user.newapi_user_id == null) {
            console.log(`\n(${idx}) ${user.email} — 无 newapi_user_id(未开通),跳过。`);
            continue;
        }

        // 该用户「全部已付订单」(任何状态,只要 paid_at!=null)= 客户真实付过的钱
        const paidOrders = await prisma.order.findMany({
            where: { user_id: userId, paidAt: { not: null } },
            select: { id: true, amount: true, status: true },
        });
        const sumPaidCny = paidOrders.reduce((s, o) => s + Number(o.amount), 0);
        const completedCount = paidOrders.filter((o) => o.status === 'COMPLETED').length;

        // new-api 实际持有 = quota(剩余) + used_quota(已耗)
        let realRaw = null;
        let errMsg = null;
        try {
            const nu = await newapiGet(`/api/user/${user.newapi_user_id}`);
            realRaw = (nu.quota || 0) + (nu.used_quota || 0);
        } catch (e) {
            errMsg = e instanceof Error ? e.message : String(e);
        }

        console.log(`\n(${idx}) ${user.email} (portal=${user.id.slice(0, 8)}, uid=${user.newapi_user_id})`);
        console.log(
            `    FAILED+已付: ${failedOrders.length} 笔 [${failedOrders.map((o) => o.id.slice(0, 8)).join(', ')}]`,
        );
        console.log(`    全部已付订单: ${paidOrders.length} 笔(其中 ${completedCount} 笔 COMPLETED),合计付款 ${cny2(sumPaidCny)}`);

        if (realRaw == null) {
            console.log(`    ⚠️ 无法读 new-api 余额: ${errMsg} — 需人工查(SSH 隧道是否在?)`);
            continue;
        }

        const realCny = rawToCny(realRaw);
        const ratio = sumPaidCny > 0 ? realCny / sumPaidCny : Infinity;
        console.log(
            `    new-api 实际持有: ${realRaw.toLocaleString()} raw = ${cny2(realCny)}(应约 ${cny2(sumPaidCny)} + ≤30% 首充)`,
        );

        if (ratio > FLAG_RATIO) {
            const overRetail = realCny - sumPaidCny;
            const overRaw = realRaw - Math.round(sumPaidCny / FX * QUOTA_PER_USD);
            const overCost = (overRaw / QUOTA_PER_USD) * COST_CNY_PER_USD;
            affectedCount += 1;
            totalOverRetailCny += overRetail;
            totalOverRaw += overRaw;
            console.log(
                `    ⚠️ 疑似多发: 实际 ${cny2(realCny)} ≈ 付款的 ${ratio.toFixed(1)}× — 多发约 ${cny2(overRetail)} 零售(拿货成本 ≈ ${cny2(overCost)})`,
            );
        } else {
            console.log(`    ✓ 实际 ${cny2(realCny)} 在合理区间(${ratio.toFixed(2)}×),非典型多发。`);
        }
    }

    // 4. 汇总
    console.log('\n─────────────────────────────────────────────');
    console.log('总结:');
    console.log(`  扫描 FAILED+已付订单 : ${failedPaid.length} 笔,涉及 ${byUser.size} 个用户`);
    console.log(`  疑似多发(>${FLAG_RATIO}×)用户 : ${affectedCount}`);
    console.log(`  估算多发(零售)     : ${cny2(totalOverRetailCny)}`);
    console.log(
        `  估算真实成本(@${cny2(COST_CNY_PER_USD)}/$1): ${cny2((totalOverRaw / QUOTA_PER_USD) * COST_CNY_PER_USD)}`,
    );
    console.log('\n⚠️ 本脚本只读。回收 quota / 退款 / 留余额由 operator 决策,不在脚本里执行。');
    console.log('   (提示:修复上线后,新失败会落 status=FAILED + RECHARGE_NEEDS_REVIEW 审计,定向复核更省事。)\n');
}

main()
    .catch((e) => {
        console.error('\n❌ 审计脚本出错:', e instanceof Error ? e.message : e);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
