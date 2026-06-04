#!/usr/bin/env node
/**
 * 阶段 C — backfill 缺失的 reseller commission(只读 dry-run + --apply 双模式)。
 *
 * 背景:W8 D8 audit(docs/W8-D8-COMMISSION-AUDIT.md)确认 commission 写逻辑无 bug,
 * 当前 prod 缺失候选 = 0。本脚本作为**核验 + 未来工具**:任何「attributed invitee
 * 有 recharge_log 但缺 commission」的历史行,都能在此被发现并补 pending commission。
 *
 * 候选条件(= 当初就该写 commission 却没有):
 *   - recharge_log 存在(invitee 真充值成功)
 *   - invitee.inviter_reseller_id 非 null(有归属代理)
 *   - 充值当时归属仍在保护期内(attribution_expires_at > recharge_log.created_at)
 *   - 对应 reseller 现为 active
 *   - 该 recharge_log 尚无 commission(recharge_log_id UNIQUE)
 *
 * 计算(对齐 src/lib/reseller/{tier,commission}.ts,boundary 内只读取不回写):
 *   rate          = tierForGmv(reseller.cumulative_gmv).rate   // 当前档位费率
 *   attributed_gmv= recharge_log.amount(¥CNY)
 *   amount        = gmv × rate
 *   hold_until    = recharge_log.created_at + 14 天(历史单 → 多半已过 hold,cron 下次 confirm)
 *   status        = pending(永远)
 *   admin_review  = amount > ¥100,000
 *
 * 严格边界(brief §4.3 + operator):
 *   ❌ 不更新 resellers.cumulative_gmv(让 cron / operator 重算)
 *   ❌ 不标 settled / 不写 settled_at
 *   ❌ 不碰 invitee quota(commission 是统计,不是给额)
 *   ❌ 不 backfill 已有 commission 的行(query 已排除 + UNIQUE 兜底)
 *   ❌ overflow-FAILED 的 ¥1000 单无 recharge_log,天然不在候选内(无法挂,正确跳过)
 *
 * 用法(需 prod DATABASE_URL — 在 VPS 上跑或 inline 传):
 *   node scripts/backfill-missing-commissions.mjs            # dry-run(默认,只读)
 *   node scripts/backfill-missing-commissions.mjs --apply    # 真 INSERT pending commission
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// ── .env 加载 ──
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
    /* .env 可选 —— 允许纯 env(如容器内)运行 */
}

const APPLY = process.argv.includes('--apply');

// ── tier 费率(单一事实源 src/lib/reseller/tier.ts;此处内联,改费率两处同步)──
const TIER_RULES = [
    { tier: 'bronze', minGmvCny: 0, rate: 0.1 },
    { tier: 'silver', minGmvCny: 10_000, rate: 0.15 },
    { tier: 'gold', minGmvCny: 100_000, rate: 0.2 },
];
function tierForGmv(gmvCny) {
    const gmv = Number(gmvCny);
    if (!Number.isFinite(gmv) || gmv < 0) return TIER_RULES[0];
    for (let i = TIER_RULES.length - 1; i >= 0; i--) {
        if (gmv >= TIER_RULES[i].minGmvCny) return TIER_RULES[i];
    }
    return TIER_RULES[0];
}
// 14 天 hold(对齐 src/lib/reseller/commission.ts HOLD_DURATION_MS)
const HOLD_DURATION_MS = 14 * 24 * 60 * 60 * 1_000;
const AUTO_REVIEW_THRESHOLD_CNY = 100_000;

const cny = (n) => `¥${Number(n).toFixed(2)}`;

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
    console.log(`\n═══ Backfill 缺失的 reseller commissions (${APPLY ? '--APPLY (真 INSERT)' : 'dry-run 只读'}) ═══\n`);

    // 候选:attributed invitee 有 recharge_log 但缺 commission,充值当时归属有效,reseller active
    const candidates = await prisma.$queryRaw`
        SELECT rl.id            AS recharge_log_id,
               rl.user_id       AS invitee_id,
               rl.amount        AS recharge_cny,
               rl.created_at    AS recharge_at,
               u.email          AS invitee_email,
               u.attribution_expires_at AS attribution_expires_at,
               r.id             AS reseller_id,
               r.status         AS reseller_status,
               r.cumulative_gmv AS reseller_gmv,
               ru.email         AS reseller_email
        FROM recharge_logs rl
        JOIN users u  ON u.id = rl.user_id
        JOIN resellers r ON r.id = u.inviter_reseller_id
        JOIN users ru ON ru.id = r.user_id
        LEFT JOIN reseller_commissions rc ON rc.recharge_log_id = rl.id
        WHERE u.inviter_reseller_id IS NOT NULL
          AND rc.id IS NULL
          AND r.status = 'active'
          AND u.attribution_expires_at IS NOT NULL
          AND u.attribution_expires_at > rl.created_at
        ORDER BY rl.created_at ASC`;

    if (candidates.length === 0) {
        console.log('✅ 无缺失候选 —— 所有 attributed 成功充值都已有 commission。无需 backfill。\n');
        console.log('   (注:overflow-FAILED 的单无 recharge_log,天然不在候选内 —— 见 docs/W8-D8-COMMISSION-AUDIT.md。)\n');
        return;
    }

    let totalCommissionCny = 0;
    const resellers = new Set();
    let inserted = 0;
    let skipped = 0;

    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const rechargeCny = Number(c.recharge_cny);
        const rechargeAt = new Date(c.recharge_at);
        const rule = tierForGmv(c.reseller_gmv);
        const rate = rule.rate;
        const commissionCny = rechargeCny * rate;
        const holdUntil = new Date(rechargeAt.getTime() + HOLD_DURATION_MS);
        const adminReview = commissionCny > AUTO_REVIEW_THRESHOLD_CNY;

        totalCommissionCny += commissionCny;
        resellers.add(c.reseller_email);

        console.log(`(${i + 1}) recharge_log ${String(c.recharge_log_id).slice(0, 8)} → invitee ${c.invitee_email} → reseller ${c.reseller_email}`);
        console.log(
            `    ${cny(rechargeCny)} × ${rule.tier} rate=${rate} = commission ${cny(commissionCny)}` +
                (adminReview ? '  ⚠️ >¥100k → admin_review_required' : ''),
        );
        console.log(`    hold_until: ${holdUntil.toISOString().slice(0, 10)} (14d after recharge ${rechargeAt.toISOString().slice(0, 10)}) · status: pending`);

        if (APPLY) {
            try {
                await prisma.resellerCommission.create({
                    data: {
                        reseller_id: c.reseller_id,
                        user_id: c.invitee_id,
                        recharge_log_id: c.recharge_log_id,
                        attributed_gmv: new Prisma.Decimal(rechargeCny.toFixed(4)),
                        commission_rate: new Prisma.Decimal(rate.toFixed(4)),
                        commission_amount: new Prisma.Decimal(commissionCny.toFixed(4)),
                        status: 'pending',
                        admin_review_required: adminReview,
                        hold_until: holdUntil,
                        // 不写 settled_at;不动 resellers.cumulative_gmv(boundary)
                    },
                });
                inserted += 1;
                console.log('    ✓ INSERTED (pending)');
            } catch (e) {
                // P2002 = recharge_log_id UNIQUE 冲突(竞态 / 重复跑)→ 安全跳过
                if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
                    skipped += 1;
                    console.log('    ⏭️  已存在 commission(UNIQUE)→ 跳过');
                } else {
                    throw e;
                }
            }
        }
        console.log('');
    }

    console.log('─────────────────────────────────────────────');
    console.log('总结:');
    console.log(`  候选 commission     : ${candidates.length} 条`);
    console.log(`  累计分佣(零售)     : ${cny(totalCommissionCny)}`);
    console.log(`  涉及 reseller       : ${resellers.size} 位`);
    if (APPLY) {
        console.log(`  实际 INSERT(pending): ${inserted} 条`);
        console.log(`  跳过(已存在)       : ${skipped} 条`);
        console.log('\n⚠️ 已写入 pending commission。resellers.cumulative_gmv 未动 —— 由 cron / operator 重算。');
    } else {
        console.log('\n跑 --apply 真创建(全部 status=pending,不动 cumulative_gmv)。');
    }
    console.log('');
}

main()
    .catch((e) => {
        console.error('\n❌ backfill 脚本出错:', e instanceof Error ? e.message : e);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
