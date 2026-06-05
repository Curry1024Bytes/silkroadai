/**
 * executeRecharge unit tests.
 *
 * W4-1 D1 (applyTopup-based recharge) + W6 D1 (first-recharge 20% bonus) +
 * W7 D4 (invite-code 30% bonus) + W8 D8 (numeric-overflow fix + intent →
 * execute → confirm idempotency split + smart-recovery failure policy).
 *
 * W8 D8 flow under test (see docs/W8-D8-RECHARGE-BUG-ROOT-CAUSE.md):
 *   阶段 1  dedup: findFirst RechargeLog(order_id, source=payment)
 *             - newapi_quota_added != null → settled → finalize COMPLETED
 *             - newapi_quota_added == null → unconfirmed → FAILED + NEEDS_REVIEW
 *   阶段 2  intent tx (commit): CAS-claim bonus + INSERT placeholder
 *             (newapi_quota_added=null sentinel, balances 0)
 *   阶段 3  execute (no tx): applyTopup. NewApiError → delete placeholder +
 *             revert bonus claim (clean retry); other error → keep placeholder
 *             (manual review on retry)
 *   阶段 4  confirm tx (commit): backfill placeholder (balances in ¥CNY,
 *             newapi_quota_added set) + order COMPLETED + commission + cache bust
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

// W8 D8: a stand-in for new-api's NewApiError so `topupErr instanceof NewApiError`
// in executeRecharge can branch (clean rollback) vs a plain Error (ambiguous,
// keep placeholder). Hoisted so the vi.mock factory below can reference it.
const { MockNewApiError } = vi.hoisted(() => {
    class MockNewApiError extends Error {
        status: number;
        constructor(message: string, status = 502) {
            super(message);
            this.name = 'NewApiError';
            this.status = status;
        }
    }
    return { MockNewApiError };
});

// ── prisma mock ──
const mockOrderFindUnique = vi.fn();
const mockOrderUpdate = vi.fn();
const mockOrderUpdateMany = vi.fn();
const mockUserFindUnique = vi.fn();
const mockUserUpdate = vi.fn();
const mockUserUpdateMany = vi.fn();
const mockRechargeLogFindFirst = vi.fn();
const mockRechargeLogCreate = vi.fn();
const mockRechargeLogUpdate = vi.fn();
const mockRechargeLogDelete = vi.fn();
const mockAuditLogCreate = vi.fn();
const mockTransaction = vi.fn();

// W8 D8: $transaction is now called up to three times per recharge — intent
// (commit before applyTopup), confirm (commit after), and (only on NewApiError)
// a placeholder-rollback. The tx proxy reuses the same per-method mocks so each
// surface (prisma.* and tx.*) hits the same spy.
const txProxy = {
    order: {
        findUnique: (...args: unknown[]) => mockOrderFindUnique(...args),
        update: (...args: unknown[]) => mockOrderUpdate(...args),
        updateMany: (...args: unknown[]) => mockOrderUpdateMany(...args),
    },
    user: {
        findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
        update: (...args: unknown[]) => mockUserUpdate(...args),
        updateMany: (...args: unknown[]) => mockUserUpdateMany(...args),
    },
    rechargeLog: {
        findFirst: (...args: unknown[]) => mockRechargeLogFindFirst(...args),
        create: (...args: unknown[]) => mockRechargeLogCreate(...args),
        update: (...args: unknown[]) => mockRechargeLogUpdate(...args),
        delete: (...args: unknown[]) => mockRechargeLogDelete(...args),
    },
    auditLog: {
        create: (...args: unknown[]) => mockAuditLogCreate(...args),
    },
};

vi.mock('@/lib/db', () => ({
    prisma: {
        order: {
            findUnique: (...args: unknown[]) => mockOrderFindUnique(...args),
            update: (...args: unknown[]) => mockOrderUpdate(...args),
            updateMany: (...args: unknown[]) => mockOrderUpdateMany(...args),
        },
        user: {
            findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
            update: (...args: unknown[]) => mockUserUpdate(...args),
            updateMany: (...args: unknown[]) => mockUserUpdateMany(...args),
        },
        rechargeLog: {
            findFirst: (...args: unknown[]) => mockRechargeLogFindFirst(...args),
            create: (...args: unknown[]) => mockRechargeLogCreate(...args),
            update: (...args: unknown[]) => mockRechargeLogUpdate(...args),
            delete: (...args: unknown[]) => mockRechargeLogDelete(...args),
        },
        auditLog: {
            create: (...args: unknown[]) => mockAuditLogCreate(...args),
        },
        $transaction: (...args: unknown[]) => mockTransaction(...args),
    },
}));

// ── new-api mock ──
const mockApplyTopup = vi.fn();
const mockNewapiGetUser = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    applyTopup: (...args: unknown[]) => mockApplyTopup(...args),
    getUser: (...args: unknown[]) => mockNewapiGetUser(...args),
    // 1 USD = 7.2 CNY = 500_000 quota → 1 CNY = 69_444.44... quota
    cnyToQuota: (cny: number) => Math.round((cny / 7.2) * 500_000),
    // inverse: raw quota → ¥CNY (W8 D8: balance_* now stored as ¥CNY)
    quotaToCny: (quota: number) => (quota / 500_000) * 7.2,
    NewApiError: MockNewApiError,
}));

import { executeRecharge, OrderError, FIRST_RECHARGE_BONUS_RATE } from '@/lib/order/service';

const ORDER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PORTAL_USER_ID = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
const NEWAPI_USER_ID = 42;
const cnyToQuota = (cny: number) => Math.round((cny / 7.2) * 500_000);
const quotaToCny = (quota: number) => (quota / 500_000) * 7.2;

function pendingOrder(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: ORDER_ID,
        user_id: PORTAL_USER_ID,
        amount: new Prisma.Decimal('100.00'), // 100 CNY
        status: 'PAID',
        rechargeCode: 'rc-xxxx',
        completedAt: null,
        failedAt: null,
        failedReason: null,
        ...overrides,
    };
}

function userRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: PORTAL_USER_ID,
        newapi_user_id: NEWAPI_USER_ID,
        // W6 D1 default: user has NOT yet claimed first-recharge bonus.
        // Most happy-path tests want bonus ON (first-time recharge).
        first_recharge_bonus_granted: false,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    // $transaction supports interactive-callback form (intent / confirm /
    // rollback) and the legacy array form. The recharge path uses callbacks.
    mockTransaction.mockImplementation(async (arg: unknown) => {
        if (typeof arg === 'function') {
            return await (arg as (tx: typeof txProxy) => Promise<unknown>)(txProxy);
        }
        return Promise.all(arg as unknown[]);
    });
    // CAS lock + final RECHARGING→COMPLETED both use order.updateMany; default
    // count=1. Tests that simulate a lost CAS race override the first call.
    mockOrderUpdateMany.mockResolvedValue({ count: 1 });
    mockOrderUpdate.mockResolvedValue({});
    mockUserUpdate.mockResolvedValue({});
    // W6 D1 default: bonus CAS-claim succeeds (first-time recharge eligible).
    // Tests that simulate "bonus already used / sibling won" override to count=0.
    mockUserUpdateMany.mockResolvedValue({ count: 1 });
    // W8 D8: create returns the placeholder id; update/delete settle/rollback it.
    mockRechargeLogCreate.mockResolvedValue({ id: 'rl-1' });
    mockRechargeLogUpdate.mockResolvedValue({});
    mockRechargeLogDelete.mockResolvedValue({});
    mockAuditLogCreate.mockResolvedValue({});
});

describe('executeRecharge — happy path', () => {
    it('200 CNY → applyTopup once, placeholder then settle, order COMPLETED', async () => {
        const mainQuota = cnyToQuota(200);
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('200.00') }));
        // Already granted previously → no bonus this round.
        mockUserFindUnique.mockResolvedValue(userRow({ first_recharge_bonus_granted: true }));
        mockRechargeLogFindFirst.mockResolvedValue(null); // no prior recharge for this order
        const beforeQuota = 100_000;
        const afterQuota = beforeQuota + mainQuota;
        mockNewapiGetUser
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: beforeQuota })
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: afterQuota });
        mockApplyTopup.mockResolvedValue(undefined);

        await executeRecharge(ORDER_ID);

        // CAS lock: PAID/FAILED → RECHARGING
        expect(mockOrderUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: ORDER_ID, status: { in: ['PAID', 'FAILED'] } },
                data: { status: 'RECHARGING' },
            }),
        );
        // applyTopup invoked exactly once with bonus=0
        expect(mockApplyTopup).toHaveBeenCalledTimes(1);
        expect(mockApplyTopup).toHaveBeenCalledWith({
            newapi_user_id: NEWAPI_USER_ID,
            cnyAmount: 200,
            extraBonusQuota: 0,
        });
        // No bonus CAS-claim attempted (peek already saw granted=true)
        expect(mockUserUpdateMany).not.toHaveBeenCalled();
        // 阶段 2: placeholder created with the null sentinel (unconfirmed) before topup
        expect(mockRechargeLogCreate).toHaveBeenCalledTimes(1);
        expect(mockRechargeLogCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    user_id: PORTAL_USER_ID,
                    order_id: ORDER_ID,
                    newapi_user_id: NEWAPI_USER_ID,
                    source: 'payment',
                    newapi_quota_added: null,
                    bonus_quota_added: BigInt(0),
                }),
            }),
        );
        // 阶段 4: settle UPDATE flips the sentinel to the real quota total
        expect(mockRechargeLogUpdate).toHaveBeenCalledTimes(1);
        expect(mockRechargeLogUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'rl-1' },
                data: expect.objectContaining({
                    newapi_quota_added: BigInt(mainQuota),
                    bonus_quota_added: BigInt(0),
                }),
            }),
        );
        // Two interactive transactions: intent + confirm
        expect(mockTransaction).toHaveBeenCalledTimes(2);
        // Final transition RECHARGING → COMPLETED
        expect(mockOrderUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: ORDER_ID, status: 'RECHARGING' },
                data: expect.objectContaining({ status: 'COMPLETED', completedAt: expect.any(Date) }),
            }),
        );
        // RECHARGE_SUCCESS audit log
        expect(mockAuditLogCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ orderId: ORDER_ID, action: 'RECHARGE_SUCCESS' }),
            }),
        );
        // No FAILED side effects, no placeholder delete
        expect(mockOrderUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
        );
        expect(mockRechargeLogDelete).not.toHaveBeenCalled();
        // W4-2 D6 cache bust on the confirm transaction
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: PORTAL_USER_ID },
                data: expect.objectContaining({
                    newapi_quota_cache: null,
                    newapi_used_quota_cache: null,
                    newapi_cached_at: null,
                }),
            }),
        );
    });

    it('balance_after read failure falls back to before+delta (audit ok, finalize ok)', async () => {
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('72.00') }));
        mockUserFindUnique.mockResolvedValue(userRow({ first_recharge_bonus_granted: true }));
        mockRechargeLogFindFirst.mockResolvedValue(null);
        mockNewapiGetUser
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: 50_000 }) // before ok
            .mockRejectedValueOnce(new Error('after read transient')); // after fails
        mockApplyTopup.mockResolvedValue(undefined);

        await executeRecharge(ORDER_ID);

        // Still finalizes — audit fallback uses before+delta, settle UPDATE runs
        expect(mockApplyTopup).toHaveBeenCalledTimes(1);
        expect(mockRechargeLogCreate).toHaveBeenCalledTimes(1); // placeholder
        expect(mockRechargeLogUpdate).toHaveBeenCalledTimes(1); // settle
        expect(mockTransaction).toHaveBeenCalledTimes(2); // intent + confirm
    });
});

describe('executeRecharge — first-recharge bonus (W6 D1)', () => {
    const cnyAmount = 100;
    const mainQuota = cnyToQuota(cnyAmount);
    const expectedBonus = Math.floor(mainQuota * FIRST_RECHARGE_BONUS_RATE);

    it('first recharge → 20% bonus added, granted flipped, settle records bonus', async () => {
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('100.00') }));
        mockUserFindUnique.mockResolvedValue(userRow({ first_recharge_bonus_granted: false }));
        mockRechargeLogFindFirst.mockResolvedValue(null);
        mockNewapiGetUser
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: 0 })
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: mainQuota + expectedBonus });
        mockApplyTopup.mockResolvedValue(undefined);
        mockUserUpdateMany.mockResolvedValue({ count: 1 }); // CAS-claim wins

        await executeRecharge(ORDER_ID);

        // CAS-claim issued inside the intent tx
        expect(mockUserUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: PORTAL_USER_ID, first_recharge_bonus_granted: false },
                data: { first_recharge_bonus_granted: true },
            }),
        );
        // applyTopup called with extraBonusQuota = floor(mainQuota * 0.20)
        expect(mockApplyTopup).toHaveBeenCalledWith({
            newapi_user_id: NEWAPI_USER_ID,
            cnyAmount,
            extraBonusQuota: expectedBonus,
        });
        // Placeholder records the bonus subset already (the bonus decision is
        // fixed at intent time so concurrent siblings can't double-grant).
        expect(mockRechargeLogCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    newapi_quota_added: null,
                    bonus_quota_added: BigInt(expectedBonus),
                }),
            }),
        );
        // Settle records main+bonus total + bonus subset
        expect(mockRechargeLogUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    newapi_quota_added: BigInt(mainQuota + expectedBonus),
                    bonus_quota_added: BigInt(expectedBonus),
                }),
            }),
        );
        // Audit log captures bonus details
        expect(mockAuditLogCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    action: 'RECHARGE_SUCCESS',
                    detail: expect.stringContaining('"firstRechargeBonus":true'),
                }),
            }),
        );
    });

    it('second recharge (already granted) → no bonus, no CAS-claim attempted', async () => {
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('100.00') }));
        mockUserFindUnique.mockResolvedValue(userRow({ first_recharge_bonus_granted: true }));
        mockRechargeLogFindFirst.mockResolvedValue(null);
        mockNewapiGetUser
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: mainQuota * 2 })
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: mainQuota * 3 });
        mockApplyTopup.mockResolvedValue(undefined);

        await executeRecharge(ORDER_ID);

        // No CAS-claim because peek already showed granted=true (data self-heal)
        expect(mockUserUpdateMany).not.toHaveBeenCalled();
        expect(mockApplyTopup).toHaveBeenCalledWith({
            newapi_user_id: NEWAPI_USER_ID,
            cnyAmount,
            extraBonusQuota: 0,
        });
        expect(mockRechargeLogUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    bonus_quota_added: BigInt(0),
                    newapi_quota_added: BigInt(mainQuota),
                }),
            }),
        );
    });

    it('parallel race: peek eligible but CAS-claim count=0 (sibling won) → no bonus, no throw', async () => {
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('100.00') }));
        mockUserFindUnique.mockResolvedValue(userRow({ first_recharge_bonus_granted: false }));
        mockRechargeLogFindFirst.mockResolvedValue(null);
        mockNewapiGetUser
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: 0 })
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: mainQuota });
        mockApplyTopup.mockResolvedValue(undefined);
        mockUserUpdateMany.mockResolvedValue({ count: 0 }); // sibling order won the race

        await executeRecharge(ORDER_ID);

        // CAS-claim WAS attempted (peek showed eligible)
        expect(mockUserUpdateMany).toHaveBeenCalledTimes(1);
        // But bonus stays 0 because count=0
        expect(mockApplyTopup).toHaveBeenCalledWith({
            newapi_user_id: NEWAPI_USER_ID,
            cnyAmount,
            extraBonusQuota: 0,
        });
        expect(mockRechargeLogCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ bonus_quota_added: BigInt(0) }),
            }),
        );
        // Recharge still finalizes — no FAILED writeback
        expect(mockOrderUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
        );
    });
});

describe('executeRecharge — idempotency', () => {
    it('order already COMPLETED → noop, no applyTopup, no placeholder', async () => {
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ status: 'COMPLETED' }));

        await executeRecharge(ORDER_ID);

        expect(mockApplyTopup).not.toHaveBeenCalled();
        expect(mockRechargeLogCreate).not.toHaveBeenCalled();
        // No CAS lock attempt either (early return before the lock)
        expect(mockOrderUpdateMany).not.toHaveBeenCalled();
    });

    it('CAS lock fails (already RECHARGING from concurrent webhook) → noop, no applyTopup', async () => {
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ status: 'PAID' }));
        mockOrderUpdateMany.mockResolvedValueOnce({ count: 0 }); // CAS fails

        await executeRecharge(ORDER_ID);

        expect(mockApplyTopup).not.toHaveBeenCalled();
        expect(mockRechargeLogCreate).not.toHaveBeenCalled();
        expect(mockOrderUpdate).not.toHaveBeenCalled();
    });

    it('pre-existing SETTLED placeholder (newapi_quota_added != null) → finalize COMPLETED, no re-charge', async () => {
        // Prior attempt confirmed the top-up (settled) but somehow order isn't
        // COMPLETED (e.g. duplicate webhook re-locked from FAILED). Finalize
        // idempotently without touching new-api.
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ status: 'FAILED' }));
        mockRechargeLogFindFirst.mockResolvedValue({
            id: 'rl-prior',
            newapi_quota_added: BigInt(694_444),
        });

        await executeRecharge(ORDER_ID);

        expect(mockApplyTopup).not.toHaveBeenCalled();
        expect(mockRechargeLogCreate).not.toHaveBeenCalled();
        expect(mockOrderUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: ORDER_ID, status: 'RECHARGING' },
                data: expect.objectContaining({ status: 'COMPLETED', completedAt: expect.any(Date) }),
            }),
        );
    });

    it('pre-existing UNSETTLED placeholder (newapi_quota_added == null) → FAILED + NEEDS_REVIEW, no re-charge', async () => {
        // A prior attempt created the placeholder but its top-up outcome is
        // unknown (crash before confirm, or an ambiguous network failure that
        // kept the placeholder). Smart-recovery: do NOT auto re-charge.
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ status: 'FAILED' }));
        mockRechargeLogFindFirst.mockResolvedValue({
            id: 'rl-pending',
            newapi_quota_added: null,
        });

        await executeRecharge(ORDER_ID); // resolves (no throw → webhook stops retrying)

        expect(mockApplyTopup).not.toHaveBeenCalled();
        expect(mockRechargeLogCreate).not.toHaveBeenCalled();
        // Order routed to FAILED with a NEEDS_REVIEW reason + audit
        expect(mockOrderUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: ORDER_ID },
                data: expect.objectContaining({
                    status: 'FAILED',
                    failedReason: expect.stringContaining('RECHARGE_NEEDS_REVIEW'),
                }),
            }),
        );
        expect(mockAuditLogCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ action: 'RECHARGE_NEEDS_REVIEW' }),
            }),
        );
    });
});

describe('executeRecharge — failure modes (W8 D8 smart recovery)', () => {
    it('applyTopup throws NewApiError → placeholder deleted + bonus claim reverted → order FAILED', async () => {
        // new-api responded with an error (e.g. 502) → nothing was charged →
        // safe to fully roll back this attempt so a retry re-charges cleanly.
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('100.00') }));
        mockUserFindUnique.mockResolvedValue(userRow({ first_recharge_bonus_granted: false }));
        mockRechargeLogFindFirst.mockResolvedValue(null);
        mockNewapiGetUser.mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: 0 });
        mockApplyTopup.mockRejectedValue(new MockNewApiError('new-api POST /api/user/manage 502: bad gateway', 502));
        mockUserUpdateMany.mockResolvedValue({ count: 1 }); // claim won

        await expect(executeRecharge(ORDER_ID)).rejects.toThrow('502');

        // Placeholder was created (intent) then deleted (clean rollback)
        expect(mockRechargeLogCreate).toHaveBeenCalledTimes(1);
        expect(mockRechargeLogDelete).toHaveBeenCalledWith({ where: { id: 'rl-1' } });
        // Bonus claim reverted so the user keeps their first-recharge bonus
        expect(mockUserUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: PORTAL_USER_ID, first_recharge_bonus_granted: true },
                data: { first_recharge_bonus_granted: false },
            }),
        );
        // Outer catch wrote FAILED + RECHARGE_FAILED audit
        expect(mockOrderUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: ORDER_ID },
                data: expect.objectContaining({ status: 'FAILED' }),
            }),
        );
        expect(mockAuditLogCreate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ action: 'RECHARGE_FAILED' }) }),
        );
        // No settle UPDATE happened
        expect(mockRechargeLogUpdate).not.toHaveBeenCalled();
    });

    it('applyTopup throws non-NewApiError (ambiguous) → placeholder KEPT, order FAILED (manual review on retry)', async () => {
        // A network/timeout error: we don't know whether quota was added, so
        // keep the placeholder (its null sentinel routes the retry to review).
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('100.00') }));
        mockUserFindUnique.mockResolvedValue(userRow({ first_recharge_bonus_granted: false }));
        mockRechargeLogFindFirst.mockResolvedValue(null);
        mockNewapiGetUser.mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: 0 });
        mockApplyTopup.mockRejectedValue(new Error('fetch failed: ETIMEDOUT'));
        mockUserUpdateMany.mockResolvedValue({ count: 1 });

        await expect(executeRecharge(ORDER_ID)).rejects.toThrow('ETIMEDOUT');

        // Placeholder created and NOT deleted (kept for manual review)
        expect(mockRechargeLogCreate).toHaveBeenCalledTimes(1);
        expect(mockRechargeLogDelete).not.toHaveBeenCalled();
        // Bonus claim NOT reverted (we don't know if the bonus quota landed)
        expect(mockUserUpdateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: { first_recharge_bonus_granted: false } }),
        );
        // Order FAILED + RECHARGE_FAILED audit
        expect(mockOrderUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: ORDER_ID },
                data: expect.objectContaining({ status: 'FAILED', failedReason: 'fetch failed: ETIMEDOUT' }),
            }),
        );
        expect(mockRechargeLogUpdate).not.toHaveBeenCalled();
    });

    it('portal user has no newapi_user_id (legacy / un-provisioned) → FAILED + thrown, no placeholder', async () => {
        mockOrderFindUnique.mockResolvedValue(pendingOrder());
        mockUserFindUnique.mockResolvedValue(userRow({ newapi_user_id: null }));
        mockRechargeLogFindFirst.mockResolvedValue(null);

        await expect(executeRecharge(ORDER_ID)).rejects.toThrow(/newapi_user_id/);

        expect(mockApplyTopup).not.toHaveBeenCalled();
        expect(mockRechargeLogCreate).not.toHaveBeenCalled();
        expect(mockOrderUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: ORDER_ID },
                data: expect.objectContaining({
                    status: 'FAILED',
                    failedReason: expect.stringContaining('newapi_user_id'),
                }),
            }),
        );
    });

    it('order has no user_id (orphan) → FAILED + 400 OrderError before CAS lock', async () => {
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ user_id: null }));

        await expect(executeRecharge(ORDER_ID)).rejects.toBeInstanceOf(OrderError);

        expect(mockApplyTopup).not.toHaveBeenCalled();
        expect(mockOrderUpdateMany).not.toHaveBeenCalled(); // never reached the CAS lock
        expect(mockOrderUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: ORDER_ID },
                data: expect.objectContaining({ status: 'FAILED' }),
            }),
        );
    });

    it('order not found → throws NOT_FOUND OrderError', async () => {
        mockOrderFindUnique.mockResolvedValue(null);

        await expect(executeRecharge('does-not-exist')).rejects.toThrow('Order not found');
        expect(mockApplyTopup).not.toHaveBeenCalled();
    });
});

describe('executeRecharge — W8 D8 numeric-overflow regression', () => {
    it('large raw quota (1B) stores ¥CNY in balance_*, never the raw value', async () => {
        // The incident: getUser().quota (~1–2 亿/十亿) written into balance_* →
        // numeric overflow. Now balance_* must hold ¥CNY (quotaToCny), far below
        // the old numeric(12,4) ceiling (~1 亿).
        const beforeRaw = 1_000_000_000; // 10 亿 raw quota
        const mainQuota = cnyToQuota(100);
        const afterRaw = beforeRaw + mainQuota;
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('100.00') }));
        mockUserFindUnique.mockResolvedValue(userRow({ first_recharge_bonus_granted: true }));
        mockRechargeLogFindFirst.mockResolvedValue(null);
        mockNewapiGetUser
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: beforeRaw })
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: afterRaw });
        mockApplyTopup.mockResolvedValue(undefined);

        await executeRecharge(ORDER_ID);

        const updateArg = mockRechargeLogUpdate.mock.calls[0][0] as {
            data: { balance_before: Prisma.Decimal; balance_after: Prisma.Decimal; newapi_quota_added: bigint };
        };
        const balanceBefore = Number(updateArg.data.balance_before);
        const balanceAfter = Number(updateArg.data.balance_after);
        // balance_* are ¥CNY-scale (≈ quotaToCny(raw)), NOT the raw quota
        expect(balanceBefore).toBeCloseTo(quotaToCny(beforeRaw), 2);
        expect(balanceAfter).toBeCloseTo(quotaToCny(afterRaw), 2);
        // Comfortably below the old numeric(12,4) ceiling (~99,999,999.9999)
        expect(balanceAfter).toBeLessThan(99_999_999);
        // raw quota still recorded — but in the BigInt column, which can't overflow
        expect(updateArg.data.newapi_quota_added).toBe(BigInt(mainQuota));
    });

    it('5 webhook deliveries for the same order → applyTopup called exactly once', async () => {
        // 1st delivery charges; deliveries 2–5 see the order COMPLETED and noop.
        mockOrderFindUnique
            .mockResolvedValueOnce(pendingOrder({ amount: new Prisma.Decimal('100.00'), status: 'PAID' }))
            .mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('100.00'), status: 'COMPLETED' }));
        mockUserFindUnique.mockResolvedValue(userRow({ first_recharge_bonus_granted: true }));
        mockRechargeLogFindFirst.mockResolvedValue(null);
        mockNewapiGetUser.mockResolvedValue({ id: NEWAPI_USER_ID, quota: 1_000 });
        mockApplyTopup.mockResolvedValue(undefined);

        for (let i = 0; i < 5; i++) {
            await executeRecharge(ORDER_ID);
        }

        // The core invariant: the non-rollbackable top-up runs once across retries.
        expect(mockApplyTopup).toHaveBeenCalledTimes(1);
        expect(mockRechargeLogCreate).toHaveBeenCalledTimes(1);
    });

    it('NewApiError on first delivery then success on retry → applyTopup twice (clean re-charge), no settle on the failed attempt', async () => {
        // Delivery 1: order PAID, applyTopup 502 → placeholder deleted, FAILED.
        // Delivery 2: order FAILED, no placeholder (deleted) → clean re-charge.
        mockOrderFindUnique
            .mockResolvedValueOnce(pendingOrder({ amount: new Prisma.Decimal('100.00'), status: 'PAID' }))
            .mockResolvedValueOnce(pendingOrder({ amount: new Prisma.Decimal('100.00'), status: 'FAILED' }));
        mockUserFindUnique.mockResolvedValue(userRow({ first_recharge_bonus_granted: true }));
        mockRechargeLogFindFirst.mockResolvedValue(null); // placeholder was deleted, so retry finds none
        mockNewapiGetUser.mockResolvedValue({ id: NEWAPI_USER_ID, quota: 1_000 });
        mockApplyTopup.mockRejectedValueOnce(new MockNewApiError('new-api 502', 502)).mockResolvedValueOnce(undefined);

        await expect(executeRecharge(ORDER_ID)).rejects.toThrow('502'); // delivery 1
        await executeRecharge(ORDER_ID); // delivery 2 — clean re-charge

        expect(mockApplyTopup).toHaveBeenCalledTimes(2);
        // Delivery 1 deleted its placeholder; delivery 2 created + settled a fresh one
        expect(mockRechargeLogDelete).toHaveBeenCalledTimes(1);
        expect(mockRechargeLogCreate).toHaveBeenCalledTimes(2);
        expect(mockRechargeLogUpdate).toHaveBeenCalledTimes(1); // only the successful attempt settles
    });
});

/* ──────────────────────────────────────────────────────────── */
/* W7 D4 — invite-code bonus rate (30% vs default 20%)          */
/* ──────────────────────────────────────────────────────────── */

describe('executeRecharge — W7 D4 invite-code bonus rate', () => {
    const cnyAmount = 100;
    const mainQuota = cnyToQuota(cnyAmount);
    const ORIGINAL_INVITE = process.env.INVITE_CODES;

    beforeEach(() => {
        delete process.env.INVITE_CODES;
    });

    afterAll(() => {
        if (ORIGINAL_INVITE === undefined) delete process.env.INVITE_CODES;
        else process.env.INVITE_CODES = ORIGINAL_INVITE;
    });

    it('invite_code currently valid → 30% bonus (not 20%)', async () => {
        process.env.INVITE_CODES = 'LAUNCH-A, FRIEND2026';
        const expectedInvitedBonus = Math.floor(mainQuota * 0.3);

        mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('100.00') }));
        mockUserFindUnique.mockResolvedValue(
            userRow({
                first_recharge_bonus_granted: false,
                invite_code: 'LAUNCH-A', // valid against env above
            }),
        );
        mockRechargeLogFindFirst.mockResolvedValue(null);
        mockNewapiGetUser.mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: 0 }).mockResolvedValueOnce({
            id: NEWAPI_USER_ID,
            quota: mainQuota + expectedInvitedBonus,
        });
        mockApplyTopup.mockResolvedValue(undefined);
        mockUserUpdateMany.mockResolvedValue({ count: 1 });

        await executeRecharge(ORDER_ID);

        expect(mockApplyTopup).toHaveBeenCalledWith({
            newapi_user_id: NEWAPI_USER_ID,
            cnyAmount,
            extraBonusQuota: expectedInvitedBonus,
        });
        const default20 = Math.floor(mainQuota * FIRST_RECHARGE_BONUS_RATE);
        expect(expectedInvitedBonus).toBeGreaterThan(default20);
        // Placeholder records the invited bonus subset
        expect(mockRechargeLogCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    bonus_quota_added: BigInt(expectedInvitedBonus),
                }),
            }),
        );
    });

    it('invite_code stored but no longer in INVITE_CODES env → falls back to 20% (soft revoke)', async () => {
        process.env.INVITE_CODES = 'NEW-CODE';
        const expectedDefault20 = Math.floor(mainQuota * FIRST_RECHARGE_BONUS_RATE);

        mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('100.00') }));
        mockUserFindUnique.mockResolvedValue(
            userRow({
                first_recharge_bonus_granted: false,
                invite_code: 'OLD-CODE', // user has it stored, but env no longer lists it
            }),
        );
        mockRechargeLogFindFirst.mockResolvedValue(null);
        mockNewapiGetUser.mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: 0 }).mockResolvedValueOnce({
            id: NEWAPI_USER_ID,
            quota: mainQuota + expectedDefault20,
        });
        mockApplyTopup.mockResolvedValue(undefined);
        mockUserUpdateMany.mockResolvedValue({ count: 1 });

        await executeRecharge(ORDER_ID);

        expect(mockApplyTopup).toHaveBeenCalledWith({
            newapi_user_id: NEWAPI_USER_ID,
            cnyAmount,
            extraBonusQuota: expectedDefault20,
        });
    });

    it('invite_code is null → default 20% bonus (no regression vs W6 D1)', async () => {
        process.env.INVITE_CODES = 'LAUNCH-A';
        const expectedDefault20 = Math.floor(mainQuota * FIRST_RECHARGE_BONUS_RATE);

        mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('100.00') }));
        mockUserFindUnique.mockResolvedValue(
            userRow({
                first_recharge_bonus_granted: false,
                invite_code: null, // user registered without a code
            }),
        );
        mockRechargeLogFindFirst.mockResolvedValue(null);
        mockNewapiGetUser.mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: 0 }).mockResolvedValueOnce({
            id: NEWAPI_USER_ID,
            quota: mainQuota + expectedDefault20,
        });
        mockApplyTopup.mockResolvedValue(undefined);
        mockUserUpdateMany.mockResolvedValue({ count: 1 });

        await executeRecharge(ORDER_ID);

        expect(mockApplyTopup).toHaveBeenCalledWith({
            newapi_user_id: NEWAPI_USER_ID,
            cnyAmount,
            extraBonusQuota: expectedDefault20,
        });
    });

    it('invite_code valid but user already granted bonus → no new bonus regardless of rate', async () => {
        process.env.INVITE_CODES = 'LAUNCH-A';

        mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('100.00') }));
        mockUserFindUnique.mockResolvedValue(
            userRow({
                first_recharge_bonus_granted: true, // already used
                invite_code: 'LAUNCH-A',
            }),
        );
        mockRechargeLogFindFirst.mockResolvedValue(null);
        mockNewapiGetUser
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: mainQuota })
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: 2 * mainQuota });
        mockApplyTopup.mockResolvedValue(undefined);

        await executeRecharge(ORDER_ID);

        expect(mockApplyTopup).toHaveBeenCalledWith({
            newapi_user_id: NEWAPI_USER_ID,
            cnyAmount,
            extraBonusQuota: 0,
        });
        // No CAS-claim because peek saw granted=true
        expect(mockUserUpdateMany).not.toHaveBeenCalled();
    });
});
