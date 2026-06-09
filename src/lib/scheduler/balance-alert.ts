/**
 * W6 D2 — balance-low retention alert scheduler.
 *
 * Runs every 1h (mirrors the W4-2 D? `Order timeout scheduler` pattern in
 * `src/lib/order/timeout.ts`). Hooked from `src/instrumentation.ts` so it
 * starts with the Next server process.
 *
 * Per pass:
 *   1. Find candidates: status=active, has new-api linkage,
 *      threshold > 0, and (last_sent IS NULL OR last_sent < now-24h).
 *   2. For each candidate: read quota via the W4-2 D6 cache helper
 *      (60s row cache + stale-fallback + new-api liveness). Skip on read
 *      failure with no cache (we can't make a recommendation safely).
 *   3. If `quotaToCny(remain) <= threshold`:
 *      a. CAS-claim `balance_alert_last_sent_at = now()` with the same
 *         predicate that selected the candidate — protects against
 *         multi-instance double-send (single instance today, future-proof).
 *      b. Send the alert email. SMTP failures bubble to Sentry inside
 *         `sendBalanceAlertEmail` (shared with W3 D4 / D5 path).
 *
 * NOT in this scheduler:
 *   - Re-sending after 24h cooldown when balance stays low. We accept that
 *     a customer who ignores the first alert just sees one more reminder
 *     per day, never a flood. Tweak `COOLDOWN_MS` to change cadence.
 *   - Notification channels other than email — IM / SMS deferred.
 *
 * `executeRecharge` (W4-1 D1, W6 D1) resets `balance_alert_last_sent_at`
 * to `null` inside its commit transaction so a fresh top-up that quickly
 * runs out can re-trigger the alert without waiting 24h.
 */
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { getCustomerBalance } from '@/lib/billing/customer-balance';
import { sendBalanceAlertEmail } from '@/lib/email/send';
import { getAppUrl } from '@/lib/url/app-url';

const INTERVAL_MS = 60 * 60 * 1_000; // 1 hour
const COOLDOWN_MS = 24 * 60 * 60 * 1_000; // 24 hours
/** Cap per-pass workload — prevents one slow new-api round-trip from
 *  pinning the scheduler. With 1h cadence and ≤200 sends/round we can
 *  process up to 4800 alerts/day before backpressure shows up. */
const BATCH_SIZE = 200;

let timer: ReturnType<typeof setInterval> | null = null;

// Caller-environment URL for the email CTA. Delegates to the shared
// `getAppUrl()` helper so we use the same APP_URL > NEXT_PUBLIC_APP_URL >
// dev-fallback precedence as the auth-email senders. (W7 D4 PR-J fix —
// Dockerfile L61 bakes a localhost placeholder into NEXT_PUBLIC_APP_URL,
// which surfaced in W7 launch e2e as "https://localhost" CTAs in alert
// mails.)

export interface BalanceAlertScanResult {
    candidates: number;
    alertsSent: number;
    skippedAboveThreshold: number;
    skippedQuotaUnavailable: number;
    skippedRaceLost: number;
    errors: number;
}

/**
 * Single scan pass. Exported for tests + the scheduler tick.
 *
 * Idempotent: a re-entry within 24h sees `balance_alert_last_sent_at` set
 * to "now" by the prior pass and excludes those users via the WHERE clause.
 */
export async function scanAndAlert(now: Date = new Date()): Promise<BalanceAlertScanResult> {
    const cooldownCutoff = new Date(now.getTime() - COOLDOWN_MS);
    const result: BalanceAlertScanResult = {
        candidates: 0,
        alertsSent: 0,
        skippedAboveThreshold: 0,
        skippedQuotaUnavailable: 0,
        skippedRaceLost: 0,
        errors: 0,
    };

    const candidates = await prisma.user.findMany({
        where: {
            status: 'active',
            newapi_user_id: { not: null },
            // threshold === 0 (or null defensive) → user opted out, skip.
            balance_alert_threshold_cny: { gt: 0 },
            OR: [{ balance_alert_last_sent_at: null }, { balance_alert_last_sent_at: { lt: cooldownCutoff } }],
        },
        select: {
            id: true,
            email: true,
            balance_alert_threshold_cny: true,
            balance_alert_last_sent_at: true,
        },
        take: BATCH_SIZE,
    });

    result.candidates = candidates.length;

    const topupUrl = `${getAppUrl()}/pay`;
    const settingsUrl = `${getAppUrl()}/balance`;

    for (const u of candidates) {
        try {
            // P4c-3.5: portal 客户按 Account.balance_cny 判低余额 —— 否则读到哑门 quota(1e9 放行)
            // 会永远 > 阈值、永不提醒。newapi 照旧 getQuotaWithCache。
            const bal = await getCustomerBalance(u.id);
            const remainCny = bal.balanceCny;
            const threshold = u.balance_alert_threshold_cny ? Number(u.balance_alert_threshold_cny) : 0;

            if (remainCny > threshold) {
                result.skippedAboveThreshold++;
                continue;
            }

            // CAS-claim the send: identical predicate to the candidate query
            // so a sibling instance that already sent within 24h yields
            // count=0 here and we skip without double-sending.
            const claim = await prisma.user.updateMany({
                where: {
                    id: u.id,
                    balance_alert_threshold_cny: { gt: 0 },
                    OR: [{ balance_alert_last_sent_at: null }, { balance_alert_last_sent_at: { lt: cooldownCutoff } }],
                },
                data: { balance_alert_last_sent_at: now },
            });
            if (claim.count === 0) {
                result.skippedRaceLost++;
                continue;
            }

            await sendBalanceAlertEmail({
                to: u.email,
                remainCny,
                thresholdCny: threshold,
                topupUrl,
                settingsUrl,
            });
            result.alertsSent++;
        } catch (err) {
            result.errors++;
            // getQuotaWithCache hard-fails when no cache + new-api dead.
            // Treat that as "skipped quota unavailable" rather than a true
            // error to keep the metric meaningful for ops.
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('quota fetch failed')) {
                result.skippedQuotaUnavailable++;
            } else {
                console.error(`[balance-alert] user ${u.id} failed:`, err);
                Sentry.captureException(err, {
                    tags: { area: 'balance-alert', user_id: u.id },
                });
            }
        }
    }

    if (result.alertsSent > 0 || result.errors > 0) {
        console.log(
            `[balance-alert] scan complete: candidates=${result.candidates} sent=${result.alertsSent} above=${result.skippedAboveThreshold} unavailable=${result.skippedQuotaUnavailable} raceLost=${result.skippedRaceLost} errors=${result.errors}`,
        );
    }

    return result;
}

export function startBalanceAlertScheduler(): void {
    if (timer) return;

    // Initial pass on startup, swallow errors so a transient DB blip at
    // boot doesn't kill the Next server. Subsequent ticks already isolate.
    scanAndAlert().catch((err) => {
        console.error('[balance-alert] initial scan failed:', err);
        Sentry.captureException(err, { tags: { area: 'balance-alert-scheduler' } });
    });

    timer = setInterval(() => {
        scanAndAlert().catch((err) => {
            console.error('[balance-alert] scheduled scan failed:', err);
            Sentry.captureException(err, { tags: { area: 'balance-alert-scheduler' } });
        });
    }, INTERVAL_MS);

    console.log('Balance alert scheduler started');
}

export function stopBalanceAlertScheduler(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
        console.log('Balance alert scheduler stopped');
    }
}
