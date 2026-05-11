/**
 * PR-U1 — reseller commission scheduler unit tests.
 *
 * Covers:
 *   - hold-release: pending → confirmed when hold_until < now AND
 *     admin_review_required = false
 *   - admin_review_required=true rows skipped
 *   - monthly settlement auto-create only fires on day 1 hour 0 UTC
 *   - idempotent settlement creation
 *   - utcPeriodMonth + previousUtcPeriodMonth helpers
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUpdateMany = vi.fn();
const mockGroupBy = vi.fn();
const mockSettlementFindUnique = vi.fn();
const mockSettlementCreate = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        resellerCommission: {
            updateMany: (...args: unknown[]) => mockUpdateMany(...args),
            groupBy: (...args: unknown[]) => mockGroupBy(...args),
        },
        resellerSettlement: {
            findUnique: (...args: unknown[]) => mockSettlementFindUnique(...args),
            create: (...args: unknown[]) => mockSettlementCreate(...args),
        },
    },
}));
vi.mock('@sentry/nextjs', () => ({
    captureException: vi.fn(),
}));

import { runResellerSchedulerOnce, utcPeriodMonth, previousUtcPeriodMonth } from '@/lib/scheduler/reseller-commission';

describe('utcPeriodMonth', () => {
    it.each([
        [new Date(Date.UTC(2026, 0, 15, 12, 0, 0)), '2026-01'],
        [new Date(Date.UTC(2026, 11, 1, 0, 0, 0)), '2026-12'],
        [new Date(Date.UTC(2026, 6, 31, 23, 59, 59)), '2026-07'],
    ])('%s → %s', (d, expected) => {
        expect(utcPeriodMonth(d)).toBe(expected);
    });
});

describe('previousUtcPeriodMonth', () => {
    it.each([
        [new Date(Date.UTC(2026, 5, 15)), '2026-05'], // June → May
        [new Date(Date.UTC(2026, 0, 1)), '2025-12'], // Jan 1 → Dec prev yr
    ])('%s → %s', (d, expected) => {
        expect(previousUtcPeriodMonth(d)).toBe(expected);
    });
});

describe('runResellerSchedulerOnce — hold-release', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockUpdateMany.mockResolvedValue({ count: 0 });
        mockGroupBy.mockResolvedValue([]);
    });

    it('updates pending+adminreview=false+hold_until<now → confirmed', async () => {
        mockUpdateMany.mockResolvedValueOnce({ count: 4 });
        const result = await runResellerSchedulerOnce(new Date('2026-05-15T12:00:00Z')); // not 1st
        expect(result.hold_released).toBe(4);
        const call = mockUpdateMany.mock.calls[0][0];
        expect(call.where.status).toBe('pending');
        expect(call.where.admin_review_required).toBe(false);
        expect(call.where.hold_until.lt).toBeInstanceOf(Date);
        expect(call.data.status).toBe('confirmed');
    });

    it('no candidates → count=0, no error', async () => {
        mockUpdateMany.mockResolvedValueOnce({ count: 0 });
        const r = await runResellerSchedulerOnce(new Date('2026-05-15T12:00:00Z'));
        expect(r.hold_released).toBe(0);
        expect(r.errors).toBe(0);
    });

    it('hold-release error → captured in result.errors', async () => {
        mockUpdateMany.mockRejectedValueOnce(new Error('DB blip'));
        const r = await runResellerSchedulerOnce(new Date('2026-05-15T12:00:00Z'));
        expect(r.errors).toBeGreaterThanOrEqual(1);
    });
});

describe('runResellerSchedulerOnce — monthly settlement auto-create', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockUpdateMany.mockResolvedValue({ count: 0 });
    });

    it('only runs on day 1 hour 0 UTC', async () => {
        // mid-month → don't even call groupBy
        await runResellerSchedulerOnce(new Date('2026-05-15T12:00:00Z'));
        expect(mockGroupBy).not.toHaveBeenCalled();

        // day 1 hour 0 UTC → call groupBy
        mockGroupBy.mockResolvedValueOnce([]);
        await runResellerSchedulerOnce(new Date('2026-06-01T00:30:00Z'));
        expect(mockGroupBy).toHaveBeenCalledOnce();
    });

    it('creates one ResellerSettlement per reseller with confirmed commissions', async () => {
        mockGroupBy.mockResolvedValueOnce([
            { reseller_id: 'r1', _sum: { commission_amount: '500.00' }, _count: { _all: 5 } },
            { reseller_id: 'r2', _sum: { commission_amount: '2000.00' }, _count: { _all: 12 } },
        ]);
        mockSettlementFindUnique.mockResolvedValue(null);
        mockSettlementCreate.mockResolvedValue({});

        const r = await runResellerSchedulerOnce(new Date('2026-06-01T00:30:00Z'));
        expect(r.settlements_created).toBe(2);
        expect(mockSettlementCreate).toHaveBeenCalledTimes(2);
        const firstCreate = mockSettlementCreate.mock.calls[0][0];
        expect(firstCreate.data.period_month).toBe('2026-05'); // previous month
    });

    it('idempotent: existing settlement row → skip + counter', async () => {
        mockGroupBy.mockResolvedValueOnce([
            { reseller_id: 'r1', _sum: { commission_amount: '500.00' }, _count: { _all: 5 } },
        ]);
        mockSettlementFindUnique.mockResolvedValue({ id: 'existing-settlement-uuid' });

        const r = await runResellerSchedulerOnce(new Date('2026-06-01T00:30:00Z'));
        expect(r.settlements_created).toBe(0);
        expect(r.settlements_skipped_idempotent).toBe(1);
        expect(mockSettlementCreate).not.toHaveBeenCalled();
    });
});
