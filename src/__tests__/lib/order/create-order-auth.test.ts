/**
 * W4-1 D2 — createOrder auth + lookup tests.
 *
 * Covers ONLY the new early-return branches added in W4-1 D2 (no user_id /
 * portal user not found / portal user inactive). The full happy-path through
 * createOrder requires payment-registry, fee, instance-selector and provider
 * mocks — that's integration territory, deferred to D3 real e2e.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUserFindUnique = vi.fn();
const mockSubscriptionPlanFindUnique = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    subscriptionPlan: {
      findUnique: (...args: unknown[]) => mockSubscriptionPlanFindUnique(...args),
    },
    // Stubs to satisfy other imports inside service.ts that aren't reached
    // in these early-exit tests. If a path tries to use them, the test
    // fails loudly rather than silently doing the wrong thing.
    order: {},
    auditLog: { count: vi.fn().mockResolvedValue(0) },
    paymentProviderInstance: {},
    rechargeLog: {},
    $transaction: vi.fn(),
  },
}));

const mockGetSystemConfig = vi.fn();
const mockGetSystemConfigs = vi.fn();
vi.mock('@/lib/system-config', () => ({
  getSystemConfig: (...args: unknown[]) => mockGetSystemConfig(...args),
  getSystemConfigs: (...args: unknown[]) => mockGetSystemConfigs(...args),
}));

vi.mock('@/lib/config', () => ({
  getEnv: () => ({
    NEXT_PUBLIC_APP_URL: 'http://localhost:3002',
    ORDER_TIMEOUT_MINUTES: 15,
    MIN_RECHARGE_AMOUNT: 1,
    MAX_RECHARGE_AMOUNT: 1000,
    MAX_DAILY_RECHARGE_AMOUNT: 0,
  }),
}));

vi.mock('@/lib/time/biz-day', () => ({
  getBizDayStartUTC: () => new Date('2026-05-03T00:00:00Z'),
}));

import { createOrder, OrderError } from '@/lib/order/service';

const VALID_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: balance-payment is NOT disabled, no daily limit
  mockGetSystemConfig.mockResolvedValue(null);
  mockGetSystemConfigs.mockResolvedValue({});
});

describe('createOrder — auth/user lookup early-return branches (W4-1 D2)', () => {
  it('AUTH_REQUIRED 401 when user_id is null (anonymous request)', async () => {
    await expect(
      createOrder({
        user_id: null,
        amount: 100,
        paymentType: 'alipay',
        clientIp: '127.0.0.1',
      }),
    ).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    });
    // findUnique never reached — no user_id to look up
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it('USER_NOT_FOUND 404 when prisma returns null', async () => {
    mockUserFindUnique.mockResolvedValue(null);

    const promise = createOrder({
      user_id: VALID_USER_ID,
      amount: 100,
      paymentType: 'alipay',
      clientIp: '127.0.0.1',
    });

    await expect(promise).rejects.toBeInstanceOf(OrderError);
    await expect(promise).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
      statusCode: 404,
    });
    expect(mockUserFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: VALID_USER_ID },
        select: expect.objectContaining({
          email: true,
          nickname: true,
          status: true,
        }),
      }),
    );
  });

  it('USER_INACTIVE 403 when portal user.status === "banned"', async () => {
    mockUserFindUnique.mockResolvedValue({
      id: VALID_USER_ID,
      email: 'banned@silkroadai.io',
      nickname: 'BannedUser',
      status: 'banned',
    });

    await expect(
      createOrder({
        user_id: VALID_USER_ID,
        amount: 100,
        paymentType: 'alipay',
        clientIp: '127.0.0.1',
      }),
    ).rejects.toMatchObject({
      code: 'USER_INACTIVE',
      statusCode: 403,
    });
  });

  it('USER_INACTIVE 403 when portal user.status === "disabled"', async () => {
    mockUserFindUnique.mockResolvedValue({
      id: VALID_USER_ID,
      email: 'disabled@silkroadai.io',
      nickname: null, // exercises the email-localpart fallback in service.ts
      status: 'disabled',
    });

    await expect(
      createOrder({
        user_id: VALID_USER_ID,
        amount: 100,
        paymentType: 'alipay',
        clientIp: '127.0.0.1',
      }),
    ).rejects.toMatchObject({
      code: 'USER_INACTIVE',
      statusCode: 403,
    });
  });

  it('BALANCE_PAYMENT_DISABLED 403 takes precedence over user lookup (legacy guard, unchanged)', async () => {
    // R6 admin kill-switch fires BEFORE the user lookup, so we shouldn't
    // even hit the new auth check. Confirms W4-1 D2 didn't reorder the
    // existing balance-disabled gate.
    mockGetSystemConfig.mockImplementation((key: string) =>
      key === 'BALANCE_PAYMENT_DISABLED' ? Promise.resolve('true') : Promise.resolve(null),
    );

    await expect(
      createOrder({
        user_id: VALID_USER_ID,
        amount: 100,
        paymentType: 'alipay',
        clientIp: '127.0.0.1',
        orderType: 'balance',
      }),
    ).rejects.toMatchObject({
      code: 'BALANCE_PAYMENT_DISABLED',
      statusCode: 403,
    });
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });
});
