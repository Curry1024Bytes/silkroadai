import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { db, ledger, getUser, addQuota } = vi.hoisted(() => ({
    db: {
        seedanceVideoTask: { findUnique: vi.fn(), updateMany: vi.fn() },
        user: { findUnique: vi.fn() },
        enterpriseModelDiscount: { findUnique: vi.fn() },
        enterpriseGlobalDiscount: { findUnique: vi.fn() },
        enterpriseUpstreamKey: { findUnique: vi.fn() },
    },
    ledger: vi.fn(),
    getUser: vi.fn(),
    addQuota: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/billing/ledger', () => ({ applyLedgerEntry: ledger }));
vi.mock('@/lib/billing/newapi-gate', () => ({ syncNewapiGate: vi.fn() }));
vi.mock('@/lib/newapi/client', () => ({ getUser, addQuota }));

import { chargeSeedanceVideoTask } from '@/lib/seedance/cn-billing';
import { chargeEnterpriseVideoTask } from '../billing';

beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T06:00:00Z'));
    db.enterpriseModelDiscount.findUnique.mockResolvedValue(null);
    db.enterpriseGlobalDiscount.findUnique.mockResolvedValue(null);
    db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ discount: '0.9' });
    db.user.findUnique.mockResolvedValue({ id: 'u1', tenant_id: null, billing_mode: 'portal' });
});
afterEach(() => vi.useRealTimers());

function taskState(model: string, hasVideo: boolean) {
    const task = {
        id: 'task-25',
        user_id: 'u1',
        tenant_id: null,
        model,
        resolution: '1080p',
        has_video: hasVideo,
        tokens: null as bigint | null,
        billed: false,
        cost_cny: null as number | null,
        billed_at: null as Date | null,
    };
    db.seedanceVideoTask.findUnique.mockImplementation(async () => ({ ...task }));
    db.seedanceVideoTask.updateMany.mockImplementation(
        async ({
            where,
            data,
        }: {
            where: { billed: boolean; billed_at?: Date; cost_cny?: number };
            data: Partial<typeof task>;
        }) => {
            if (task.billed !== where.billed) return { count: 0 };
            if (where.billed_at && task.billed_at?.getTime() !== where.billed_at.getTime()) return { count: 0 };
            if (where.cost_cny != null && task.cost_cny !== where.cost_cny) return { count: 0 };
            Object.assign(task, data);
            if (data.billed === true && data.billed_at) {
                task.billed_at = data.billed_at;
                task.cost_cny = data.cost_cny ?? null;
            }
            return { count: 1 };
        },
    );
    return task;
}

describe('Seedance 2.5 1080p repricing at delayed settlement', () => {
    it.each([
        ['retail', 'seedance2.5-1080p', false, 65.45],
        ['retail', 'seedance2.5-1080p-ref', true, 39.1],
        ['enterprise', 'seedance-2-5', false, 69.3],
        ['enterprise', 'seedance-2-5', true, 41.4],
        ['enterprise', 'doubao-seedance-2.5', false, 69.3],
        ['enterprise', 'doubao-seedance-2.5', true, 41.4],
    ] as const)('%s %s hasVideo=%s settles once for ¥%s', async (kind, model, hasVideo, expected) => {
        const charge = kind === 'retail' ? chargeSeedanceVideoTask : chargeEnterpriseVideoTask;
        const task = taskState(model, hasVideo);
        expect(await charge(task.id)).toEqual({ outcome: 'skipped' });
        expect(db.seedanceVideoTask.updateMany).not.toHaveBeenCalled();
        expect(ledger).not.toHaveBeenCalled();

        // Usage arrives later. Hold the ledger call open while a second poll tries to settle.
        vi.advanceTimersByTime(120_000);
        task.tokens = BigInt(1_000_000);
        let release = () => {};
        const ledgerPending = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered = () => {};
        const ledgerEntered = new Promise<void>((resolve) => {
            entered = resolve;
        });
        ledger.mockImplementation(async () => {
            entered();
            await ledgerPending;
        });
        const first = charge(task.id);
        await ledgerEntered;
        expect(await charge(task.id)).toEqual({ outcome: 'already_billed' });
        release();
        expect(await first).toEqual({ outcome: 'charged', costCny: expected });

        vi.advanceTimersByTime(3_600_000);
        expect(await charge(task.id)).toEqual({ outcome: 'already_billed' });
        expect(ledger).toHaveBeenCalledTimes(1);
        expect(ledger).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({
                amount_cny: -expected,
                kind: 'charge',
                ref: task.id,
            }),
        );
        expect(db.seedanceVideoTask.updateMany).toHaveBeenCalledTimes(1);
        expect(db.seedanceVideoTask.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ cost_cny: expected, billed: true }),
            }),
        );
        expect(getUser).not.toHaveBeenCalled();
        expect(addQuota).not.toHaveBeenCalled();
    });

    it('a delayed ledger failure releases the claim for a later retry', async () => {
        const task = taskState('seedance-2-5', false);
        task.tokens = BigInt(1_000_000);
        ledger.mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 30_000));
            throw new Error('ledger acknowledgement lost');
        });
        const first = chargeEnterpriseVideoTask(task.id);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await first).toEqual({ outcome: 'deduct_failed', costCny: 69.3 });
        expect(task.billed).toBe(false);
        // Repricing between attempts must not change the amount already claimed for this task.
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ discount: '0.5' });
        ledger.mockResolvedValue({ balance_after: { toFixed: () => '0.00' } });
        expect(await chargeEnterpriseVideoTask(task.id)).toEqual({ outcome: 'charged', costCny: 69.3 });
        expect(ledger).toHaveBeenCalledTimes(2);
        expect(ledger).toHaveBeenNthCalledWith(
            2,
            'u1',
            expect.objectContaining({ amount_cny: -69.3, kind: 'charge', ref: task.id }),
        );
        expect(db.seedanceVideoTask.updateMany).toHaveBeenCalledTimes(3);
    });
});
