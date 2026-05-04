/**
 * W4-1 D1 — executeRecharge unit tests.
 *
 * Covers the happy path + idempotency + failure modes for the new-api
 * applyTopup-based recharge introduced in W4-1 D1. The legacy LiteLLM stub
 * (`createAndRedeem`) used to throw deprecation, so before this batch every
 * order silently FAIL'd.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

// ── prisma mock ──
const mockOrderFindUnique = vi.fn();
const mockOrderUpdate = vi.fn();
const mockOrderUpdateMany = vi.fn();
const mockUserFindUnique = vi.fn();
const mockUserUpdate = vi.fn();
const mockRechargeLogFindFirst = vi.fn();
const mockRechargeLogCreate = vi.fn();
const mockAuditLogCreate = vi.fn();
const mockTransaction = vi.fn();

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

import { executeRecharge, OrderError } from '@/lib/order/service';

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

beforeEach(() => {
  vi.clearAllMocks();
  // Default: $transaction runs the array of promises in order. Real Prisma
  // wraps them in a single round-trip; for unit tests Promise.all is fine
  // because the individual mocks don't assume isolation.
  mockTransaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  // CAS lock succeeds by default (count=1 means PAID/FAILED → RECHARGING worked)
  mockOrderUpdateMany.mockResolvedValue({ count: 1 });
  mockOrderUpdate.mockResolvedValue({});
  mockUserUpdate.mockResolvedValue({});
  mockRechargeLogCreate.mockResolvedValue({ id: 'rl-1' });
  mockAuditLogCreate.mockResolvedValue({});
});

describe('executeRecharge — happy path', () => {
  it('200 CNY → applyTopup called once + RechargeLog success row + order COMPLETED', async () => {
    mockOrderFindUnique.mockResolvedValue(pendingOrder({ amount: new Prisma.Decimal('200.00') }));
    mockUserFindUnique.mockResolvedValue({ id: PORTAL_USER_ID, newapi_user_id: NEWAPI_USER_ID });
    mockRechargeLogFindFirst.mockResolvedValue(null); // no prior recharge for this order
    // before topup quota = 100_000, after = 100_000 + cnyToQuota(200)
    const beforeQuota = 100_000;
    const afterQuota = beforeQuota + Math.round((200 / 7.2) * 500_000);
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
    // applyTopup invoked exactly once with newapi_user_id + cnyAmount
    expect(mockApplyTopup).toHaveBeenCalledTimes(1);
    expect(mockApplyTopup).toHaveBeenCalledWith({
      newapi_user_id: NEWAPI_USER_ID,
      cnyAmount: 200,
    });
    // RechargeLog written with correct shape
    expect(mockRechargeLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          user_id: PORTAL_USER_ID,
          order_id: ORDER_ID,
          newapi_user_id: NEWAPI_USER_ID,
          source: 'payment',
          newapi_quota_added: BigInt(Math.round((200 / 7.2) * 500_000)),
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
    mockUserFindUnique.mockResolvedValue({ id: PORTAL_USER_ID, newapi_user_id: NEWAPI_USER_ID });
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
    mockUserFindUnique.mockResolvedValue({ id: PORTAL_USER_ID, newapi_user_id: NEWAPI_USER_ID });
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
    mockUserFindUnique.mockResolvedValue({ id: PORTAL_USER_ID, newapi_user_id: NEWAPI_USER_ID });
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
    mockUserFindUnique.mockResolvedValue({ id: PORTAL_USER_ID, newapi_user_id: null });
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
