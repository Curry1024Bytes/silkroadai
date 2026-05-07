/**
 * W7 launch promo window — server-side date logic.
 *
 * Promo runs `2026-05-08 00:00:00 UTC+8` (inclusive) through
 * `2026-06-07 23:59:59.999 UTC+8` (inclusive). After 06-08 00:00 UTC+8 the
 * landing page reverts to retail prices and the banner disappears.
 *
 * W7 D4 PR-K shifted the original 5/10–6/9 window two days earlier so the
 * promo banner goes live on the same day as the public launch, while
 * preserving the 31-day duration (operator decision: launch_date == promo
 * start to avoid an awkward two-day "launched but no promo yet" window).
 *
 * Window is hard-coded on purpose:
 *   - The pricing-cutover script (`_bootstrap/apply-w7-pricing.ts`) bakes the
 *     same dates into channel ratios.
 *   - The exit script (`_bootstrap/exit-w7-promo.ts`) is triggered manually
 *     on 06-07 evening; the landing banner needs to drop on the same boundary
 *     without a redeploy.
 *
 * Anchoring with `+08:00` makes the boundary unambiguous regardless of where
 * the server runs (today: VPS is UTC, but ISR-rendered pages may be cached on
 * any node).
 */

/** Inclusive promo start: 2026-05-08 00:00:00 UTC+8. */
export const PROMO_START = new Date('2026-05-08T00:00:00+08:00');

/** Exclusive promo end: 2026-06-08 00:00:00 UTC+8.
 *  (i.e. promo last instant is 2026-06-07 23:59:59.999 UTC+8) */
export const PROMO_END_EXCLUSIVE = new Date('2026-06-08T00:00:00+08:00');

/**
 * Whether the W7 launch promo is currently active.
 *
 * @param now  Override the clock for tests. Defaults to `new Date()`.
 */
export function isPromoActive(now: Date = new Date()): boolean {
    return now.getTime() >= PROMO_START.getTime() && now.getTime() < PROMO_END_EXCLUSIVE.getTime();
}

/**
 * Inclusive last-day boundary the landing copy refers to as "6 月 7 日截止".
 * Returns 2026-06-07 (UTC+8). Useful for displaying the deadline in copy.
 */
export function getPromoEndDate(): Date {
    // 23:59:59.999 of 2026-06-07 UTC+8 = PROMO_END_EXCLUSIVE - 1ms.
    return new Date(PROMO_END_EXCLUSIVE.getTime() - 1);
}
