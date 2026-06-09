import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const mockUserFindUnique = vi.fn();
const mockLedgerAggregate = vi.fn();
const mockGetQuotaWithCache = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findUnique: (...a: unknown[]) => mockUserFindUnique(...a) },
        ledgerEntry: { aggregate: (...a: unknown[]) => mockLedgerAggregate(...a) },
    },
}));
vi.mock('@/lib/newapi/quota-cache', () => ({ getQuotaWithCache: (...a: unknown[]) => mockGetQuotaWithCache(...a) }));

import { getCustomerBalance } from '@/lib/billing/customer-balance';
import { quotaToCny } from '@/lib/newapi/quota-units';

beforeEach(() => vi.clearAllMocks());

describe('getCustomerBalance — portal mode (¥ ledger is the truth)', () => {
    it('reads Account.balance_cny + Σ|charge|; NEVER reads the new-api quota/dumb-gate', async () => {
        mockUserFindUnique.mockResolvedValue({
            billing_mode: 'portal',
            account: { id: 'acc-1', balance_cny: new Prisma.Decimal('42.5') },
        });
        mockLedgerAggregate.mockResolvedValue({ _sum: { amount_cny: new Prisma.Decimal('-17.5') } }); // charges are negative
        const r = await getCustomerBalance('u1');
        expect(r).toEqual({ balanceCny: 42.5, spentCny: 17.5, source: 'portal', stale: false, quota: null });
        expect(mockGetQuotaWithCache).not.toHaveBeenCalled();
        expect(mockLedgerAggregate).toHaveBeenCalledWith(
            expect.objectContaining({ where: { account_id: 'acc-1', kind: 'charge' } }),
        );
    });

    it('portal user with no Account → ¥0 balance, ¥0 spent (no charge aggregate)', async () => {
        mockUserFindUnique.mockResolvedValue({ billing_mode: 'portal', account: null });
        const r = await getCustomerBalance('u1');
        expect(r).toMatchObject({ balanceCny: 0, spentCny: 0, source: 'portal', quota: null });
        expect(mockLedgerAggregate).not.toHaveBeenCalled();
        expect(mockGetQuotaWithCache).not.toHaveBeenCalled();
    });

    it('portal with no charges yet → spent ¥0 (aggregate sum null)', async () => {
        mockUserFindUnique.mockResolvedValue({
            billing_mode: 'portal',
            account: { id: 'acc-1', balance_cny: new Prisma.Decimal('100') },
        });
        mockLedgerAggregate.mockResolvedValue({ _sum: { amount_cny: null } });
        const r = await getCustomerBalance('u1');
        expect(r.balanceCny).toBe(100);
        expect(r.spentCny).toBe(0);
    });
});

describe('getCustomerBalance — newapi mode (default, unchanged)', () => {
    it('goes through getQuotaWithCache; balance/spent = quotaToCny; never reads Account', async () => {
        mockUserFindUnique.mockResolvedValue({ billing_mode: 'newapi', account: null });
        mockGetQuotaWithCache.mockResolvedValue({ remain_quota: 500_000, used_quota: 250_000, source: 'cache' });
        const r = await getCustomerBalance('u1');
        expect(mockGetQuotaWithCache).toHaveBeenCalledWith('u1');
        expect(r.balanceCny).toBe(quotaToCny(500_000)); // ¥7.2
        expect(r.spentCny).toBe(quotaToCny(250_000)); // ¥3.6
        expect(r.source).toBe('newapi');
        expect(r.stale).toBe(false);
        expect(r.quota).toEqual({ remain: 500_000, used: 250_000 });
        expect(mockLedgerAggregate).not.toHaveBeenCalled();
    });

    it('newapi fallback (new-api unreachable, stale cache) → stale=true', async () => {
        mockUserFindUnique.mockResolvedValue({ billing_mode: 'newapi', account: null });
        mockGetQuotaWithCache.mockResolvedValue({ remain_quota: 100, used_quota: 0, source: 'fallback' });
        const r = await getCustomerBalance('u1');
        expect(r.stale).toBe(true);
        expect(r.source).toBe('newapi');
    });

    it('user not found → newapi path → getQuotaWithCache throws → propagates (existing behavior)', async () => {
        mockUserFindUnique.mockResolvedValue(null);
        mockGetQuotaWithCache.mockRejectedValue(new Error('portal user u1 not found'));
        await expect(getCustomerBalance('u1')).rejects.toThrow();
    });
});
