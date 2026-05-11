/**
 * Privacy mask helpers for reseller views (PR-U1).
 *
 * Resellers see their attributed customers but MUST NOT see PII. Two
 * helpers cover the two visible identifiers:
 *
 *   - `maskEmail("alice@gmail.com")` → "ali***@gmail.com"
 *   - `customerSeqNo(orderInList, index)`  → returns "#001", "#002", …
 *     for use as the customer display label, scoped to the reseller's
 *     own customer list. Sequential per invitation order so a reseller
 *     can refer to "customer #003" when asking ops about reconciliation
 *     without us ever exposing the underlying UUID or email.
 *
 * Mask spec (consistent with brief Q3 calibration):
 *   - local part ≥ 3 chars: keep first 3, append "***", append "@" + domain
 *   - local part 1-2 chars: keep first char only, append "***", "@" + domain
 *   - missing "@" (defensive) → return as-is, since we can't safely mask
 *     a non-email string here. Caller's input contract requires email.
 */

const MIN_PREFIX_FOR_THREE = 3;

/**
 * Mask an email for reseller-facing display.
 *
 * Lowercases the input before masking (so resellers don't see "AlIcE@x.io").
 * Returns "—" for null/undefined/empty input rather than empty string, so
 * the UI shows a stable placeholder.
 */
export function maskEmail(email: string | null | undefined): string {
    if (!email) return '—';
    const lower = email.trim().toLowerCase();
    if (lower.length === 0) return '—';
    const atIdx = lower.indexOf('@');
    if (atIdx <= 0 || atIdx === lower.length - 1) {
        // Malformed — no local part or no domain. Return the masked-ish
        // form rather than echoing the raw value back.
        return '***';
    }
    const local = lower.slice(0, atIdx);
    const domain = lower.slice(atIdx); // includes the "@"
    if (local.length >= MIN_PREFIX_FOR_THREE) {
        return `${local.slice(0, MIN_PREFIX_FOR_THREE)}***${domain}`;
    }
    // 1-2 char local part: keep first character only.
    return `${local.slice(0, 1)}***${domain}`;
}

/**
 * Return a 1-based 3-digit sequence label for a customer row in a reseller's
 * customer list. The caller is responsible for sorting the list in
 * invitation order (created_at ASC) — this helper just formats the index.
 *
 *   customerSeqNo(0)  → "#001"
 *   customerSeqNo(42) → "#043"
 *   customerSeqNo(999) → "#1000" (overflow — 4 digits beyond)
 *
 * 3-digit zero-pad is the common case at launch (resellers will have
 * tens of customers, not thousands). Beyond 999 we naturally widen to
 * accommodate without truncation.
 */
export function customerSeqNo(zeroBasedIndex: number): string {
    if (!Number.isInteger(zeroBasedIndex) || zeroBasedIndex < 0) {
        // Defensive — shouldn't happen since callers always pass an array
        // index. Returning "#000" lets the UI render without crashing.
        return '#000';
    }
    const oneBased = zeroBasedIndex + 1;
    return `#${String(oneBased).padStart(3, '0')}`;
}
