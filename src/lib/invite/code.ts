/**
 * Invite code helper (W7 D4).
 *
 * Operator-managed allow-list. The valid invite codes are sourced from
 * the `INVITE_CODES` env var (comma-separated, leading/trailing whitespace
 * trimmed per token, comparison case-insensitive). Codes are reusable by
 * design — the operator may broadcast a single code to a community group;
 * there's no 1-code-1-user uniqueness check.
 *
 * The perk: a registered user with `users.invite_code` non-empty AND
 * currently in the allow-list gets a +30% first-recharge bonus instead
 * of the default +20% (W6 D1). Re-validation happens at bonus-grant
 * time in `executeRecharge`, so removing a code from `INVITE_CODES`
 * also disables the bonus uplift for users still holding it (codes are
 * effectively soft-revocable without a DB migration).
 */

const SEPARATOR = /[,\s]+/;

/**
 * Read + parse the INVITE_CODES env into a normalized Set. Returns an
 * empty Set when the env var is unset or contains only whitespace, in
 * which case ALL invite codes are invalid (operator hasn't issued any).
 */
export function getValidInviteCodes(): Set<string> {
    const raw = process.env.INVITE_CODES;
    if (!raw) return new Set();
    const codes = raw
        .split(SEPARATOR)
        .map((c) => c.trim().toLowerCase())
        .filter((c) => c.length > 0);
    return new Set(codes);
}

/**
 * Check whether a given invite code is currently valid.
 *
 * Returns false on null/undefined/empty input — invite codes are optional
 * at registration, callers shouldn't have to special-case the absence
 * before calling.
 *
 * Compares case-insensitively against the env-driven allow-list. Whitespace
 * around the code is tolerated.
 */
export function isValidInviteCode(code: string | null | undefined): boolean {
    if (!code) return false;
    const normalized = code.trim().toLowerCase();
    if (normalized.length === 0) return false;
    return getValidInviteCodes().has(normalized);
}
