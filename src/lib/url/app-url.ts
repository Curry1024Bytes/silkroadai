/**
 * Resolve the canonical portal origin for outbound URLs (verify-email
 * links, password-reset links, balance-alert email CTAs, …).
 *
 * Why a helper, not just `process.env.NEXT_PUBLIC_APP_URL`:
 *
 * Next.js inlines `NEXT_PUBLIC_*` env reads at build time as string
 * literals — even on the server. Compose now passes the production value
 * into the image build, but changing only the running container's env still
 * cannot replace an already-inlined value. `APP_URL` remains first because it
 * is a true runtime read; this helper centralizes that pattern for every
 * email and scheduled task.
 *
 * Precedence:
 *   1. `APP_URL`              — runtime, set in container .env
 *   2. `NEXT_PUBLIC_APP_URL`  — build-time inlined by the Docker build
 *   3. `http://localhost:3002` — dev fallback so e2e debug log entries
 *                                stay useful when neither is set
 */

/** Dev / unset-env fallback. Exported so tests can assert it directly. */
export const DEV_FALLBACK_APP_URL = 'http://localhost:3002';

export function getAppUrl(): string {
    return process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || DEV_FALLBACK_APP_URL;
}
