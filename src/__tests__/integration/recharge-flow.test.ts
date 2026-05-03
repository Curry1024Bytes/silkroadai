/**
 * W4-1 D3 — Recharge flow integration tests.
 *
 * Drives the easy-pay /notify route end-to-end with REAL signature
 * verification (using a test pkey) but mocks prisma + new-api at the
 * boundaries. Validates the D1 executeRecharge changes (CAS lock, RechargeLog
 * dedup, applyTopup invocation, FAILED handling) plus the D3 Sweep 2
 * sig-fail alert log behavior.
 *
 * Brief test matrix:
 *   - happy: Order PAID + no log → notify(valid sig) → applyTopup once →
 *            Order COMPLETED + RechargeLog row + RECHARGE_SUCCESS audit
 *   - duplicate: Order COMPLETED → notify replay(valid sig) → applyTopup NOT
 *            called(handlePaymentNotify early-return on COMPLETED)
 *   - defensive dedup: Order PAID + RechargeLog already exists →
 *            notify(valid sig) → applyTopup NOT called + Order COMPLETED
 *            (covers "previous attempt called add_quota then crashed before
 *            order.status flip")
 *   - sig fail: any state → notify(WRONG sig) → 'success' body + console.warn
 *            (Sweep 2; silent ignore prevents easy-pay loop on attacker spam)
 *   - applyTopup fail: Order PAID → applyTopup throws → 'fail' body +
 *            Order FAILED + RECHARGE_FAILED audit (easy-pay will retry)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { generateSign } from '@/lib/easy-pay/sign';

// ─────────────────────────────────────────────────────────────────────────
// Stateful prisma mock — small in-memory state so a single test can thread
// reads/writes across the multi-step recharge flow (CAS lock, dedup check,
// transaction commit, audit). Reset per-test.
// ─────────────────────────────────────────────────────────────────────────

interface OrderRow {
  id: string;
  user_id: string;
  amount: Prisma.Decimal;
  payAmount: Prisma.Decimal | null;
  status: string;
  rechargeCode: string;
  paymentTradeNo: string | null;
  paidAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  failedReason: string | null;
  updatedAt: Date;
  orderType: string;
}
interface RechargeLogRow {
  id: string;
  user_id: string;
  order_id: string;
  amount: Prisma.Decimal;
  balance_before: Prisma.Decimal;
  balance_after: Prisma.Decimal;
  newapi_quota_added: bigint;
  newapi_user_id: number;
  source: string;
  note: string | null;
}
interface AuditLogRow {
  orderId: string;
  action: string;
  detail: string;
  operator: string;
}

function freshState() {
  return {
    orders: new Map<string, OrderRow>(),
    rechargeLogs: [] as RechargeLogRow[],
    auditLogs: [] as AuditLogRow[],
    users: new Map<string, { id: string; newapi_user_id: number | null; status: string; email: string }>(),
  };
}
type State = ReturnType<typeof freshState>;
let state: State;

// vi.mock factories hoist above all module code, so they cannot reference
// the outer `state` variable directly (TDZ). vi.hoisted() lets us declare
// the prisma mock inside a hoisted block; the factory then references it
// via the returned handle.
const { mockPrismaImpl } = vi.hoisted(() => {
  // Late-binding state holder. The test's beforeEach reassigns
  // _stateHolder.state; the mock impl reads it through this closure.
  const _stateHolder: { state: State | null } = { state: null };
  const getState = () => {
    if (!_stateHolder.state) throw new Error('integration test state not initialized');
    return _stateHolder.state;
  };
  type State = {
    orders: Map<string, OrderRow>;
    rechargeLogs: RechargeLogRow[];
    auditLogs: AuditLogRow[];
    users: Map<string, { id: string; newapi_user_id: number | null; status: string; email: string }>;
  };
  type OrderRow = {
    id: string;
    user_id: string;
    amount: import('@prisma/client').Prisma.Decimal;
    payAmount: import('@prisma/client').Prisma.Decimal | null;
    status: string;
    rechargeCode: string;
    paymentTradeNo: string | null;
    paidAt: Date | null;
    completedAt: Date | null;
    failedAt: Date | null;
    failedReason: string | null;
    updatedAt: Date;
    orderType: string;
  };
  type RechargeLogRow = {
    id: string;
    user_id: string;
    order_id: string;
    amount: import('@prisma/client').Prisma.Decimal;
    balance_before: import('@prisma/client').Prisma.Decimal;
    balance_after: import('@prisma/client').Prisma.Decimal;
    newapi_quota_added: bigint;
    newapi_user_id: number;
    source: string;
    note: string | null;
  };
  type AuditLogRow = { orderId: string; action: string; detail: string; operator: string };

  const impl = {
    _stateHolder,
    order: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(getState().orders.get(args.where.id) ?? null),
      update: (args: { where: { id: string }; data: Partial<OrderRow> }) => {
        const cur = getState().orders.get(args.where.id);
        if (!cur) throw new Error(`order ${args.where.id} not found in mock state`);
        const updated = { ...cur, ...args.data, updatedAt: new Date() };
        getState().orders.set(cur.id, updated);
        return Promise.resolve(updated);
      },
      updateMany: (args: { where: { id: string; status?: { in: string[] } | string }; data: Partial<OrderRow> }) => {
        const cur = getState().orders.get(args.where.id);
        if (!cur) return Promise.resolve({ count: 0 });
        const expectStatusIn = (args.where.status as { in?: string[] } | undefined)?.in;
        const expectStatusEq = typeof args.where.status === 'string' ? args.where.status : undefined;
        const matches =
          (expectStatusIn ? expectStatusIn.includes(cur.status) : true) &&
          (expectStatusEq ? cur.status === expectStatusEq : true);
        if (!matches) return Promise.resolve({ count: 0 });
        const updated = { ...cur, ...args.data, updatedAt: new Date() };
        getState().orders.set(cur.id, updated);
        return Promise.resolve({ count: 1 });
      },
    },
    user: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(getState().users.get(args.where.id) ?? null),
    },
    rechargeLog: {
      findFirst: (args: { where: { order_id: string; source: string } }) => {
        const found = getState().rechargeLogs.find(
          (r) => r.order_id === args.where.order_id && r.source === args.where.source,
        );
        return Promise.resolve(found ?? null);
      },
      create: (args: { data: Omit<RechargeLogRow, 'id'> }) => {
        const row: RechargeLogRow = { id: `rl-${getState().rechargeLogs.length + 1}`, ...args.data };
        getState().rechargeLogs.push(row);
        return Promise.resolve(row);
      },
    },
    auditLog: {
      create: (args: { data: AuditLogRow }) => {
        getState().auditLogs.push(args.data);
        return Promise.resolve(args.data);
      },
    },
    // executeRecharge wraps the finalize step in $transaction. We treat the
    // array of ops as a unit and execute sequentially; real Prisma uses a
    // single roundtrip but for unit tests the ordering is what matters.
    $transaction: (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
  };
  return { mockPrismaImpl: impl };
});

vi.mock('@/lib/db', () => ({
  prisma: mockPrismaImpl,
}));

// ─── new-api mocks ───
const mockApplyTopup = vi.fn();
const mockNewapiGetUser = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
  applyTopup: (...args: unknown[]) => mockApplyTopup(...args),
  getUser: (...args: unknown[]) => mockNewapiGetUser(...args),
  cnyToQuota: (cny: number) => Math.round((cny / 7.2) * 500_000),
}));

// ─── load-balancer mock — return a deterministic test config so the route
//      goes down the `?inst=...` branch and avoids paymentRegistry/DB. ───
const TEST_PKEY = 'test-pkey-secret-w4d3';
const TEST_PID = 'test-pid-1';
// Typed as taking instId so the route's call site (one arg) typechecks; the
// initial impl ignores it and returns a fixed test config.
const mockGetInstanceConfig = vi.fn<(instId: string) => Promise<{ pkey: string; pid: string; api_base: string }>>(
  async () => ({ pkey: TEST_PKEY, pid: TEST_PID, api_base: 'http://test.gateway' }),
);
vi.mock('@/lib/payment/load-balancer', () => ({
  getInstanceConfig: (instId: string) => mockGetInstanceConfig(instId),
}));

// extractHeaders default util — keep real, no mock needed

// ─────────────────────────────────────────────────────────────────────────
// Route + helpers — imported AFTER mocks
// ─────────────────────────────────────────────────────────────────────────
import { GET as easyPayNotifyGET } from '@/app/api/easy-pay/notify/route';

const ORDER_ID = 'order-w4d3-test-1';
const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NEWAPI_USER_ID = 7;
const TRADE_NO = 'easypay-trade-12345';
const CNY_AMOUNT = 10; // brief: ¥10 small recharge

/** Build a signed easy-pay notification URL (GET with query string).
 *
 *  IMPORTANT: provider.verifyNotification builds paramsForSign by stripping
 *  ONLY `sign` + `sign_type` from the parsed query. Anything else — including
 *  our internal `?inst=...` instance selector — ends up in the signed set.
 *  So the test sig must be computed over the full param set including
 *  `inst`, otherwise we'd reproduce a sig-fail on every request. */
function buildNotifyUrl(opts: {
  orderId?: string;
  amount?: number;
  tradeNo?: string;
  pid?: string;
  tamperSig?: boolean;
  instId?: string;
} = {}) {
  const params: Record<string, string> = {
    pid: opts.pid ?? TEST_PID,
    trade_no: opts.tradeNo ?? TRADE_NO,
    out_trade_no: opts.orderId ?? ORDER_ID,
    type: 'alipay',
    name: 'Silk Road AI 余额充值',
    money: (opts.amount ?? CNY_AMOUNT).toFixed(2),
    trade_status: 'TRADE_SUCCESS',
    inst: opts.instId ?? 'test-inst-1',
  };
  const sign = generateSign(params, TEST_PKEY);
  const finalSign = opts.tamperSig ? sign.replace(/^./, sign[0] === 'a' ? 'b' : 'a') : sign;
  const qs = new URLSearchParams({ ...params, sign: finalSign, sign_type: 'MD5' });
  return `http://localhost/api/easy-pay/notify?${qs.toString()}`;
}

function makeNotifyReq(opts: Parameters<typeof buildNotifyUrl>[0] = {}): NextRequest {
  return new NextRequest(buildNotifyUrl(opts), { method: 'GET' });
}

function seedPaidOrder(amount = CNY_AMOUNT) {
  const row: OrderRow = {
    id: ORDER_ID,
    user_id: PORTAL_USER_ID,
    amount: new Prisma.Decimal(amount.toFixed(2)),
    payAmount: new Prisma.Decimal(amount.toFixed(2)),
    status: 'PAID',
    rechargeCode: 'rc-test',
    paymentTradeNo: TRADE_NO,
    paidAt: new Date(),
    completedAt: null,
    failedAt: null,
    failedReason: null,
    updatedAt: new Date(),
    orderType: 'balance',
  };
  state.orders.set(row.id, row);
  state.users.set(PORTAL_USER_ID, {
    id: PORTAL_USER_ID,
    email: 'happy@silkroadai.io',
    newapi_user_id: NEWAPI_USER_ID,
    status: 'active',
  });
}

beforeEach(() => {
  state = freshState();
  // Re-bind the hoisted prisma mock to the new state
  (mockPrismaImpl as unknown as { _stateHolder: { state: State } })._stateHolder.state = state;
  vi.clearAllMocks();
  // Restore mock impls (clearAllMocks wipes them).
  mockGetInstanceConfig.mockResolvedValue({ pkey: TEST_PKEY, pid: TEST_PID, api_base: 'http://test.gateway' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Recharge integration: easy-pay notify → executeRecharge', () => {
  it('happy path: PAID order + valid sig → applyTopup 1× + RechargeLog row + Order COMPLETED + RECHARGE_SUCCESS audit', async () => {
    seedPaidOrder();
    mockNewapiGetUser
      .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: 0 }) // before
      .mockResolvedValueOnce({ id: NEWAPI_USER_ID, quota: Math.round((CNY_AMOUNT / 7.2) * 500_000) }); // after
    mockApplyTopup.mockResolvedValue(undefined);

    const res = await easyPayNotifyGET(makeNotifyReq());
    const body = await res.text();

    expect(body).toBe('success');

    // applyTopup called once with the right shape
    expect(mockApplyTopup).toHaveBeenCalledTimes(1);
    expect(mockApplyTopup).toHaveBeenCalledWith({
      newapi_user_id: NEWAPI_USER_ID,
      cnyAmount: CNY_AMOUNT,
    });

    // RechargeLog written
    expect(state.rechargeLogs).toHaveLength(1);
    const log = state.rechargeLogs[0];
    expect(log.user_id).toBe(PORTAL_USER_ID);
    expect(log.order_id).toBe(ORDER_ID);
    expect(log.source).toBe('payment');
    expect(log.newapi_user_id).toBe(NEWAPI_USER_ID);

    // Order finalized
    const finalOrder = state.orders.get(ORDER_ID)!;
    expect(finalOrder.status).toBe('COMPLETED');
    expect(finalOrder.completedAt).toBeInstanceOf(Date);

    // Audit trail: ORDER_PAID (from confirmPayment) + RECHARGE_SUCCESS (from executeRecharge)
    expect(state.auditLogs.find((a) => a.action === 'RECHARGE_SUCCESS')).toBeDefined();
  });

  it('duplicate: COMPLETED order → notify replay → applyTopup NOT called, no new RechargeLog, response success', async () => {
    seedPaidOrder();
    // Simulate already-fulfilled state
    const existing = state.orders.get(ORDER_ID)!;
    state.orders.set(ORDER_ID, { ...existing, status: 'COMPLETED', completedAt: new Date() });
    state.rechargeLogs.push({
      id: 'rl-prior',
      user_id: PORTAL_USER_ID,
      order_id: ORDER_ID,
      amount: new Prisma.Decimal(CNY_AMOUNT.toFixed(4)),
      balance_before: new Prisma.Decimal(0),
      balance_after: new Prisma.Decimal(694444),
      newapi_quota_added: BigInt(694444),
      newapi_user_id: NEWAPI_USER_ID,
      source: 'payment',
      note: null,
    });

    const res = await easyPayNotifyGET(makeNotifyReq());
    const body = await res.text();

    expect(body).toBe('success');
    expect(mockApplyTopup).not.toHaveBeenCalled();
    // No new log row (still 1, the one we pre-seeded)
    expect(state.rechargeLogs).toHaveLength(1);
    // Order still COMPLETED
    expect(state.orders.get(ORDER_ID)!.status).toBe('COMPLETED');
  });

  it('defensive dedup: PAID + existing RechargeLog → applyTopup skipped + Order finalized', async () => {
    seedPaidOrder();
    // Pre-existing RechargeLog row simulates "previous attempt called
    // applyTopup successfully but crashed before flipping order.status".
    state.rechargeLogs.push({
      id: 'rl-prior',
      user_id: PORTAL_USER_ID,
      order_id: ORDER_ID,
      amount: new Prisma.Decimal(CNY_AMOUNT.toFixed(4)),
      balance_before: new Prisma.Decimal(0),
      balance_after: new Prisma.Decimal(694444),
      newapi_quota_added: BigInt(694444),
      newapi_user_id: NEWAPI_USER_ID,
      source: 'payment',
      note: null,
    });

    const res = await easyPayNotifyGET(makeNotifyReq());
    const body = await res.text();

    expect(body).toBe('success');
    expect(mockApplyTopup).not.toHaveBeenCalled();
    // Still only the pre-seeded log — no second row written
    expect(state.rechargeLogs).toHaveLength(1);
    // Order finalized
    expect(state.orders.get(ORDER_ID)!.status).toBe('COMPLETED');
  });

  it('sig fail: tampered sig → response body "success" + console.warn (Sweep 2)', async () => {
    seedPaidOrder();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await easyPayNotifyGET(makeNotifyReq({ tamperSig: true }));
    const body = await res.text();

    // Silent ignore — easy-pay won't retry on attacker spam
    expect(body).toBe('success');
    // applyTopup never reached
    expect(mockApplyTopup).not.toHaveBeenCalled();
    // Order still PAID, not advanced
    expect(state.orders.get(ORDER_ID)!.status).toBe('PAID');
    // Ops alert via console.warn — must include the route prefix for grepping
    expect(warnSpy).toHaveBeenCalled();
    const warnLines = warnSpy.mock.calls
      .map((c) => c.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
      .join('\n');
    expect(warnLines).toMatch(/easy-pay\/notify.*signature/i);
  });

  it('applyTopup fail: PAID + applyTopup throws → response "fail" + Order FAILED + RECHARGE_FAILED audit (easy-pay will retry)', async () => {
    seedPaidOrder();
    mockNewapiGetUser.mockResolvedValue({ id: NEWAPI_USER_ID, quota: 0 });
    mockApplyTopup.mockRejectedValue(new Error('new-api 502 transient'));

    const res = await easyPayNotifyGET(makeNotifyReq());
    const body = await res.text();

    expect(body).toBe('fail');
    expect(mockApplyTopup).toHaveBeenCalledTimes(1);
    // Order moved to FAILED
    expect(state.orders.get(ORDER_ID)!.status).toBe('FAILED');
    expect(state.orders.get(ORDER_ID)!.failedReason).toContain('new-api 502 transient');
    // No RechargeLog row written — failure path doesn't audit a success log
    expect(state.rechargeLogs).toHaveLength(0);
    // RECHARGE_FAILED audit captured
    expect(state.auditLogs.find((a) => a.action === 'RECHARGE_FAILED')).toBeDefined();
  });
});
