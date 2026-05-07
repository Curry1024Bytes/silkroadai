/**
 * Token-value display formatter (W7 D4 PR-H Tier A).
 *
 * Background: new-api stores customer token values as 48-char random
 * strings WITHOUT the `sk-` prefix in its own DB, and our portal mirrors
 * that storage in `NewApiToken.newapi_token_value` (verified live during
 * the PR-H 403 diagnosis: stored value length is 48 chars). The
 * `Authorization: Bearer …` header on the wire requires `sk-` prefix
 * though — both new-api and the portal /api/portal/keys/[id]/key
 * reveal endpoint need to return the prefixed form so customers paste
 * a working header.
 *
 * Architectural choice: keep the DB value at 48 chars (matches new-api's
 * canonical representation, simplifies any future cross-system audit),
 * add the prefix at every boundary where the value crosses from server
 * → client. Three boundaries:
 *   - page SSR mask (src/app/(authenticated)/keys/page.tsx)
 *   - GET reveal     (src/app/api/portal/keys/[id]/key/route.ts)
 *   - POST create    (src/app/api/portal/keys/route.ts)
 *
 * The function is idempotent: passing an already-prefixed value (which
 * happens in some test fixtures + future-proof against new-api ever
 * returning prefixed values) returns the input unchanged. No double-
 * `sk-sk-…` outputs.
 *
 * Pure / safe to import from any layer (server route, page SSR, client
 * component) — no side effects, no env reads.
 */

/** The wire-format prefix every customer-facing key must carry. */
export const TOKEN_DISPLAY_PREFIX = 'sk-';

/**
 * Convert a stored token value to the customer-facing display form.
 *
 * Idempotent — already-prefixed input is returned unchanged.
 *
 * @example
 *   formatTokenForDisplay('Bc4UOPZdTYBS56MMFE1XrOXf5ILtXXXDPsWgqqgecvS5dezb')
 *   // → 'sk-Bc4UOPZdTYBS56MMFE1XrOXf5ILtXXXDPsWgqqgecvS5dezb'
 *
 *   formatTokenForDisplay('sk-already-prefixed')
 *   // → 'sk-already-prefixed'  (no-op)
 */
export function formatTokenForDisplay(stored: string): string {
    return stored.startsWith(TOKEN_DISPLAY_PREFIX) ? stored : TOKEN_DISPLAY_PREFIX + stored;
}
