/**
 * W4-1 D1 + W6 D1 — executeRecharge unit tests.
 *
 * Covers the happy path + idempotency + failure modes for the new-api
 * applyTopup-based recharge introduced in W4-1 D1, plus the W6 D1 first-
 * recharge 20% bonus (CAS lock + interactive transaction rollback).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

// ── prisma mock ──
const mockOrderFindUnique = vi.fn();
const mockOrderUpdate = vi.fn();
const mockOrderUpdateMany = vi.fn();
const mockUserFindUnique = vi.fn();
const mockUserUpdate = vi.fn();
const mockUserUpdateMany = vi.fn();
const mockRechargeLogFindFirst = vi.fn();
const mockRechargeLogCreate = vi.fn();
const mockAuditLogCreate = vi.fn();
const mockTransaction = vi.fn();

// W6 D1: $transaction now uses the interactive-callback form. The mock
// passes a `tx` argument that re-uses the same per-method mock fns so
// the assertions inside each test still work (we don't care which surface
// the call came in on — just the shape of the args).
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
}));

import { executeRecharge, OrderError, FIRST_RECHARGE_BONUS_RATE } from '@/lib/order/service';

const ORDER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PORTAL_USER_ID = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
const NEWAPI_USER_ID = 42;

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
    // W6 D1: $transaction now supports both array form (legacy) and
    // interactive-callback form. The recharge path uses callback form.
    mockTransaction.mockImplementation(async (arg: unknown) => {
        if (typeof arg === 'function') {
            return await (arg as (tx: typeof txProxy) => Promise<unknown>)(txProxy);
        }
        return Promise.all(arg as unknown[]);
    });
    // CAS lock succeeds by default (count=1 means PAID/FAILED → RECHARGING worked)
    mockOrderUpdateMany.mockResolvedValue({ count: 1 });
    mockOrderUpdate.mockResolvedValue({});
    mockUserUpdate.mockResolvedValue({});
    // W6 D1 default: bonus CAS-claim succeeds (first-time recharge eligible).
    // Tests that simulate "bonus already used" override this to count=0.
    mockUserUpdateMany.mockResolvedValue({ count: 1 });
    mockRechargeLogCreate.mockResolvedValue({ id: 'rl-1' });
    mockAuditLogCreate.mockResolvedValue({});
});

describe('executeRecharge — happy path', () => {
    it('200 CNY → applyTopup called once + RechargeLog success row + order COMPLETED', async () => {
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('200.00') }));
        // Existing baseline test: user was already granted bonus previously
        // (e.g. legacy fixture) → no bonus expected this round.
        mockUserFindUnique.mockResolvedValue(userRow({ first_recharge_bonus_granted: true }));
        mockRechargeLogFindFirst.mockResolvedValue(null); // no prior recharge for this order
        // before topup quota = 100_000, after = 100_000 + cnyToQuota(200)
        const beforeQuota = 100_000;
        const afterQuota = beforeQuota + Math.round((200 / 7.2) * 500_000);
        mockNewapiGetUser
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: beforeQuota })
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: afterQuota });
        mockApplyTopup.mockResolvedValue(undefined);

        await executeRecharge(ORDER_ID);

        // CAS lock: PAID/FAILED → RECHARGING (still happens outside the tx)
        expect(mockOrderUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: ORDER_ID, status: { in: ['PAID', 'FAILED'] } },
                data: { status: 'RECHARGING' },
            }),
        );
        // applyTopup invoked exactly once with newapi_user_id + cnyAmount + bonus=0
        expect(mockApplyTopup).toHaveBeenCalledTimes(1);
        expect(mockApplyTopup).toHaveBeenCalledWith({
            newapi_user_id: NEWAPI_USER_ID,
            cnyAmount: 200,
            extraBonusQuota: 0,
        });
        // No bonus CAS-claim attempted (peek already saw granted=true)
        expect(mockUserUpdateMany).not.toHaveBeenCalled();
        // RechargeLog written with newapi_quota_added=mainQuota, bonus_quota_added=0
        expect(mockRechargeLogCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    user_id: PORTAL_USER_ID,
                    order_id: ORDER_ID,
                    newapi_user_id: NEWAPI_USER_ID,
                    source: 'payment',
                    newapi_quota_added: BigInt(Math.round((200 / 7.2) * 500_000)),
                    bonus_quota_added: BigInt(0),
                }),
            }),
        );
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
        // No FAILED side effects
        expect(mockOrderUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
        );
        // W4-2 D6 cache bust: success-path transaction nullifies the three
        // newapi_quota_cache columns so the next /balance render forces live.
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

        // Should still finalize successfully — audit fallback uses before+delta
        expect(mockApplyTopup).toHaveBeenCalledTimes(1);
        expect(mockRechargeLogCreate).toHaveBeenCalledTimes(1);
        expect(mockTransaction).toHaveBeenCalledTimes(1);
    });
});

describe('executeRecharge — first-recharge bonus (W6 D1)', () => {
    const cnyAmount = 100;
    const mainQuota = Math.round((cnyAmount / 7.2) * 500_000);
    const expectedBonus = Math.floor(mainQuota * FIRST_RECHARGE_BONUS_RATE);

    it('first recharge → 20% bonus added, granted flipped, RechargeLog records bonus', async () => {
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('100.00') }));
        // Eligible: granted=false
        mockUserFindUnique.mockResolvedValue(userRow({ first_recharge_bonus_granted: false }));
        mockRechargeLogFindFirst.mockResolvedValue(null);
        mockNewapiGetUser
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: 0 })
            .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: mainQuota + expectedBonus });
        mockApplyTopup.mockResolvedValue(undefined);
        mockUserUpdateMany.mockResolvedValue({ count: 1 }); // CAS-claim wins

        await executeRecharge(ORDER_ID);

        // CAS-claim issued the predicate-update inside the tx
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
        // RechargeLog row records main+bonus total in newapi_quota_added,
        // bonus subset in bonus_quota_added.
        expect(mockRechargeLogCreate).toHaveBeenCalledWith(
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
        expect(mockRechargeLogCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    bonus_quota_added: BigInt(0),
                    newapi_quota_added: BigInt(mainQuota),
                }),
            }),
        );
    });

    it('parallel race: peek says eligible but CAS-claim count=0 (sibling order won) → no bonus, no throw', async () => {
        // Simulates: two paid orders for the same user arrive simultaneously.
        // Both peek granted=false outside the tx. Order A's tx runs first,
        // its updateMany flips granted→true (count=1). Order B's tx blocks on
        // the row lock, then re-reads granted=true at tx-time, predicate fails,
        // count=0. Order B should still succeed but skip the bonus.
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

    it('applyTopup throws inside tx → tx rolls back (no RechargeLog write) → order FAILED', async () => {
        // The interactive transaction throws on applyTopup failure. Postgres
        // rolls back the bonus claim too — we can't directly observe the
        // rollback in mocks, but we CAN observe that no RechargeLog was
        // written and that the outer catch ran the FAILED writeback.
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('100.00') }));
        mockUserFindUnique.mockResolvedValue(userRow({ first_recharge_bonus_granted: false }));
        mockRechargeLogFindFirst.mockResolvedValue(null);
        mockNewapiGetUser.mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: 0 });
        mockApplyTopup.mockRejectedValue(new Error('new-api 502'));
        mockUserUpdateMany.mockResolvedValue({ count: 1 }); // claim staged

        await expect(executeRecharge(ORDER_ID)).rejects.toThrow('new-api 502');

        // CAS-claim ran (and would be rolled back by Postgres on real DB)
        expect(mockUserUpdateMany).toHaveBeenCalledTimes(1);
        // applyTopup threw, so RechargeLog never got written
        expect(mockRechargeLogCreate).not.toHaveBeenCalled();
        // Outer catch wrote FAILED + audit
        expect(mockOrderUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: ORDER_ID },
                data: expect.objectContaining({ status: 'FAILED', failedReason: 'new-api 502' }),
            }),
        );
        expect(mockAuditLogCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ action: 'RECHARGE_FAILED' }),
            }),
        );
    });
});

describe('executeRecharge — idempotency', () => {
    it('order already COMPLETED → noop, no applyTopup, no RechargeLog', async () => {
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ status: 'COMPLETED' }));

        await executeRecharge(ORDER_ID);

        expect(mockApplyTopup).not.toHaveBeenCalled();
        expect(mockRechargeLogCreate).not.toHaveBeenCalled();
        // No CAS lock attempt either (early return before the lock)
        expect(mockOrderUpdateMany).not.toHaveBeenCalled();
    });

    it('CAS lock fails (already RECHARGING from concurrent webhook) → noop, no applyTopup', async () => {
        // Order looks PAID at findUnique time, but by the time CAS runs another
        // worker has flipped it to RECHARGING. updateMany returns count=0.
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ status: 'PAID' }));
        mockOrderUpdateMany.mockResolvedValueOnce({ count: 0 }); // CAS fails

        await executeRecharge(ORDER_ID);

        expect(mockApplyTopup).not.toHaveBeenCalled();
        expect(mockRechargeLogCreate).not.toHaveBeenCalled();
        // no FAILED write either
        expect(mockOrderUpdate).not.toHaveBeenCalled();
    });

    it('defensive: pre-existing RechargeLog → finalize order without re-charging new-api', async () => {
        // Simulates: previous attempt called applyTopup successfully + wrote
        // RechargeLog, but crashed before order.status → COMPLETED. Webhook
        // retried, CAS locked again, this defensive check finds the row.
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ status: 'FAILED' }));
        mockUserFindUnique.mockResolvedValue(userRow({ first_recharge_bonus_granted: true }));
        mockRechargeLogFindFirst.mockResolvedValue({
            id: 'rl-prior',
            balance_after: new Prisma.Decimal('100000'),
        });

        await executeRecharge(ORDER_ID);

        // applyTopup MUST NOT be called — would double-charge
        expect(mockApplyTopup).not.toHaveBeenCalled();
        expect(mockRechargeLogCreate).not.toHaveBeenCalled();
        // But order is finalized to COMPLETED
        expect(mockOrderUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: ORDER_ID, status: 'RECHARGING' },
                data: expect.objectContaining({ status: 'COMPLETED', completedAt: expect.any(Date) }),
            }),
        );
    });
});

describe('executeRecharge — failure modes', () => {
    it('applyTopup throws → order FAILED + RECHARGE_FAILED audit + rethrows', async () => {
        mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('50.00') }));
        mockUserFindUnique.mockResolvedValue(userRow({ first_recharge_bonus_granted: true }));
        mockRechargeLogFindFirst.mockResolvedValue(null);
        mockNewapiGetUser.mockResolvedValue({ id: NEWAPI_USER_ID, quota: 0 });
        mockApplyTopup.mockRejectedValue(new Error('new-api 502'));

        await expect(executeRecharge(ORDER_ID)).rejects.toThrow('new-api 502');

        expect(mockApplyTopup).toHaveBeenCalledTimes(1);
        // Order marked FAILED with reason
        expect(mockOrderUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: ORDER_ID },
                data: expect.objectContaining({
                    status: 'FAILED',
                    failedAt: expect.any(Date),
                    failedReason: 'new-api 502',
                }),
            }),
        );
        // RECHARGE_FAILED audit log
        expect(mockAuditLogCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ action: 'RECHARGE_FAILED', detail: 'new-api 502' }),
            }),
        );
        // No RechargeLog success row
        expect(mockRechargeLogCreate).not.toHaveBeenCalled();
        // confirmPayment will see the throw → return false → callback returns
        // 'fail' to easy-pay → easy-pay retries → executeRecharge runs again
        // (FAILED is allowed in CAS lock).
    });

    it('portal user has no newapi_user_id (legacy / un-provisioned) → FAILED + thrown', async () => {
        mockOrderFindUnique.mockResolvedValue(pendingOrder());
        mockUserFindUnique.mockResolvedValue(userRow({ newapi_user_id: null }));
        mockRechargeLogFindFirst.mockResolvedValue(null);

        await expect(executeRecharge(ORDER_ID)).rejects.toThrow(/newapi_user_id/);

        expect(mockApplyTopup).not.toHaveBeenCalled();
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
        // But the FAILED status was written to capture the orphan
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

/* ──────────────────────────────────────────────────────────── */
/* W7 D4 — invite-code bonus rate (30% vs default 20%)          */
/* ──────────────────────────────────────────────────────────── */

describe('executeRecharge — W7 D4 invite-code bonus rate', () => {
    const cnyAmount = 100;
    const mainQuota = Math.round((cnyAmount / 7.2) * 500_000);
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

        // applyTopup gets the 30% bonus, not 20%
        expect(mockApplyTopup).toHaveBeenCalledWith({
            newapi_user_id: NEWAPI_USER_ID,
            cnyAmount,
            extraBonusQuota: expectedInvitedBonus,
        });
        // Sanity: the difference matters — 30% != 20%
        const default20 = Math.floor(mainQuota * FIRST_RECHARGE_BONUS_RATE);
        expect(expectedInvitedBonus).toBeGreaterThan(default20);
        // RechargeLog records the invited bonus subset
        expect(mockRechargeLogCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    bonus_quota_added: BigInt(expectedInvitedBonus),
                }),
            }),
        );
    });

    it('invite_code stored but no longer in INVITE_CODES env → falls back to 20% (soft revoke)', async () => {
        // Operator removed "OLD-CODE" from INVITE_CODES; the user holding it
        // should now get the default 20% bonus rather than 30%.
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
        // Confirms the invite-code rate selection sits *before* the eligibility
        // gate: returning users don't get a second bonus just because their
        // code is still valid.
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
