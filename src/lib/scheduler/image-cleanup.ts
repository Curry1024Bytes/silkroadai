/**
 * Image-generation cleanup scheduler (PR-T1 Phase 4).
 *
 * Mirrors the pattern of `src/lib/scheduler/balance-alert.ts` (W6 D2).
 * Runs every 6 hours; per pass:
 *
 *   1. Pick up to BATCH_SIZE rows where ANY of:
 *      - `expires_at < now` AND `is_favorite = false`  → 30-day TTL
 *      - `is_deleted = true`  AND `created_at < now-30d` → soft-delete TTL
 *   2. For each row: R2 deleteImages(r2_keys) + DB hard delete.
 *      Idempotent — R2 deletes are no-ops if missing; DB delete is by id.
 *
 * Hooked from `src/instrumentation.ts` next to the other schedulers.
 *
 * Multi-instance safe: deletion is idempotent. Two parallel sweeps
 * pick disjoint id sets via `take + orderBy id` semantics; if they
 * overlap, the second's DELETE returns count=0 silently. No CAS
 * needed.
 */
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { deleteImages } from '@/lib/r2/client';

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SOFT_DELETE_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Cap per-pass workload — keeps one slow R2 call from pinning. */
const BATCH_SIZE = 100;

let timer: ReturnType<typeof setInterval> | null = null;

export interface ImageCleanupResult {
    candidates: number;
    deleted: number;
    r2Deleted: number;
    errors: number;
}

/**
 * Single sweep. Exported so tests can drive it directly without the
 * setInterval wrapper.
 */
export async function sweepExpiredAndDeleted(now: Date = new Date()): Promise<ImageCleanupResult> {
    const result: ImageCleanupResult = { candidates: 0, deleted: 0, r2Deleted: 0, errors: 0 };
    const softDeleteCutoff = new Date(now.getTime() - SOFT_DELETE_GRACE_MS);

    const rows = await prisma.imageGeneration.findMany({
        where: {
            OR: [
                { is_favorite: false, expires_at: { lt: now } },
                { is_deleted: true, created_at: { lt: softDeleteCutoff } },
            ],
        },
        select: { id: true, r2_keys: true },
        take: BATCH_SIZE,
        orderBy: { id: 'asc' },
    });

    result.candidates = rows.length;

    for (const row of rows) {
        try {
            const keys = Array.isArray(row.r2_keys) ? (row.r2_keys as string[]) : [];
            if (keys.length > 0) {
                await deleteImages(keys);
                result.r2Deleted += keys.length;
            }
            // DB hard-delete. If a sibling instance beat us to it, count=0
            // (silently skipped — Prisma `delete` throws on missing row,
            // but `deleteMany` returns count).
            const deleted = await prisma.imageGeneration.deleteMany({
                where: { id: row.id },
            });
            result.deleted += deleted.count;
        } catch (err) {
            result.errors++;
            console.error(`[image-cleanup] row ${row.id} failed:`, err);
            Sentry.captureException(err, {
                tags: { area: 'image-cleanup', generation_id: row.id },
            });
        }
    }

    if (result.deleted > 0 || result.errors > 0) {
        console.log(
            `[image-cleanup] sweep complete: candidates=${result.candidates} deleted=${result.deleted} r2Deleted=${result.r2Deleted} errors=${result.errors}`,
        );
    }

    return result;
}

export function startImageCleanupScheduler(): void {
    if (timer) return;

    // Initial pass on boot, swallow errors so transient blips don't kill
    // the Next server. Subsequent ticks already isolate.
    sweepExpiredAndDeleted().catch((err) => {
        console.error('[image-cleanup] initial sweep failed:', err);
        Sentry.captureException(err, { tags: { area: 'image-cleanup-scheduler' } });
    });

    timer = setInterval(() => {
        sweepExpiredAndDeleted().catch((err) => {
            console.error('[image-cleanup] scheduled sweep failed:', err);
            Sentry.captureException(err, { tags: { area: 'image-cleanup-scheduler' } });
        });
    }, INTERVAL_MS);

    console.log('Image cleanup scheduler started');
}

export function stopImageCleanupScheduler(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
        console.log('Image cleanup scheduler stopped');
    }
}
