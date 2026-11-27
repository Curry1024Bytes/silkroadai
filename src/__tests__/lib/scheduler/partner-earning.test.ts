import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const mockQueryLogs = vi.fn();
const mockCursorUpsert = vi.fn();
const mockCursorUpdateMany = vi.fn();
const mockRetailHistoryFindMany = vi.fn();
const mockUserFindMany = vi.fn();
const mockHistoryFindMany = vi.fn();
const mockEarningCreateMany = vi.fn();
const mockEarningFindFirst = vi.fn();
const mockEarningAggregate = vi.fn();
const mockWalletUpsert = vi.fn();

vi.mock('@/lib/db', () => {
    const prisma = {
        usageMeterCursor: {
            upsert: (...a: unknown[]) => mockCursorUpsert(...a),
            updateMany: (...a: unknown[]) => mockCursorUpdateMany(...a),
        },
        partnerRetailRatioHistory: { findMany: (...a: unknown[]) => mockRetailHistoryFindMany(...a) },
        partnerWholesaleRatioHistory: { findMany: (...a: unknown[]) => mockHistoryFindMany(...a) },
        user: { findMany: (...a: unknown[]) => mockUserFindMany(...a) },
        partnerEarning: {
            createMany: (...a: unknown[]) => mockEarningCreateMany(...a),
            findFirst: (...a: unknown[]) => mockEarningFindFirst(...a),
            aggregate: (...a: unknown[]) => mockEarningAggregate(...a),
        },
        partnerWallet: { upsert: (...a: unknown[]) => mockWalletUpsert(...a) },
        $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
    };
    return { prisma };
});
vi.mock('@/lib/newapi/client', () => ({ queryLogs: (...a: unknown[]) => mockQueryLogs(...a) }));
vi.mock('@/lib/partner/pricing-sync', () => ({
    loadPlatformBillingGroups: async () => new Map([['sd-official', 'SD官转']]),
    reconcilePartnerPricing: async () => [],
}));

import { quotaToCny } from '@/lib/newapi/quota-units';
import type { NewApiUsageLog } from '@/lib/newapi/client';
import {
    retailLookup,
    runPartnerEarning,
    settleLog,
    settleRefund,
    wholesaleLookup,
} from '@/lib/scheduler/partner-earning';

const TENANT = '11111111-2222-3333-4444-555555555555';
const JAN_1 = Date.UTC(2026, 0, 1);
const FEB_1 = Date.UTC(2026, 1, 1) / 1000;

function log(overrides: Partial<NewApiUsageLog> = {}): NewApiUsageLog {
    return {
        id: 205,
        user_id: 7,
        created_at: FEB_1 + 3600,
        type: 2,
        content: '',
        username: 'c-partner',
        token_name: 'default',
        model_name: 'claude-opus-5-5',
        quota: 450_000,
        prompt_tokens: 1000,
        completion_tokens: 200,
        use_time: 1,
        is_stream: false,
        channel: 20,
        token_id: 1,
        group: 'SD官转',
        other: JSON.stringify({ group_ratio: 0.1, user_group_ratio: 0.09 }),
        request_id: 'req-1',
        ...overrides,
    };
}

const wholesaleHistory = [
    { tenant_id: TENANT, group_key: 'sd-official', wholesale_ratio: new Prisma.Decimal(0.06), effective_from: new Date(JAN_1) },
    { tenant_id: TENANT, group_key: 'sd-official', wholesale_ratio: new Prisma.Decimal(0.07), effective_from: new Date(FEB_1 * 1000) },
];
const retailHistory = [
    { tenant_id: TENANT, group_key: 'sd-official', retail_ratio: new Prisma.Decimal(0.09), effective_from: new Date(JAN_1) },
];
const groupKeys = new Map([['SD官转', 'sd-official']]);

describe('settleLog', () => {
    const settle = (entry: NewApiUsageLog) =>
        settleLog({
            log: entry,
            tenantId: TENANT,
            userId: 'u1',
            groupKeys,
            retailAt: retailLookup(retailHistory),
            wholesaleAt: wholesaleLookup(wholesaleHistory),
        });

    it('uses the logged partner retail ratio and the wholesale ratio in force at log time', () => {
        const outcome = settle(log());
        expect(outcome.kind).toBe('earning');
        if (outcome.kind !== 'earning') return;
        const retail = new Prisma.Decimal(quotaToCny(450_000)).toDecimalPlaces(6);
        const wholesale = retail.mul(0.07).div(0.09).toDecimalPlaces(6);
        expect(outcome.row.retail_ratio.toNumber()).toBe(0.09);
        expect(outcome.row.wholesale_ratio.toNumber()).toBe(0.07);
        expect(outcome.row.retail_cny.toString()).toBe(retail.toString());
        expect(outcome.row.wholesale_cny.toString()).toBe(wholesale.toString());
        expect(outcome.row.profit_cny.toString()).toBe(retail.minus(wholesale).toString());
        expect(outcome.row.group_key).toBe('sd-official');
        expect(outcome.row.kind).toBe('consume');
        expect(outcome.row.charged_quota).toBe(450_000n);
    });

    it('settles older logs at the wholesale ratio that applied back then', () => {
        const outcome = settle(log({ created_at: Date.UTC(2026, 0, 15) / 1000 }));
        expect(outcome.kind === 'earning' && outcome.row.wholesale_ratio.toNumber()).toBe(0.06);
    });

    it('settles a log charged just before the group was closed', () => {
        const closed = [
            ...retailHistory,
            { tenant_id: TENANT, group_key: 'sd-official', retail_ratio: null, effective_from: new Date((FEB_1 + 3600 + 600) * 1000) },
        ];
        const outcome = settleLog({
            log: log(),
            tenantId: TENANT,
            userId: 'u1',
            groupKeys,
            retailAt: retailLookup(closed),
            wholesaleAt: wholesaleLookup(wholesaleHistory),
        });
        expect(outcome.kind).toBe('earning');
    });

    it('accepts a new retail ratio that reached new-api before its history row was committed', () => {
        // 扣费发生在改价那一刻，历史行 60 秒后才落库
        const changed = [
            ...retailHistory,
            { tenant_id: TENANT, group_key: 'sd-official', retail_ratio: new Prisma.Decimal(0.12), effective_from: new Date((FEB_1 + 3600 + 60) * 1000) },
        ];
        const outcome = settleLog({
            log: log({ other: JSON.stringify({ user_group_ratio: 0.12 }) }),
            tenantId: TENANT,
            userId: 'u1',
            groupKeys,
            retailAt: retailLookup(changed),
            wholesaleAt: wholesaleLookup(wholesaleHistory),
        });
        expect(outcome.kind).toBe('earning');
    });

    it.each([
        ['no_partner_ratio', log({ other: JSON.stringify({ group_ratio: 0.1, user_group_ratio: -1 }) })],
        ['ratio_not_partner', log({ other: JSON.stringify({ user_group_ratio: 0.2 }) })],
        ['group_unknown', log({ group: 'Claude' })],
        ['zero_quota', log({ quota: 0 })],
    ])('skips with %s', (reason, entry) => {
        expect(settle(entry)).toEqual({ kind: 'skip', reason });
    });

    it('skips when no wholesale ratio covered the charge', () => {
        const retailFromDecember = [
            { tenant_id: TENANT, group_key: 'sd-official', retail_ratio: new Prisma.Decimal(0.09), effective_from: new Date(Date.UTC(2025, 11, 1)) },
        ];
        expect(
            settleLog({
                log: log({ created_at: Date.UTC(2025, 11, 15) / 1000 }),
                tenantId: TENANT,
                userId: 'u1',
                groupKeys,
                retailAt: retailLookup(retailFromDecember),
                wholesaleAt: wholesaleLookup(wholesaleHistory),
            }),
        ).toEqual({ kind: 'skip', reason: 'no_wholesale' });
    });
});

describe('settleRefund', () => {
    const consume = {
        tenant_id: TENANT,
        user_id: 'u1',
        newapi_log_id: 205,
        kind: 'consume' as const,
        task_id: 'task_1',
        model_slug: 'seedance-2.0',
        group_key: 'sd-official',
        prompt_tokens: 0,
        completion_tokens: 0,
        charged_quota: 300_000n,
        retail_ratio: new Prisma.Decimal(0.09),
        wholesale_ratio: new Prisma.Decimal(0.07),
        retail_cny: new Prisma.Decimal(6),
        wholesale_cny: new Prisma.Decimal(4.666667),
        profit_cny: new Prisma.Decimal(1.333333),
    };

    it('reverses the profit in proportion to the refunded quota', () => {
        const outcome = settleRefund({
            log: log({ id: 300, type: 6, quota: 300_000, other: JSON.stringify({ task_id: 'task_1' }) }),
            consume,
            userId: 'u1',
            tenantId: TENANT,
            alreadyRefunded: new Prisma.Decimal(0),
        });
        expect(outcome.kind).toBe('earning');
        if (outcome.kind !== 'earning') return;
        expect(outcome.row.kind).toBe('refund');
        expect(outcome.row.charged_quota).toBe(-300_000n);
        expect(outcome.row.retail_cny.toString()).toBe('-6');
        expect(outcome.row.wholesale_cny.toString()).toBe('-4.666667');
        expect(outcome.row.profit_cny.toString()).toBe('-1.333333');
    });

    it('caps partial refunds at the remaining charged quota and reverses only that share', () => {
        const outcome = settleRefund({
            log: log({ id: 301, type: 6, quota: 100_000, other: JSON.stringify({ task_id: 'task_1' }) }),
            consume,
            userId: 'u1',
            tenantId: TENANT,
            alreadyRefunded: new Prisma.Decimal(250_000),
        });
        expect(outcome.kind === 'earning' && outcome.row.profit_cny.toDecimalPlaces(6).toString()).toBe(
            new Prisma.Decimal(1.333333).mul(50_000).div(300_000).toDecimalPlaces(6).negated().toString(),
        );
        expect(
            settleRefund({
                log: log({ id: 302, type: 6, quota: 100_000, other: JSON.stringify({ task_id: 'task_1' }) }),
                consume,
                userId: 'u1',
                tenantId: TENANT,
                alreadyRefunded: new Prisma.Decimal(300_000),
            }),
        ).toEqual({ kind: 'skip', reason: 'refund_exceeds' });
    });

    it('skips refunds without a task id', () => {
        expect(
            settleRefund({
                log: log({ id: 303, type: 6, quota: 1000, other: '{}' }),
                consume,
                userId: 'u1',
                tenantId: TENANT,
                alreadyRefunded: new Prisma.Decimal(0),
            }),
        ).toEqual({ kind: 'skip', reason: 'refund_unlinked' });
    });
});

describe('runPartnerEarning', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCursorUpsert.mockResolvedValue({ id: 1, partner_last_log_id: 100 });
        mockCursorUpdateMany.mockResolvedValue({ count: 1 });
        mockRetailHistoryFindMany.mockResolvedValue(retailHistory);
        mockHistoryFindMany.mockResolvedValue(wholesaleHistory);
        mockUserFindMany.mockResolvedValue([{ id: 'u1', tenant_id: TENANT, newapi_username: 'c-partner' }]);
        mockEarningCreateMany.mockResolvedValue({ count: 1 });
        mockEarningFindFirst.mockResolvedValue(null);
        mockEarningAggregate.mockResolvedValue({ _sum: { charged_quota: null } });
        mockWalletUpsert.mockResolvedValue({});
        mockQueryLogs.mockImplementation(async (args: { username?: string; type?: number }) => {
            if (!args.username) return { items: [{ id: 310 }], total: 1 };
            if (args.type === 6) {
                return { items: [log({ id: 300, type: 6, quota: 100_000, other: JSON.stringify({ task_id: 'task_1' }) })], total: 1 };
            }
            return {
                items: [
                    log({ id: 205, other: JSON.stringify({ user_group_ratio: 0.09, task_id: 'task_1' }) }),
                    log({ id: 150, other: JSON.stringify({ user_group_ratio: -1 }) }),
                    log({ id: 90 }),
                ],
                total: 3,
            };
        });
    });

    it('only moves the cursor on the first run', async () => {
        mockCursorUpsert.mockResolvedValue({ id: 1, partner_last_log_id: 0 });
        const result = await runPartnerEarning();
        expect(result.cursorAfter).toBe(310);
        expect(mockEarningCreateMany).not.toHaveBeenCalled();
    });

    it('settles new consume and refund logs, credits the wallet and advances the cursor together', async () => {
        const result = await runPartnerEarning();
        expect(result).toMatchObject({
            cursorBefore: 100,
            cursorAfter: 310,
            earningsCreated: 2,
            skipped: { no_partner_ratio: 1 },
        });
        const rows = mockEarningCreateMany.mock.calls[0][0].data as Array<{ kind: string; newapi_log_id: number; profit_cny: Prisma.Decimal }>;
        expect(rows.map((row) => [row.kind, row.newapi_log_id])).toEqual([
            ['consume', 205],
            ['refund', 300],
        ]);
        const profit = rows.reduce((sum, row) => sum.plus(row.profit_cny), new Prisma.Decimal(0)).toDecimalPlaces(4);
        expect(mockWalletUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenant_id: TENANT },
                update: { balance_cny: { increment: profit }, total_earned_cny: { increment: profit } },
            }),
        );
        expect(mockCursorUpdateMany).toHaveBeenCalledWith({
            where: { id: 1, partner_last_log_id: 100 },
            data: { partner_last_log_id: 310 },
        });
    });

    it('fails the run when another instance already moved the cursor', async () => {
        mockCursorUpdateMany.mockResolvedValue({ count: 0 });
        await expect(runPartnerEarning()).rejects.toThrow('游标');
    });

    it('does nothing when no newer log exists', async () => {
        mockQueryLogs.mockResolvedValue({ items: [{ id: 100 }], total: 1 });
        const result = await runPartnerEarning();
        expect(result.cursorAfter).toBe(100);
        expect(mockCursorUpdateMany).not.toHaveBeenCalled();
    });
});
