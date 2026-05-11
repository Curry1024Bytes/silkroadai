/**
 * Attribution window helpers (PR-U1).
 *
 * The 24-month customer-protection window from brief is the source of
 * truth for "is this customer's recharge still earning commission".
 * Computed once at register time (User.attribution_expires_at) so the
 * recharge hook can do a simple timestamp compare without recomputing
 * the window every call.
 */

/** Operator-decided protection window (brief: 24 月保护期). */
export const ATTRIBUTION_WINDOW_MONTHS = 24;

/**
 * Given a registration timestamp, return when attribution expires.
 *
 * Uses JS Date month arithmetic which handles year rollover but has a
 * quirk: registering on Jan 31 + 24 months puts us at Jan 31 again
 * (year+2) since intervening months always have day 31. Acceptable for
 * our use-case.
 *
 * Implementation note: we use setUTCMonth to keep things timezone-agnostic.
 * portal stores Date as TIMESTAMP(3) without timezone, but the JS Date
 * objects always carry an instant — the wall-clock display matters only
 * when surfaced to the UI.
 */
export function computeAttributionExpiry(registeredAt: Date = new Date()): Date {
    const d = new Date(registeredAt.getTime());
    d.setUTCMonth(d.getUTCMonth() + ATTRIBUTION_WINDOW_MONTHS);
    return d;
}
