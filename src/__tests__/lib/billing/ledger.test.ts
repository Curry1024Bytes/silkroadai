import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

// ── prisma mock: tx proxy (interactive $transaction) + outer prisma for the
//    unique-violation idempotency fetch path. Mirrors execute-recharge.test.ts. ──
const mockTransaction = vi.fn();
const mockAcctFindUnique = vi.fn();
const mockAcctCreate = vi.fn();
const mockAcctUpdateMany = vi.fn();
const mockLedgerFindUnique = vi.fn();
const mockLedgerCreate = vi.fn();
const mockUserFindUnique = vi.fn();
const mockOuterLedgerFindUnique = vi.fn();

const txProxy = {
    account: {
        findUnique: (...a: unknown[]) => mockAcctFindUnique(...a),
        create: (...a: unknown[]) => mockAcctCreate(...a),
        updateMany: (...a: unknown[]) => mockAcctUpdateMany(...a),
    },
    ledgerEntry: {
        findUnique: (...a: unknown[]) => mockLedgerFindUnique(...a),
        create: (...a: unknown[]) => mockLedgerCreate(...a),
    },
    user: { findUnique: (...a: unknown[]) => mockUserFindUnique(...a) },
};

vi.mock('@/lib/db', () => ({
    prisma: {
        $transaction: (...a: unknown[]) => mockTransaction(...a),
        ledgerEntry: { findUnique: (...a: unknown[]) => mockOuterLedgerFindUnique(...a) },
    },
}));

import { applyLedgerEntry, LedgerConflictError } from '@/lib/billing/ledger';

const D = (n: number | string) => new Prisma.Decimal(n);
const acct = (balance: number | string, version: number, tenant: string | null = null) => ({
    id: 'acc-1',
    user_id: 'u-1',
    tenant_id: tenant,
    balance_cny: D(balance),
    version,
});
const p2002 = (target: string[]) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target },
    });

beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation(async (arg: unknown) => {
        if (typeof arg === 'function') return await (arg as (tx: typeof txProxy) => Promise<unknown>)(txProxy);
        return Promise.all(arg as unknown[]);
    });
    mockUserFindUnique.mockResolvedValue({ tenant_id: null });
    mockAcctUpdateMany.mockResolvedValue({ count: 1 });
    mockLedgerCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'le-new', ...data }),
    );
});

describe('applyLedgerEntry — atomic balance mutation', () => {
    it('credit (+): balance_after = balance + amount, deduped false', async () => {
        mockAcctFindUnique.mockResolvedValue(acct(0, 0));
        const r = await applyLedgerEntry('u-1', { kind: 'adjustment', amount_cny: 100, note: 'gift' });
        expect(r.deduped).toBe(false);
        expect(r.balance_after.toString()).toBe('100');
        // ledger row carries the signed amount + post-balance snapshot
        expect(mockLedgerCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ kind: 'adjustment', note: 'gift', account_id: 'acc-1' }),
            }),
        );
        const created = mockLedgerCreate.mock.calls[0][0].data;
        expect(created.amount_cny.toString()).toBe('100');
        expect(created.balance_after.toString()).toBe('100');
        // optimistic-lock update fired with the read version
        expect(mockAcctUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'acc-1', version: 0 }, data: expect.anything() }),
        );
    });

    it('debit (−): balance 100 − 30 = 70', async () => {
        mockAcctFindUnique.mockResolvedValue(acct(100, 3));
        const r = await applyLedgerEntry('u-1', { kind: 'charge', amount_cny: -30 });
        expect(r.balance_after.toString()).toBe('70');
        expect(mockAcctUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'acc-1', version: 3 } }),
        );
    });

    it('preserves sub-cent precision (Decimal(20,8), not float)', async () => {
        mockAcctFindUnique.mockResolvedValue(acct('0.00001000', 0));
        const r = await applyLedgerEntry('u-1', { kind: 'charge', amount_cny: '-0.00000700' });
        expect(r.balance_after.toString()).toBe('0.000003');
    });

    it('get-or-create: no Account → creates one with tenant from user', async () => {
        mockAcctFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue({ tenant_id: 'tenant-7' });
        mockAcctCreate.mockResolvedValue(acct(0, 0, 'tenant-7'));
        const r = await applyLedgerEntry('u-1', { kind: 'adjustment', amount_cny: 50 });
        expect(mockAcctCreate).toHaveBeenCalledWith({ data: { user_id: 'u-1', tenant_id: 'tenant-7' } });
        expect(r.balance_after.toString()).toBe('50');
    });

    it('optimistic lock: version conflict (count=0) retries, lands on fresh balance', async () => {
        // attempt 1 reads v0/balance0 → updateMany count 0 → retry;
        // attempt 2 reads v1/balance100 (someone else credited) → count 1 → +100 over that.
        mockAcctFindUnique.mockResolvedValueOnce(acct(0, 0)).mockResolvedValueOnce(acct(100, 1));
        mockAcctUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
        const r = await applyLedgerEntry('u-1', { kind: 'adjustment', amount_cny: 100 });
        expect(r.balance_after.toString()).toBe('200'); // 100 (fresh) + 100
        expect(mockTransaction).toHaveBeenCalledTimes(2);
    });

    it('conflict beyond retry budget → LedgerConflictError', async () => {
        mockAcctFindUnique.mockResolvedValue(acct(0, 0));
        mockAcctUpdateMany.mockResolvedValue({ count: 0 }); // never wins
        await expect(applyLedgerEntry('u-1', { kind: 'adjustment', amount_cny: 1 })).rejects.toBeInstanceOf(
            LedgerConflictError,
        );
    });
});

describe('applyLedgerEntry — idempotency', () => {
    it('adjustment (ref=null) never dedupes — always inserts (multiple adjustments allowed)', async () => {
        mockAcctFindUnique.mockResolvedValue(acct(0, 0));
        await applyLedgerEntry('u-1', { kind: 'adjustment', amount_cny: 10 });
        expect(mockLedgerFindUnique).not.toHaveBeenCalled(); // no (kind,ref) lookup for adjustment
        expect(mockLedgerCreate).toHaveBeenCalledTimes(1);
    });

    it('charge + ref: existing (kind,ref) → idempotent return, no second insert', async () => {
        mockAcctFindUnique.mockResolvedValue(acct(0, 0));
        mockLedgerFindUnique.mockResolvedValue({ id: 'le-old', amount_cny: D(5), balance_after: D(5) });
        const r = await applyLedgerEntry('u-1', { kind: 'charge', amount_cny: -5, ref: 'usage-1' });
        expect(r.deduped).toBe(true);
        expect(r.entryId).toBe('le-old');
        expect(mockLedgerCreate).not.toHaveBeenCalled();
        expect(mockAcctUpdateMany).not.toHaveBeenCalled();
    });

    it('charge + ref: concurrent insert (P2002 on kind/ref) → catch → fetch existing → deduped', async () => {
        mockAcctFindUnique.mockResolvedValue(acct(0, 0));
        mockLedgerFindUnique.mockResolvedValue(null); // fast path miss (race)
        mockLedgerCreate.mockRejectedValue(p2002(['kind', 'ref'])); // the other tx won the unique
        mockOuterLedgerFindUnique.mockResolvedValue({
            id: 'le-x',
            account_id: 'acc-1',
            amount_cny: D(-5),
            balance_after: D(-5),
        });
        const r = await applyLedgerEntry('u-1', { kind: 'charge', amount_cny: -5, ref: 'usage-2' });
        expect(r.deduped).toBe(true);
        expect(r.entryId).toBe('le-x');
    });
});
