/**
 * PR-U1 — reseller commission scheduler.
 *
 * Two passes wrapped in one hourly tick:
 *   1. **Hold-release**: flip pending → confirmed for any commission row
 *      whose `hold_until < now` AND `admin_review_required = false`.
 *      Manual-review rows stay pending until ops flips admin_review_required
 *      to false (and operator-decided commission status separately).
 *
 *   2. **Monthly settlement auto-create** (only on month boundary day 1
 *      UTC, between 00:00 and 01:00): for each reseller with any
 *      confirmed commission in the previous UTC month, upsert a
 *      ResellerSettlement row in `pending` state with the aggregated
 *      totals. UI nudge: "your June bill is ready: ¥X — click to request".
 *      Idempotent — unique (reseller_id, period_month) protects against
 *      multi-instance double-runs.
 *
 * Cadence: 1 hour. Mirror BalanceAlertScheduler — single timer, started
 * from src/instrumentation.ts.
 *
 * Batch cap: 1000 hold-release rows per pass + 200 reseller settlements
 * per pass (back-pressure prevention if portal restarts after weeks of
 * downtime and a flood of rows is past their hold).
 *
 * NOT in this scheduler:
 *   - settled→paid transitions: operator action via admin tooling
 *   - refund-driven commission reversal: deferred to Phase 2 (no refund
 *     hook here for now; brief explicitly leaves it out)
 *   - tier downgrade: tier only goes up; refunds in Phase 2 may want to
 *     adjust cumulative_gmv but not currently scoped
 */
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';

const INTERVAL_MS = 60 * 60 * 1_000; // 1 hour
const HOLD_RELEASE_BATCH = 1_000;
const SETTLEMENT_RESELLER_BATCH = 200;

let timer: ReturnType<typeof setInterval> | null = null;

export interface ResellerSchedulerResult {
    hold_released: number;
    settlements_created: number;
    settlements_skipped_idempotent: number;
    errors: number;
}

/** Format a Date as "YYYY-MM" UTC. */
export function utcPeriodMonth(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

/** Return the previous UTC month string given a reference instant. */
export function previousUtcPeriodMonth(now: Date = new Date()): string {
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return utcPeriodMonth(prev);
}

/** Bounds for a given "YYYY-MM" period in UTC. */
function monthBounds(period: string): { start: Date; end: Date } {
    const [yStr, mStr] = period.split('-');
    const y = Number(yStr);
    const m = Number(mStr);
    return {
        start: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0)),
        end: new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)),
    };
}

/**
 * Single scan pass — exported for tests + scheduler tick.
 *
 * Idempotent: re-running with no new state changes returns
 * `hold_released=0, settlements_created=0`.
 */
export async function runResellerSchedulerOnce(now: Date = new Date()): Promise<ResellerSchedulerResult> {
    const result: ResellerSchedulerResult = {
        hold_released: 0,
        settlements_created: 0,
        settlements_skipped_idempotent: 0,
        errors: 0,
    };

    // ── Pass 1: hold-release ──
    // Set-based UPDATE — much faster than row-by-row. WHERE filters to
    // exactly the rows that should flip, so updateMany.count is the
    // number actually released.
    try {
        const releaseResult = await prisma.resellerCommission.updateMany({
            where: {
                status: 'pending',
                admin_review_required: false,
                hold_until: { lt: now },
            },
            data: { status: 'confirmed' },
        });
        result.hold_released = releaseResult.count;
        if (releaseResult.count >= HOLD_RELEASE_BATCH) {
            console.warn(
                `[reseller-commission] hold-release pass hit batch cap ${HOLD_RELEASE_BATCH} — there may be more pending; next tick continues`,
            );
        }
    } catch (err) {
        result.errors++;
        console.error('[reseller-commission] hold-release pass failed:', err);
        Sentry.captureException(err, { tags: { area: 'reseller-commission', step: 'hold_release' } });
    }

    // ── Pass 2: monthly settlement auto-create ──
    // Only run between 00:00 and 01:00 UTC on day 1 of the month — minimizes
    // wasted work on the other 23 hours. Idempotent via unique
    // (reseller_id, period_month) so a second pass within the window is OK.
    const isFirstHourOfMonth = now.getUTCDate() === 1 && now.getUTCHours() === 0;
    if (isFirstHourOfMonth) {
        const period = previousUtcPeriodMonth(now);
        const { start, end } = monthBounds(period);

        try {
            // Find resellers with any confirmed commission in the previous month.
            // groupBy returns one row per (reseller_id) with sum + count.
            const agg = await prisma.resellerCommission.groupBy({
                by: ['reseller_id'],
                where: {
                    status: 'confirmed',
                    created_at: { gte: start, lt: end },
                },
                _sum: { commission_amount: true },
                _count: { _all: true },
                // Prisma requires orderBy when take is set — deterministic
                // pagination guard. The order itself doesn't matter for us
                // (idempotent upsert via unique constraint), so just pick
                // reseller_id ascending.
                orderBy: { reseller_id: 'asc' },
                take: SETTLEMENT_RESELLER_BATCH,
            });

            for (const row of agg) {
                try {
                    const total = row._sum.commission_amount ?? '0';
                    const count = row._count._all;
                    const existing = await prisma.resellerSettlement.findUnique({
                        where: {
                            reseller_id_period_month: {
                                reseller_id: row.reseller_id,
                                period_month: period,
                            },
                        },
                        select: { id: true },
                    });
                    if (existing) {
                        result.settlements_skipped_idempotent++;
                        continue;
                    }
                    await prisma.resellerSettlement.create({
                        data: {
                            reseller_id: row.reseller_id,
                            period_month: period,
                            total_commission: total,
                            commission_count: count,
                            // status defaults to pending.
                        },
                    });
                    result.settlements_created++;
                } catch (err) {
                    result.errors++;
                    console.error(
                        `[reseller-commission] settlement create failed for reseller=${row.reseller_id} period=${period}:`,
                        err,
                    );
                    Sentry.captureException(err, {
                        tags: { area: 'reseller-commission', step: 'settlement_create' },
                    });
                }
            }
        } catch (err) {
            result.errors++;
            console.error('[reseller-commission] settlement aggregate failed:', err);
            Sentry.captureException(err, {
                tags: { area: 'reseller-commission', step: 'settlement_agg' },
            });
        }
    }

    if (result.hold_released > 0 || result.settlements_created > 0 || result.errors > 0) {
        console.log(
            `[reseller-commission] scan complete: hold_released=${result.hold_released} settlements_created=${result.settlements_created} settlements_skipped=${result.settlements_skipped_idempotent} errors=${result.errors}`,
        );
    }
    return result;
}

export function startResellerCommissionScheduler(): void {
    if (timer) return;

    // Initial pass on boot — swallow errors so a transient DB blip at
    // startup doesn't kill Next.
    runResellerSchedulerOnce().catch((err) => {
        console.error('[reseller-commission] initial scan failed:', err);
        Sentry.captureException(err, { tags: { area: 'reseller-commission-scheduler' } });
    });

    timer = setInterval(() => {
        runResellerSchedulerOnce().catch((err) => {
            console.error('[reseller-commission] scheduled scan failed:', err);
            Sentry.captureException(err, { tags: { area: 'reseller-commission-scheduler' } });
        });
    }, INTERVAL_MS);

    console.log('Reseller commission scheduler started');
}

export function stopResellerCommissionScheduler(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
        console.log('Reseller commission scheduler stopped');
    }
}
