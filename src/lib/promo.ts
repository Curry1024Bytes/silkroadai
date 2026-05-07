/**
 * W7 launch promo window — server-side date logic.
 *
 * Promo runs `2026-05-07 00:00:00 UTC+8` (inclusive) through
 * `2026-06-09 23:59:59.999 UTC+8` (inclusive). After 06-10 00:00 UTC+8 the
 * landing page reverts to retail prices and the banner disappears.
 *
 * Date history:
 *   - W7 D4 PR-K:  5/10–6/9 → 5/8–6/7 (launch alignment)
 *   - W7 D4 PR-MN: 5/8 → 5/7 (banner live on deploy, end unchanged at 6/7)
 *   - W7 D4 PR-O:  end 6/7 → 6/9 to align with the hero block's hard-coded
 *     "6 月 9 日截止" copy (operator chose to move the boundary to match
 *     the visible string rather than vice versa). Window is now 34 days;
 *     the hero "限时 30 天" copy is intentionally kept fuzzy per operator.
 *
 * Window is hard-coded on purpose:
 *   - The pricing-cutover script (`_bootstrap/apply-w7-pricing.ts`) bakes the
 *     same dates into channel ratios.
 *   - The exit script (`_bootstrap/exit-w7-promo.ts`) is triggered manually
 *     on 06-09 evening; the landing banner needs to drop on the same boundary
 *     without a redeploy.
 *
 * Anchoring with `+08:00` makes the boundary unambiguous regardless of where
 * the server runs (today: VPS is UTC, but ISR-rendered pages may be cached on
 * any node).
 */

/** Inclusive promo start: 2026-05-07 00:00:00 UTC+8. */
export const PROMO_START = new Date('2026-05-07T00:00:00+08:00');

/** Exclusive promo end: 2026-06-10 00:00:00 UTC+8.
 *  (i.e. promo last instant is 2026-06-09 23:59:59.999 UTC+8) */
export const PROMO_END_EXCLUSIVE = new Date('2026-06-10T00:00:00+08:00');

/**
 * Whether the W7 launch promo is currently active.
 *
 * @param now  Override the clock for tests. Defaults to `new Date()`.
 */
export function isPromoActive(now: Date = new Date()): boolean {
    return now.getTime() >= PROMO_START.getTime() && now.getTime() < PROMO_END_EXCLUSIVE.getTime();
}

/**
 * Inclusive last-day boundary the landing copy refers to as "6 月 9 日截止".
 * Returns 2026-06-09 (UTC+8). Useful for displaying the deadline in copy.
 */
export function getPromoEndDate(): Date {
    // 23:59:59.999 of 2026-06-09 UTC+8 = PROMO_END_EXCLUSIVE - 1ms.
    return new Date(PROMO_END_EXCLUSIVE.getTime() - 1);
}
