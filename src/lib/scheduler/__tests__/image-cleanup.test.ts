/**
 * PR-T1 Phase 4 — image-cleanup scheduler unit tests.
 *
 * Drives `sweepExpiredAndDeleted()` directly with mocked prisma + R2.
 * Asserts that:
 *   - expired non-favorite rows are deleted (R2 + DB)
 *   - soft-deleted rows older than 30d are deleted (R2 + DB)
 *   - favorite rows with null expires_at survive
 *   - per-row failures are logged but don't break the sweep
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindMany = vi.fn();
const mockDeleteMany = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        imageGeneration: {
            findMany: (...args: unknown[]) => mockFindMany(...args),
            deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
        },
    },
}));

const mockDeleteImages = vi.fn();
vi.mock('@/lib/r2/client', () => ({
    deleteImages: (...args: unknown[]) => mockDeleteImages(...args),
}));

const mockSentryCapture = vi.fn();
vi.mock('@sentry/nextjs', () => ({
    captureException: (...args: unknown[]) => mockSentryCapture(...args),
}));

import { sweepExpiredAndDeleted } from '@/lib/scheduler/image-cleanup';

const NOW = new Date('2026-05-09T12:00:00Z');

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('sweepExpiredAndDeleted — query shape', () => {
    it('asks for rows where (expired & non-favorite) OR (soft-deleted & old)', async () => {
        mockFindMany.mockResolvedValueOnce([]);
        await sweepExpiredAndDeleted(NOW);

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.OR).toBeDefined();
        expect(where.OR).toHaveLength(2);
        // Branch 1: non-favorite + expired
        expect(where.OR[0].is_favorite).toBe(false);
        expect(where.OR[0].expires_at).toEqual({ lt: NOW });
        // Branch 2: soft-deleted + 30d ago
        expect(where.OR[1].is_deleted).toBe(true);
        const cutoff = where.OR[1].created_at.lt as Date;
        const expectedCutoff = NOW.getTime() - 30 * 24 * 60 * 60 * 1000;
        expect(cutoff.getTime()).toBe(expectedCutoff);
    });

    it('caps batch at 100 rows per pass', async () => {
        mockFindMany.mockResolvedValueOnce([]);
        await sweepExpiredAndDeleted(NOW);
        expect(mockFindMany.mock.calls[0][0].take).toBe(100);
    });
});

describe('sweepExpiredAndDeleted — per-row execution', () => {
    it('deletes R2 keys + DB row for each candidate', async () => {
        mockFindMany.mockResolvedValueOnce([
            { id: 'row-1', r2_keys: ['k1', 'k2'] },
            { id: 'row-2', r2_keys: ['k3'] },
        ]);
        mockDeleteImages.mockResolvedValue(undefined);
        mockDeleteMany.mockResolvedValue({ count: 1 });

        const result = await sweepExpiredAndDeleted(NOW);

        expect(mockDeleteImages).toHaveBeenCalledTimes(2);
        expect(mockDeleteImages).toHaveBeenNthCalledWith(1, ['k1', 'k2']);
        expect(mockDeleteImages).toHaveBeenNthCalledWith(2, ['k3']);
        expect(mockDeleteMany).toHaveBeenCalledTimes(2);
        expect(result.candidates).toBe(2);
        expect(result.deleted).toBe(2);
        expect(result.r2Deleted).toBe(3);
        expect(result.errors).toBe(0);
    });

    it('skips R2 delete when r2_keys is empty', async () => {
        mockFindMany.mockResolvedValueOnce([{ id: 'row-1', r2_keys: [] }]);
        mockDeleteMany.mockResolvedValue({ count: 1 });

        const result = await sweepExpiredAndDeleted(NOW);
        expect(mockDeleteImages).not.toHaveBeenCalled();
        expect(result.deleted).toBe(1);
        expect(result.r2Deleted).toBe(0);
    });

    it('logs + continues on per-row failure', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockFindMany.mockResolvedValueOnce([
            { id: 'row-1', r2_keys: ['k1'] },
            { id: 'row-2', r2_keys: ['k2'] },
        ]);
        mockDeleteImages.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('R2 502'));
        mockDeleteMany.mockResolvedValue({ count: 1 });

        const result = await sweepExpiredAndDeleted(NOW);

        // Row 1 succeeded fully, row 2's R2 call threw → recorded as error,
        // its DB delete didn't run.
        expect(result.candidates).toBe(2);
        expect(result.deleted).toBe(1);
        expect(result.r2Deleted).toBe(1);
        expect(result.errors).toBe(1);
        expect(mockSentryCapture).toHaveBeenCalledTimes(1);

        errSpy.mockRestore();
    });
});

describe('sweepExpiredAndDeleted — empty pass', () => {
    it('returns zero-counts when no candidates', async () => {
        mockFindMany.mockResolvedValueOnce([]);
        const result = await sweepExpiredAndDeleted(NOW);
        expect(result).toEqual({ candidates: 0, deleted: 0, r2Deleted: 0, errors: 0 });
        expect(mockDeleteImages).not.toHaveBeenCalled();
        expect(mockDeleteMany).not.toHaveBeenCalled();
    });
});
