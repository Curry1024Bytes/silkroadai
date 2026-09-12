import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findJob: vi.fn(),
    lock: vi.fn(),
    transaction: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        pricingPublishWrite: { findMany: mock.findMany },
        $transaction: mock.transaction,
    },
}));
vi.mock('@/lib/admin/pricing-publish-lock', async () => ({
    ...(await vi.importActual<typeof import('@/lib/admin/pricing-publish-lock')>('@/lib/admin/pricing-publish-lock')),
    lockPricingPublisher: mock.lock,
}));
import {
    beginPricingWrite,
    acknowledgePricingWrite,
    readUncertainPricingWrites,
    resolvePricingWriteManually,
} from '@/lib/admin/pricing-publish-journal';

const JOB = '00000000-0000-4000-8000-000000000001';
const WRITE = '00000000-0000-4000-8000-000000000002';
const HASH = 'a'.repeat(64);
const tx = {
    pricingPublishWrite: { create: mock.create, update: mock.update, findUnique: mock.findUnique },
    pricingPublishJob: { findUnique: mock.findJob },
};

beforeEach(() => {
    vi.resetAllMocks();
    mock.transaction.mockImplementation(async (work: (value: typeof tx) => unknown) => work(tx));
    mock.create.mockResolvedValue({ id: WRITE });
    mock.update.mockResolvedValue({ id: WRITE, job_id: JOB, status: 'resolved' });
    mock.findMany.mockResolvedValue([{ id: WRITE, key: 'ModelRatio', request_hash: HASH, created_at: new Date() }]);
    mock.findUnique.mockResolvedValue({ id: WRITE, job_id: JOB, status: 'in_flight' });
    mock.findJob.mockResolvedValue({ status: 'conflict' });
    mock.lock.mockResolvedValue({ active_job_id: JOB });
});

describe('pricing publication independent write journal', () => {
    it('commits a bounded independent intent before returning its ID, retaining only the request hash', async () => {
        expect(await beginPricingWrite(JOB, 'ModelRatio', HASH)).toBe(WRITE);
        expect(mock.transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 10_000, maxWait: 5_000 });
        expect(mock.create).toHaveBeenCalledWith({
            data: { job_id: JOB, key: 'ModelRatio', request_hash: HASH, status: 'in_flight' },
            select: { id: true },
        });
        expect(mock.lock).not.toHaveBeenCalled();
        expect(mock.findJob).not.toHaveBeenCalled();
    });

    it('fails closed if the intent commit fails and never acknowledges it', async () => {
        mock.transaction.mockRejectedValueOnce(new Error('commit uncertain'));
        await expect(beginPricingWrite(JOB, 'ModelPrice', HASH)).rejects.toThrow('commit uncertain');
        expect(mock.update).not.toHaveBeenCalled();
    });

    it('acknowledges separately only when explicitly called, without acquiring the publisher lock', async () => {
        await acknowledgePricingWrite(WRITE);
        expect(mock.update).toHaveBeenCalledWith({
            where: { id: WRITE },
            data: {
                status: 'acknowledged',
                acknowledged_at: expect.any(Date),
            },
        });
        expect(mock.lock).not.toHaveBeenCalled();
    });

    it('reads unresolved attempts outside the outer Serializable snapshot', async () => {
        expect(await readUncertainPricingWrites(JOB)).toHaveLength(1);
        expect(mock.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { job_id: JOB, status: 'in_flight' } }),
        );
        expect(mock.transaction).not.toHaveBeenCalled();
    });

    it('requires an explicit upstream-termination attestation and keeps the active job untouched', async () => {
        await resolvePricingWriteManually({
            write_id: WRITE,
            operator: 'operator-a',
            evidence: 'INC-42: confirmed the old management request ended on the intended instance.',
            upstream_requests_ended: true,
        });
        expect(mock.lock).toHaveBeenCalledWith(tx);
        expect(mock.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    status: 'resolved',
                    resolved_at: expect.any(Date),
                    resolved_by: 'operator-a',
                    resolution_note: 'INC-42: confirmed the old management request ended on the intended instance.',
                },
            }),
        );
        expect(mock.lock.mock.invocationCallOrder[0]).toBeLessThan(mock.update.mock.invocationCallOrder[0]);
    });

    it('rejects a missing attestation before any database access', async () => {
        await expect(
            resolvePricingWriteManually({
                write_id: WRITE,
                operator: 'operator-a',
                evidence: 'Both price reads look correct but request termination is unknown.',
                upstream_requests_ended: false as unknown as true,
            }),
        ).rejects.toThrow();
        expect(mock.transaction).not.toHaveBeenCalled();
    });

    it.each(['acknowledged', 'resolved'])('does not overwrite an already %s journal entry', async (status) => {
        mock.findUnique.mockResolvedValue({ id: WRITE, job_id: JOB, status });
        await expect(
            resolvePricingWriteManually({
                write_id: WRITE,
                operator: 'operator-a',
                evidence: 'INC-42: the prior upstream request is confirmed terminated.',
                upstream_requests_ended: true,
            }),
        ).rejects.toMatchObject({ code: 'pricing_write_not_uncertain' });
        expect(mock.update).not.toHaveBeenCalled();
    });

    it('cannot resolve a journal belonging to a different or released job', async () => {
        mock.lock.mockResolvedValue({ active_job_id: null });
        await expect(
            resolvePricingWriteManually({
                write_id: WRITE,
                operator: 'operator-a',
                evidence: 'INC-42: the prior upstream request is confirmed terminated.',
                upstream_requests_ended: true,
            }),
        ).rejects.toMatchObject({ code: 'pricing_job_conflict' });
        expect(mock.update).not.toHaveBeenCalled();
    });
});
