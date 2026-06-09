import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const mockUserFindUnique = vi.fn();
const mockUserUpdateMany = vi.fn();
const mockTransaction = vi.fn();
const mockGetUser = vi.fn();
const mockAddQuota = vi.fn();
const mockApplyLedgerEntryInTx = vi.fn();
const mockSyncNewapiGate = vi.fn();

const txProxy = { user: { updateMany: (...a: unknown[]) => mockUserUpdateMany(...a) } };

vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findUnique: (...a: unknown[]) => mockUserFindUnique(...a) },
        $transaction: (...a: unknown[]) => mockTransaction(...a),
    },
}));
vi.mock('@/lib/newapi/client', () => ({
    getUser: (...a: unknown[]) => mockGetUser(...a),
    addQuota: (...a: unknown[]) => mockAddQuota(...a),
}));
vi.mock('@/lib/billing/ledger', () => ({ applyLedgerEntryInTx: (...a: unknown[]) => mockApplyLedgerEntryInTx(...a) }));
vi.mock('@/lib/billing/newapi-gate', () => ({ syncNewapiGate: (...a: unknown[]) => mockSyncNewapiGate(...a) }));

import { migrateUserToPortal, rollbackUserToNewapi } from '@/lib/billing/billing-migration';
import { quotaToCny, cnyToQuota } from '@/lib/newapi/quota-units';

const D = (n: number | string) => new Prisma.Decimal(n);

beforeEach(() => {
    vi.clearAllMocks();
    // interactive $transaction: run the callback with the tx proxy; propagate throws (rollback).
    mockTransaction.mockImplementation(async (arg: unknown) => {
        if (typeof arg === 'function') return await (arg as (tx: typeof txProxy) => Promise<unknown>)(txProxy);
        return Promise.all(arg as unknown[]);
    });
    mockUserUpdateMany.mockResolvedValue({ count: 1 }); // CAS wins by default
    mockApplyLedgerEntryInTx.mockResolvedValue({ entryId: 'le-1', balance_after: D(0) });
    mockSyncNewapiGate.mockResolvedValue(undefined);
    mockAddQuota.mockResolvedValue(undefined);
});

describe('migrateUserToPortal — newapi → portal', () => {
    it('snapshots quota, atomic CAS flip + seed ledger, opens the gate', async () => {
        mockUserFindUnique.mockResolvedValue({ billing_mode: 'newapi', newapi_user_id: 42, tenant_id: 't1' });
        mockGetUser.mockResolvedValue({ id: 42, quota: 500_000 }); // X = 500_000 → ¥7.2

        const r = await migrateUserToPortal('u1', 'admin-1');

        expect(r).toMatchObject({ action: 'to_portal', flipped: true, backupQuota: 500_000, newBillingMode: 'portal' });
        expect(r.amountCny).toBeCloseTo(quotaToCny(500_000), 5); // ¥7.2
        // CAS flip newapi → portal (atomic with seed)
        expect(mockUserUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'u1', billing_mode: 'newapi' }, data: { billing_mode: 'portal' } }),
        );
        // seed ledger: migration entry +amountCny, ref=migrate-in, note carries the backup quota
        expect(mockApplyLedgerEntryInTx).toHaveBeenCalledTimes(1);
        const seed = mockApplyLedgerEntryInTx.mock.calls[0];
        expect(seed[1]).toBe('u1'); // (tx, userId, input)
        expect(seed[2].kind).toBe('migration');
        expect(seed[2].amount_cny).toBeCloseTo(7.2, 5);
        expect(seed[2].ref).toMatch(/^migrate-in:u1:/);
        expect(seed[2].note).toContain('backup raw quota=500000');
        // gate opened (best-effort)
        expect(mockSyncNewapiGate).toHaveBeenCalledWith('u1');
    });

    it('already portal → CAS no-op: no snapshot, no tx, no double seed', async () => {
        mockUserFindUnique.mockResolvedValue({ billing_mode: 'portal', newapi_user_id: 42, tenant_id: 't1' });
        const r = await migrateUserToPortal('u1');
        expect(r).toMatchObject({ flipped: false, newBillingMode: 'portal' });
        expect(mockGetUser).not.toHaveBeenCalled();
        expect(mockApplyLedgerEntryInTx).not.toHaveBeenCalled();
    });

    it('CAS race (concurrent flip won) → tx rolls back, flipped=false, seed NOT applied', async () => {
        mockUserFindUnique.mockResolvedValue({ billing_mode: 'newapi', newapi_user_id: 42, tenant_id: 't1' });
        mockGetUser.mockResolvedValue({ id: 42, quota: 500_000 });
        mockUserUpdateMany.mockResolvedValue({ count: 0 }); // CAS lost
        const r = await migrateUserToPortal('u1');
        expect(r.flipped).toBe(false);
        expect(mockApplyLedgerEntryInTx).not.toHaveBeenCalled();
    });

    it('no newapi_user_id → throws (cannot migrate)', async () => {
        mockUserFindUnique.mockResolvedValue({ billing_mode: 'newapi', newapi_user_id: null, tenant_id: 't1' });
        await expect(migrateUserToPortal('u1')).rejects.toThrow();
    });

    it('syncNewapiGate failure is non-fatal — flip+seed already committed', async () => {
        mockUserFindUnique.mockResolvedValue({ billing_mode: 'newapi', newapi_user_id: 42, tenant_id: 't1' });
        mockGetUser.mockResolvedValue({ id: 42, quota: 500_000 });
        mockSyncNewapiGate.mockRejectedValue(new Error('BILLING_SOURCE off / new-api down'));
        const r = await migrateUserToPortal('u1');
        expect(r.flipped).toBe(true);
    });
});

describe('rollbackUserToNewapi — portal → newapi', () => {
    it('returns CURRENT balance to quota (override), atomic flip + zero-out ledger', async () => {
        mockUserFindUnique.mockResolvedValue({
            billing_mode: 'portal',
            newapi_user_id: 42,
            tenant_id: 't1',
            account: { balance_cny: D('14.4') }, // ¥14.4 → 1,000,000 quota
        });

        const r = await rollbackUserToNewapi('u1', 'admin-1');

        expect(r).toMatchObject({ action: 'to_newapi', flipped: true, newBillingMode: 'newapi' });
        expect(r.amountCny).toBeCloseTo(14.4, 5);
        expect(r.backupQuota).toBe(cnyToQuota(14.4)); // 1,000,000
        // return money FIRST (override = absolute set → idempotent)
        expect(mockAddQuota).toHaveBeenCalledWith({ userId: 42, quotaDelta: cnyToQuota(14.4), mode: 'override' });
        // CAS flip portal → newapi + zero-out ledger entry (−Y)
        expect(mockUserUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'u1', billing_mode: 'portal' }, data: { billing_mode: 'newapi' } }),
        );
        const zero = mockApplyLedgerEntryInTx.mock.calls[0];
        expect(zero[2].kind).toBe('migration');
        expect(zero[2].amount_cny).toBeCloseTo(-14.4, 5);
        expect(zero[2].ref).toMatch(/^migrate-out:u1:/);
    });

    it('already newapi → CAS no-op: no addQuota, no tx', async () => {
        mockUserFindUnique.mockResolvedValue({
            billing_mode: 'newapi',
            newapi_user_id: 42,
            tenant_id: 't1',
            account: null,
        });
        const r = await rollbackUserToNewapi('u1');
        expect(r.flipped).toBe(false);
        expect(mockAddQuota).not.toHaveBeenCalled();
        expect(mockApplyLedgerEntryInTx).not.toHaveBeenCalled();
    });

    it('¥0 balance → addQuota override 0 + flip, but NO ledger entry', async () => {
        mockUserFindUnique.mockResolvedValue({
            billing_mode: 'portal',
            newapi_user_id: 42,
            tenant_id: 't1',
            account: { balance_cny: D('0') },
        });
        const r = await rollbackUserToNewapi('u1');
        expect(r.flipped).toBe(true);
        expect(mockAddQuota).toHaveBeenCalledWith({ userId: 42, quotaDelta: 0, mode: 'override' });
        expect(mockApplyLedgerEntryInTx).not.toHaveBeenCalled();
    });

    it('CAS race (already rolled back) → flipped=false, no double accounting', async () => {
        mockUserFindUnique.mockResolvedValue({
            billing_mode: 'portal',
            newapi_user_id: 42,
            tenant_id: 't1',
            account: { balance_cny: D('5') },
        });
        mockUserUpdateMany.mockResolvedValue({ count: 0 });
        const r = await rollbackUserToNewapi('u1');
        expect(r.flipped).toBe(false);
        expect(mockApplyLedgerEntryInTx).not.toHaveBeenCalled();
    });
});

describe('cnyToQuota ∘ quotaToCny — net-neutral round-trip', () => {
    it('round-trips integer quota within rounding', () => {
        for (const q of [500_000, 1_000_000, 123_456_789]) {
            expect(cnyToQuota(quotaToCny(q))).toBeCloseTo(q, 0);
        }
    });
});
