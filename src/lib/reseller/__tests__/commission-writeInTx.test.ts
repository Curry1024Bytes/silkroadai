/**
 * PR-U1 — writeCommissionInTx behavioural tests via mock tx client.
 *
 * Covers:
 *   - rate snapshot (uses CURRENT tier's rate, not the after-update tier)
 *   - admin_review_required threshold (¥100,000 commission auto-hold)
 *   - tier-upgrade audit event written to AnalyticsEvent
 *   - suspended reseller returns no-op (no commission row)
 *   - hold_until = now + 14 days
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { writeCommissionInTx, HOLD_DURATION_MS, COMMISSION_AUTO_REVIEW_THRESHOLD_CNY } from '@/lib/reseller/commission';

// Build a stub `tx` PrismaClient surface that records calls and returns
// a controllable resellerFindUnique response per test.
type AnyArg = Record<string, unknown>;
function makeTx(opts: {
    reseller: { id: string; tier: string; cumulative_gmv: Prisma.Decimal | string; status: string } | null;
    /** Reseller.user_id returned by the SECOND findUnique call (used for tier-upgrade analytics path). */
    resellerOwner?: { user_id: string };
}) {
    const calls = {
        resellerFindUnique: vi.fn().mockResolvedValueOnce(opts.reseller),
        resellerCommissionCreate: vi.fn(async ({ data }: { data: AnyArg }) => ({
            id: 'commission-uuid',
            ...data,
        })),
        resellerUpdate: vi.fn().mockResolvedValue({}),
        analyticsEventCreate: vi.fn().mockResolvedValue({}),
        secondResellerFindUnique: vi.fn().mockResolvedValue(opts.resellerOwner ?? { user_id: 'owner-uuid' }),
    };
    // First call hits the main findUnique; second call (used in upgrade
    // audit path) hits the owner lookup. We chain via mockResolvedValueOnce
    // then fall back to the owner mock.
    calls.resellerFindUnique.mockImplementation(async (args: { select?: AnyArg }) => {
        if (args.select && 'user_id' in args.select) {
            return calls.secondResellerFindUnique();
        }
        return opts.reseller;
    });
    return {
        tx: {
            reseller: {
                findUnique: calls.resellerFindUnique,
                update: calls.resellerUpdate,
            },
            resellerCommission: {
                create: calls.resellerCommissionCreate,
            },
            analyticsEvent: {
                create: calls.analyticsEventCreate,
            },
        } as unknown as Prisma.TransactionClient,
        calls,
    };
}

const baseInput = {
    reseller_id: 'reseller-uuid',
    user_id: 'customer-uuid',
    recharge_log_id: 'rl-uuid',
    attributed_gmv_cny: 100, // ¥100 recharge
    now: new Date('2026-05-11T12:00:00.000Z'),
};

describe('writeCommissionInTx', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('uses CURRENT-tier rate (rate snapshot, no back-pay)', async () => {
        const { tx, calls } = makeTx({
            reseller: { id: 'reseller-uuid', tier: 'bronze', cumulative_gmv: '9999', status: 'active' },
        });
        const result = await writeCommissionInTx(tx, { ...baseInput, attributed_gmv_cny: 100 });
        // 9999 (bronze) + 100 → 10099 → silver. But rate should be CURRENT
        // (bronze=0.10), giving commission=10. Tier upgrade audit fires.
        expect(result.commission_rate).toBe(0.1);
        expect(Number(result.commission_amount_cny)).toBeCloseTo(10);
        expect(result.tier_upgraded).toEqual({ from: 'bronze', to: 'silver' });
        // Reseller.update wrote new tier=silver + new gmv.
        const updateCall = calls.resellerUpdate.mock.calls[0][0];
        expect(updateCall.data.tier).toBe('silver');
    });

    it('flags admin_review_required when commission > ¥100,000', async () => {
        // 800k recharge × 0.15 silver = ¥120k commission → auto-hold.
        const { tx } = makeTx({
            reseller: { id: 'reseller-uuid', tier: 'silver', cumulative_gmv: '50000', status: 'active' },
        });
        const r = await writeCommissionInTx(tx, {
            ...baseInput,
            attributed_gmv_cny: 800_000,
        });
        expect(r.admin_review_required).toBe(true);
        expect(Number(r.commission_amount_cny)).toBeGreaterThan(COMMISSION_AUTO_REVIEW_THRESHOLD_CNY);
    });

    it('writes tier-upgrade audit AnalyticsEvent on upgrade', async () => {
        const { tx, calls } = makeTx({
            reseller: { id: 'reseller-uuid', tier: 'silver', cumulative_gmv: '99500', status: 'active' },
            resellerOwner: { user_id: 'owner-uuid' },
        });
        await writeCommissionInTx(tx, { ...baseInput, attributed_gmv_cny: 1_000 });
        expect(calls.analyticsEventCreate).toHaveBeenCalledTimes(1);
        const ev = calls.analyticsEventCreate.mock.calls[0][0];
        expect(ev.data.event_type).toBe('reseller_tier_upgraded');
        expect(ev.data.user_id).toBe('owner-uuid');
        expect(ev.data.properties.from_tier).toBe('silver');
        expect(ev.data.properties.to_tier).toBe('gold');
    });

    it('does NOT write audit when tier unchanged', async () => {
        const { tx, calls } = makeTx({
            reseller: { id: 'reseller-uuid', tier: 'bronze', cumulative_gmv: '0', status: 'active' },
        });
        await writeCommissionInTx(tx, { ...baseInput, attributed_gmv_cny: 100 });
        // 0 + 100 → still bronze; no upgrade.
        expect(calls.analyticsEventCreate).not.toHaveBeenCalled();
    });

    it('hold_until = now + 14 days', async () => {
        const { tx, calls } = makeTx({
            reseller: { id: 'reseller-uuid', tier: 'bronze', cumulative_gmv: '0', status: 'active' },
        });
        await writeCommissionInTx(tx, { ...baseInput });
        const createCall = calls.resellerCommissionCreate.mock.calls[0][0];
        const hold = createCall.data.hold_until as Date;
        const expectedTs = baseInput.now.getTime() + HOLD_DURATION_MS;
        expect(hold.getTime()).toBe(expectedTs);
    });

    it('suspended reseller → no-op (no commission row, returns zero)', async () => {
        const { tx, calls } = makeTx({
            reseller: { id: 'reseller-uuid', tier: 'bronze', cumulative_gmv: '0', status: 'suspended' },
        });
        const r = await writeCommissionInTx(tx, { ...baseInput });
        expect(r.commission_id).toBe('');
        expect(Number(r.commission_amount_cny)).toBe(0);
        expect(calls.resellerCommissionCreate).not.toHaveBeenCalled();
        expect(calls.resellerUpdate).not.toHaveBeenCalled();
    });

    it('throws when reseller not found (defensive)', async () => {
        const { tx } = makeTx({ reseller: null });
        await expect(writeCommissionInTx(tx, { ...baseInput })).rejects.toThrow(/not found/);
    });
});
