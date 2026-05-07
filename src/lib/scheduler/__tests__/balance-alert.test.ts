/**
 * W6 D2 — BalanceAlertScheduler unit tests.
 *
 * Exercises the candidate-scan + per-user decision logic with prisma +
 * quota-cache + email send all mocked. We do NOT spin up the setInterval
 * timer here; tests call `scanAndAlert()` directly so each assertion has
 * a deterministic single-pass execution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const mockUserFindMany = vi.fn();
const mockUserUpdateMany = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        user: {
            findMany: (...args: unknown[]) => mockUserFindMany(...args),
            updateMany: (...args: unknown[]) => mockUserUpdateMany(...args),
        },
    },
}));

const mockGetQuotaWithCache = vi.fn();
vi.mock('@/lib/newapi/quota-cache', () => ({
    getQuotaWithCache: (...args: unknown[]) => mockGetQuotaWithCache(...args),
}));

vi.mock('@/lib/newapi/client', () => ({
    // 1 USD = 7.2 CNY = 500_000 quota → 1 quota = ~0.0144 CNY * 1e-3 ish
    quotaToCny: (quota: number) => (quota / 500_000) * 7.2,
}));

const mockSendBalanceAlertEmail = vi.fn();
vi.mock('@/lib/email/send', () => ({
    sendBalanceAlertEmail: (...args: unknown[]) => mockSendBalanceAlertEmail(...args),
}));

const mockSentryCapture = vi.fn();
vi.mock('@sentry/nextjs', () => ({
    captureException: (...args: unknown[]) => mockSentryCapture(...args),
}));

import { scanAndAlert } from '@/lib/scheduler/balance-alert';

const USER_A = 'aaaa1111-1111-4111-8111-111111111111';
const USER_B = 'bbbb2222-2222-4222-8222-222222222222';

function user(overrides: Partial<{
    id: string;
    email: string;
    threshold: number;
    last_sent_at: Date | null;
}> = {}) {
    return {
        id: overrides.id ?? USER_A,
        email: overrides.email ?? 'a@silkroadai.io',
        balance_alert_threshold_cny: new Prisma.Decimal(overrides.threshold ?? 10),
        balance_alert_last_sent_at: overrides.last_sent_at ?? null,
    };
}

// Snapshot whatever vitest's dotenv setup loaded so we can restore in
// `afterEach` and not pollute other tests in the same worker.
const ORIGINAL_APP_URL = process.env.APP_URL;
const ORIGINAL_NEXT_PUBLIC = process.env.NEXT_PUBLIC_APP_URL;

beforeEach(() => {
    vi.clearAllMocks();
    // W7 D4 PR-J Bug 1: `getAppUrl()` reads APP_URL first (the runtime
    // escape hatch around Next's NEXT_PUBLIC_* build-time inlining).
    // Set both so the email CTA URLs match the prod-shape assertion
    // regardless of which one the helper picks first.
    process.env.APP_URL = 'https://portal.silkroadai.io';
    process.env.NEXT_PUBLIC_APP_URL = 'https://portal.silkroadai.io';
    // Default: claim succeeds (single-instance happy path).
    mockUserUpdateMany.mockResolvedValue({ count: 1 });
    mockSendBalanceAlertEmail.mockResolvedValue({ messageId: 'm-1' });
});

afterEach(() => {
    if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = ORIGINAL_APP_URL;
    if (ORIGINAL_NEXT_PUBLIC === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_NEXT_PUBLIC;
});

describe('scanAndAlert — candidate selection', () => {
    it('passes the right WHERE shape (threshold > 0 + last_sent null OR > 24h)', async () => {
        mockUserFindMany.mockResolvedValue([]);
        const now = new Date('2026-05-05T12:00:00Z');
        await scanAndAlert(now);

        expect(mockUserFindMany).toHaveBeenCalledTimes(1);
        const args = mockUserFindMany.mock.calls[0][0] as {
            where: Record<string, unknown>;
            select: Record<string, unknown>;
            take: number;
        };
        expect(args.where).toMatchObject({
            status: 'active',
            newapi_user_id: { not: null },
            balance_alert_threshold_cny: { gt: 0 },
        });
        // 24h cooldown cutoff is now - 24h
        const orClause = args.where.OR as Array<{ balance_alert_last_sent_at: unknown }>;
        expect(orClause[0]).toEqual({ balance_alert_last_sent_at: null });
        const ltCutoff = (orClause[1].balance_alert_last_sent_at as { lt: Date }).lt;
        expect(ltCutoff.getTime()).toBe(now.getTime() - 24 * 60 * 60 * 1000);
        expect(args.take).toBe(200);
    });
});

describe('scanAndAlert — send decisions', () => {
    it('balance > threshold → no send, skippedAboveThreshold counted', async () => {
        mockUserFindMany.mockResolvedValue([user({ threshold: 5 })]);
        // remain quota maps to ¥10 (well above ¥5 threshold)
        mockGetQuotaWithCache.mockResolvedValue({ remain_quota: 10 * 500_000 / 7.2, used_quota: 0, source: 'live' });

        const r = await scanAndAlert();

        expect(mockSendBalanceAlertEmail).not.toHaveBeenCalled();
        expect(mockUserUpdateMany).not.toHaveBeenCalled();
        expect(r.alertsSent).toBe(0);
        expect(r.skippedAboveThreshold).toBe(1);
    });

    it('balance ≤ threshold → CAS-claim then send + alertsSent counted', async () => {
        mockUserFindMany.mockResolvedValue([user({ threshold: 10 })]);
        // remain ¥3 → below threshold ¥10
        mockGetQuotaWithCache.mockResolvedValue({ remain_quota: 3 * 500_000 / 7.2, used_quota: 0, source: 'cache' });

        const r = await scanAndAlert();

        expect(mockUserUpdateMany).toHaveBeenCalledTimes(1);
        const claimArgs = mockUserUpdateMany.mock.calls[0][0] as { where: Record<string, unknown> };
        expect(claimArgs.where).toMatchObject({
            id: USER_A,
            balance_alert_threshold_cny: { gt: 0 },
        });
        expect(mockSendBalanceAlertEmail).toHaveBeenCalledTimes(1);
        const emailArgs = mockSendBalanceAlertEmail.mock.calls[0][0] as {
            to: string;
            remainCny: number;
            thresholdCny: number;
            topupUrl: string;
            settingsUrl: string;
        };
        expect(emailArgs.to).toBe('a@silkroadai.io');
        expect(emailArgs.remainCny).toBeCloseTo(3, 5);
        expect(emailArgs.thresholdCny).toBe(10);
        expect(emailArgs.topupUrl).toBe('https://portal.silkroadai.io/pay');
        expect(emailArgs.settingsUrl).toBe('https://portal.silkroadai.io/balance');
        expect(r.alertsSent).toBe(1);
    });

    it('CAS-claim count=0 (sibling instance won race) → no email, skippedRaceLost counted', async () => {
        mockUserFindMany.mockResolvedValue([user({ threshold: 10 })]);
        mockGetQuotaWithCache.mockResolvedValue({ remain_quota: 1 * 500_000 / 7.2, used_quota: 0, source: 'live' });
        mockUserUpdateMany.mockResolvedValueOnce({ count: 0 });

        const r = await scanAndAlert();

        expect(mockSendBalanceAlertEmail).not.toHaveBeenCalled();
        expect(r.alertsSent).toBe(0);
        expect(r.skippedRaceLost).toBe(1);
    });

    it('SMTP fail → captured to Sentry but loop continues on other users', async () => {
        mockUserFindMany.mockResolvedValue([
            user({ id: USER_A, email: 'a@x.io', threshold: 10 }),
            user({ id: USER_B, email: 'b@x.io', threshold: 10 }),
        ]);
        mockGetQuotaWithCache.mockResolvedValue({ remain_quota: 1, used_quota: 0, source: 'live' });
        // First send throws, second succeeds.
        mockSendBalanceAlertEmail
            .mockRejectedValueOnce(new Error('SMTP timeout'))
            .mockResolvedValueOnce({ messageId: 'm-2' });

        const r = await scanAndAlert();

        expect(mockSendBalanceAlertEmail).toHaveBeenCalledTimes(2);
        expect(mockSentryCapture).toHaveBeenCalled();
        const tagged = mockSentryCapture.mock.calls.find(
            (c) =>
                (c[1] as { tags?: { area?: string } } | undefined)?.tags?.area === 'balance-alert',
        );
        expect(tagged).toBeDefined();
        // Only one alert succeeded
        expect(r.alertsSent).toBe(1);
        expect(r.errors).toBe(1);
    });

    it('quota fetch fails (cache miss + new-api dead) → skippedQuotaUnavailable, no Sentry', async () => {
        mockUserFindMany.mockResolvedValue([user({ threshold: 10 })]);
        mockGetQuotaWithCache.mockRejectedValue(
            new Error(`quota fetch failed for user ${USER_A}: ECONNREFUSED`),
        );

        const r = await scanAndAlert();

        expect(mockSendBalanceAlertEmail).not.toHaveBeenCalled();
        expect(r.alertsSent).toBe(0);
        expect(r.skippedQuotaUnavailable).toBe(1);
        // quota-fetch-fail isn't a Sentry-worthy event; new-api outage is
        // already alerted by W4-2 D6 quota-cache + W5 D4 health checks.
        expect(mockSentryCapture).not.toHaveBeenCalled();
    });

    it('cache source quota also goes through (no live-only restriction)', async () => {
        mockUserFindMany.mockResolvedValue([user({ threshold: 10 })]);
        // 60s cached value — fully valid; scheduler should not require 'live'.
        mockGetQuotaWithCache.mockResolvedValue({
            remain_quota: 5 * 500_000 / 7.2,
            used_quota: 0,
            source: 'cache' as const,
        });

        const r = await scanAndAlert();

        expect(mockSendBalanceAlertEmail).toHaveBeenCalledTimes(1);
        expect(r.alertsSent).toBe(1);
    });
});

describe('scanAndAlert — opt-out semantics', () => {
    it('threshold === 0 users are excluded by the WHERE clause (DB filter, not code)', async () => {
        // The mock's findMany already returns [] when WHERE.threshold gt 0
        // would exclude. We assert by checking that the WHERE shape carries
        // `gt: 0`, which is the contractual boundary.
        mockUserFindMany.mockResolvedValue([]);
        await scanAndAlert();
        const args = mockUserFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
        expect(args.where.balance_alert_threshold_cny).toEqual({ gt: 0 });
    });
});
