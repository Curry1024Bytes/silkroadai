import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * P4c-1 ¥账本 —— 整个 P4c【唯一】改余额入口。
 *
 * 充值(P4c-3)/扣费(P4c-2)/迁移(P4c-4)/admin 调整(本任务)全部复用 {@link applyLedgerEntry}。
 * 任何代码都【不准】裸 `prisma.account.update({ balance })` —— 改余额必须经这里(乐观锁 + 审计 LedgerEntry)。
 *
 * 原子性:一个 `$transaction` 内 get-or-create Account → 算新余额 → 插 LedgerEntry(带
 * balance_after 快照)→ 乐观锁 updateMany(WHERE version=?)。version 冲突(并发改同一
 * 账户)→ 有限次重试;(kind,ref) 幂等(charge/recharge 传 ref)→ 重复入账视为已记账,返回既有。
 *
 * ⚠️ 本任务没有任何东西【自动】调它(无计量扣费 / 无充值改写)。只有 admin 手动调余额会触发,
 * 且 billing_mode 默认 newapi → 现有客户零行为变化。
 */

export type LedgerKind = 'recharge' | 'charge' | 'adjustment' | 'migration';

export interface ApplyLedgerInput {
    kind: LedgerKind;
    /** 带符号:+ 进账 / − 扣减。number/string/Decimal 都收,内部转 Prisma.Decimal 精确运算(避免浮点长尾)。 */
    amount_cny: Prisma.Decimal | number | string;
    /** 来源关联(Order / UsageRecord id)。charge/recharge 传它 → (kind,ref) 幂等去重;adjustment 传 null。 */
    ref?: string | null;
    note?: string | null;
    createdBy?: string | null;
    /** 新建 Account 时写入的 tenant_id;不传(undefined)则从 user.tenant_id 取(tenantScope 用)。 */
    tenantId?: string | null;
}

export interface LedgerResult {
    entryId: string;
    accountId: string;
    kind: LedgerKind;
    amount_cny: Prisma.Decimal;
    /** 记账后余额快照。 */
    balance_after: Prisma.Decimal;
    /** true = 幂等命中(已存在同 (kind,ref) 记录,未重复入账)。 */
    deduped: boolean;
}

/** 乐观锁版本冲突(updateMany 影响行数=0)→ 内部重试信号,不外抛。 */
class OptimisticLockConflict extends Error {}

/** 重试用尽仍冲突 → 外抛此错(调用方按需 5xx / 重试)。 */
export class LedgerConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LedgerConflictError';
    }
}

const MAX_RETRIES = 5;

/** Prisma P2002 unique 冲突,且(可选)命中某个字段名的约束。 */
function isUniqueViolation(err: unknown, targetField?: string): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
    if (!targetField) return true;
    const t = err.meta?.target;
    const joined = Array.isArray(t) ? t.join(',') : String(t ?? '');
    return joined.includes(targetField);
}

/**
 * 在【给定 tx】内记一笔账(get-or-create Account → 算新余额 → 插 LedgerEntry(带 balance_after)
 * → 乐观锁 updateMany)。**无重试**:乐观锁冲突直接抛 {@link OptimisticLockConflict}(由外层
 * {@link applyLedgerEntry} 的重试包,或【调用方自己的事务】回滚处理)。
 *
 * 供需要把记账并入【自己事务】的调用方复用 —— P4c-4 迁移要求「flip billing_mode + seed ledger
 * 同一 DB 事务原子成/原子回滚」,故走这个 in-tx 版本(普通调用仍走有重试的 applyLedgerEntry)。
 */
export async function applyLedgerEntryInTx(
    tx: Prisma.TransactionClient,
    userId: string,
    input: ApplyLedgerInput,
): Promise<LedgerResult> {
    const amount = new Prisma.Decimal(input.amount_cny);
    const ref = input.ref ?? null;
    // 只有 charge/recharge 且带 ref 才去重;adjustment / migration(ref 带 ts)永不去重。
    const dedupable = ref !== null && (input.kind === 'charge' || input.kind === 'recharge');

    // 1. get-or-create Account(无则建,balance=0 version=0)。
    let account = await tx.account.findUnique({ where: { user_id: userId } });
    if (!account) {
        const tenantId =
            input.tenantId !== undefined
                ? input.tenantId
                : ((await tx.user.findUnique({ where: { id: userId }, select: { tenant_id: true } }))?.tenant_id ??
                  null);
        account = await tx.account.create({ data: { user_id: userId, tenant_id: tenantId } });
    }

    // 幂等快路径:已有同 (kind,ref) → 直接返回既有,不重复入账。
    if (dedupable) {
        const existing = await tx.ledgerEntry.findUnique({
            where: { kind_ref: { kind: input.kind, ref: ref as string } },
        });
        if (existing) return toResult(existing, account.id, input.kind, true);
    }

    const newBalance = account.balance_cny.add(amount);

    // 3. 插 LedgerEntry(带 balance_after 快照)。
    const entry = await tx.ledgerEntry.create({
        data: {
            account_id: account.id,
            tenant_id: account.tenant_id,
            kind: input.kind,
            amount_cny: amount,
            balance_after: newBalance,
            ref,
            note: input.note ?? null,
            created_by: input.createdBy ?? null,
        },
    });

    // 4. 乐观锁:只在 version 未变时更新;变了(并发)→ count=0 → 抛(外层重试 / 调用方 tx 回滚)。
    const updated = await tx.account.updateMany({
        where: { id: account.id, version: account.version },
        data: { balance_cny: newBalance, version: { increment: 1 } },
    });
    if (updated.count === 0) throw new OptimisticLockConflict();

    return {
        entryId: entry.id,
        accountId: account.id,
        kind: input.kind,
        amount_cny: amount,
        balance_after: newBalance,
        deduped: false,
    };
}

export async function applyLedgerEntry(userId: string, input: ApplyLedgerInput): Promise<LedgerResult> {
    const ref = input.ref ?? null;
    const dedupable = ref !== null && (input.kind === 'charge' || input.kind === 'recharge');

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            return await prisma.$transaction((tx) => applyLedgerEntryInTx(tx, userId, input));
        } catch (err) {
            if (err instanceof OptimisticLockConflict) continue; // 版本冲突 → 重试
            if (isUniqueViolation(err, 'user_id')) continue; // 并发建 Account → 重试(下轮 findUnique 命中)
            // 并发插同 (kind,ref) → 幂等:取既有返回。
            if (dedupable && isUniqueViolation(err, 'kind')) {
                const existing = await prisma.ledgerEntry.findUnique({
                    where: { kind_ref: { kind: input.kind, ref: ref as string } },
                });
                if (existing) return toResult(existing, existing.account_id, input.kind, true);
            }
            throw err;
        }
    }
    throw new LedgerConflictError(`applyLedgerEntry: optimistic-lock conflict after ${MAX_RETRIES} retries`);
}

function toResult(
    e: { id: string; amount_cny: Prisma.Decimal; balance_after: Prisma.Decimal },
    accountId: string,
    kind: LedgerKind,
    deduped: boolean,
): LedgerResult {
    return {
        entryId: e.id,
        accountId,
        kind,
        amount_cny: e.amount_cny,
        balance_after: e.balance_after,
        deduped,
    };
}
