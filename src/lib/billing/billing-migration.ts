import 'server-only';
import { prisma } from '@/lib/db';
import { getUser, addQuota } from '@/lib/newapi/client';
import { quotaToCny, cnyToQuota } from '@/lib/newapi/quota-units';
import { applyLedgerEntryInTx } from './ledger';
import { syncNewapiGate } from './newapi-gate';

/**
 * P4c-4 灰度翻号工具 —— 把单个客户在 `billing_mode` 'newapi'↔'portal' 之间翻转,
 * 翻进时把 new-api quota 快照迁进 ¥账本,翻出时把账本余额折回 new-api quota。
 * **单号、原子、可逆、留痕、CAS 幂等。**
 *
 * ⚠️ 工具本身不真翻任何号(真翻测试号 = P4c-5,operator 节奏);newapi 客户(没被翻的)零影响。
 * ⚠️ 净中性:翻进 ¥账本 = quotaToCny(原 quota);翻出 new-api quota = cnyToQuota(当前 ¥余额)。
 */

export type BillingMode = 'newapi' | 'portal';

export interface MigrateResult {
    action: 'to_portal' | 'to_newapi';
    /** false = CAS no-op(已在目标模式)→ 没有重复 seed / 重复还。 */
    flipped: boolean;
    /** ¥ 金额。翻进 = seed 进账本的 ¥X;翻出 = 还回 new-api 的当前 ¥Y。flipped=false → 0。 */
    amountCny: number;
    /** 备份:翻号时刻的 new-api raw quota。翻进 = 读到的原始 X;翻出 = 写回 new-api 的 cnyToQuota(Y)。 */
    backupQuota: number;
    newBillingMode: BillingMode;
}

/** CAS 失败(并发已翻 / 已在目标模式)→ 抛此错让 tx 回滚,外层识别为「已翻、no-op」。 */
class AlreadyInTargetMode extends Error {}

/**
 * 翻进:newapi → portal。把 new-api quota 快照迁进 ¥账本。
 *
 * 顺序(DB 事务在前,new-api HTTP 在后、可自愈):
 *  1. peek 必须 newapi + 有 newapi_user_id(否则中止)。
 *  2. 快照 + 备份 X = `getUser().quota`;`amountCny = quotaToCny(X)`。
 *  3. **DB 事务(原子)**:CAS flip billing_mode newapi→portal(拿锁)+ `applyLedgerEntryInTx(migration,+amountCny)`
 *     seed `Account=¥X`。CAS count=0(已 portal)→ 整 tx 回滚、flipped=false(绝不双 seed)。
 *  4. 开哑门(HTTP,best-effort,事务外):`syncNewapiGate` —— 内部校验 `BILLING_SOURCE='portal'`,
 *     总闸没开则 **no-op、new-api quota 维持 X**(客户暂由 quota 把守,等总闸开 + 下轮 meter 再开门)。
 */
export async function migrateUserToPortal(userId: string, createdBy?: string | null): Promise<MigrateResult> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { billing_mode: true, newapi_user_id: true, tenant_id: true },
    });
    if (!user) throw new Error(`user ${userId} not found`);
    if (user.newapi_user_id == null) throw new Error(`user ${userId} has no newapi_user_id (cannot migrate)`);
    if (user.billing_mode !== 'newapi') {
        // 已是 portal(或其它)→ 幂等 no-op,不重复 seed。
        return {
            action: 'to_portal',
            flipped: false,
            amountCny: 0,
            backupQuota: 0,
            newBillingMode: user.billing_mode as BillingMode,
        };
    }

    // 快照 + 备份当前 new-api quota X(净中性迁移的依据,也写进审计 / LedgerEntry note)。
    const backupQuota = (await getUser(user.newapi_user_id)).quota;
    const amountCny = quotaToCny(backupQuota);
    const ref = `migrate-in:${userId}:${Date.now()}`;

    // DB 事务(原子):CAS flip + seed ledger 一起成 / 一起回滚。
    try {
        await prisma.$transaction(async (tx) => {
            const cas = await tx.user.updateMany({
                where: { id: userId, billing_mode: 'newapi' },
                data: {
                    billing_mode: 'portal',
                    // 翻号即清 quota 缓存(镜像 executeRecharge):admin 详情页头部「余额」
                    // 读 newapi_quota_cache,不清会一直显示翻号前的旧值。
                    newapi_quota_cache: null,
                    newapi_used_quota_cache: null,
                    newapi_cached_at: null,
                },
            });
            if (cas.count === 0) throw new AlreadyInTargetMode(); // 并发已翻 → 回滚、不 seed
            await applyLedgerEntryInTx(tx, userId, {
                kind: 'migration',
                amount_cny: amountCny,
                ref,
                note: `migrate-in newapi→portal (backup raw quota=${backupQuota}, ¥${amountCny.toFixed(4)})`,
                createdBy: createdBy ?? null,
                tenantId: user.tenant_id,
            });
        });
    } catch (err) {
        if (err instanceof AlreadyInTargetMode) {
            return { action: 'to_portal', flipped: false, amountCny: 0, backupQuota, newBillingMode: 'portal' };
        }
        throw err; // 真失败 → tx 已回滚(没 flip、没 seed),抛给调用方
    }

    // 开哑门(best-effort,事务外)。失败下一轮 meter / 充值会再 sync(非致命,见 syncNewapiGate)。
    try {
        await syncNewapiGate(userId);
    } catch (gateErr) {
        console.warn(
            `[migration] syncNewapiGate after migrate-in failed for ${userId} (next meter run reconciles):`,
            gateErr instanceof Error ? gateErr.message : gateErr,
        );
    }

    return { action: 'to_portal', flipped: true, amountCny, backupQuota, newBillingMode: 'portal' };
}

/**
 * 翻出 / 回滚:portal → newapi。把【当前】账本余额折回 new-api quota,DB 翻回 newapi。
 *
 * 顺序(先把钱还回 new-api,再翻 DB):
 *  1. peek 必须 portal。读 `Account.balance_cny` 当前 ¥Y(可能已因扣费 / 充值变动 —— 还的是当前值)。
 *  2. **还 quota(HTTP,事务前)**:`addQuota(override, cnyToQuota(Y))` —— 当前余额折回 new-api quota。
 *     override = 绝对设值(P4c-3 实测),重复调幂等(再设同值)。
 *  3. **DB 事务(原子)**:`applyLedgerEntryInTx(migration,−Y)` 把 Account 归 0(留痕"已迁出")+ CAS flip portal→newapi。
 *
 * 结果:new-api quota=¥Y(恢复为余额事实源)、Account=0、billing_mode=newapi → 该号完全回到旧计费。
 * 幂等:CAS(只在 portal 时回滚)+ addQuota override 绝对设值 → 重复点不双还。
 */
export async function rollbackUserToNewapi(userId: string, createdBy?: string | null): Promise<MigrateResult> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            billing_mode: true,
            newapi_user_id: true,
            tenant_id: true,
            account: { select: { balance_cny: true } },
        },
    });
    if (!user) throw new Error(`user ${userId} not found`);
    if (user.newapi_user_id == null) throw new Error(`user ${userId} has no newapi_user_id (cannot rollback)`);
    if (user.billing_mode !== 'portal') {
        return {
            action: 'to_newapi',
            flipped: false,
            amountCny: 0,
            backupQuota: 0,
            newBillingMode: user.billing_mode as BillingMode,
        };
    }

    const balanceY = user.account ? Number(user.account.balance_cny) : 0;
    const backupQuota = cnyToQuota(balanceY); // 当前余额折回 new-api raw quota

    // 还 quota(HTTP,事务前,override 绝对设值 → 幂等)。失败 → 抛、整体回滚(下次重试 override 再设同值)。
    await addQuota({ userId: user.newapi_user_id, quotaDelta: backupQuota, mode: 'override' });

    const ref = `migrate-out:${userId}:${Date.now()}`;

    // DB 事务(原子):Account 归 0(−Y)+ CAS flip portal→newapi 一起成 / 一起回滚。
    try {
        await prisma.$transaction(async (tx) => {
            const cas = await tx.user.updateMany({
                where: { id: userId, billing_mode: 'portal' },
                data: {
                    billing_mode: 'newapi',
                    // 回滚刚 override 了 new-api quota,旧缓存必错 —— 事务内一并清,
                    // 下次任何余额读取走 live 刷新(2026-06-12 实操踩坑:头部余额停在翻号前)。
                    newapi_quota_cache: null,
                    newapi_used_quota_cache: null,
                    newapi_cached_at: null,
                },
            });
            if (cas.count === 0) throw new AlreadyInTargetMode(); // 并发已翻回 → 回滚、不双记
            if (balanceY !== 0) {
                await applyLedgerEntryInTx(tx, userId, {
                    kind: 'migration',
                    amount_cny: -balanceY, // 把 Account 归 0
                    ref,
                    note: `migrate-out portal→newapi (returned ¥${balanceY.toFixed(4)} = ${backupQuota} quota to new-api)`,
                    createdBy: createdBy ?? null,
                    tenantId: user.tenant_id,
                });
            }
        });
    } catch (err) {
        if (err instanceof AlreadyInTargetMode) {
            return { action: 'to_newapi', flipped: false, amountCny: balanceY, backupQuota, newBillingMode: 'newapi' };
        }
        throw err;
    }

    return { action: 'to_newapi', flipped: true, amountCny: balanceY, backupQuota, newBillingMode: 'newapi' };
}
