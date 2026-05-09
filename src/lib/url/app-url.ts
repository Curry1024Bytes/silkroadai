/**
 * Resolve the canonical portal origin for outbound URLs (verify-email
 * links, password-reset links, balance-alert email CTAs, …).
 *
 * Why a helper, not just `process.env.NEXT_PUBLIC_APP_URL`:
 *
 * Next.js inlines `NEXT_PUBLIC_*` env reads at build time as string
 * literals — even on the server. The Dockerfile bakes a placeholder
 * `NEXT_PUBLIC_APP_URL="https://localhost"` so the build doesn't crash
 * on missing env, which means at runtime every server-side
 * `process.env.NEXT_PUBLIC_APP_URL` reads `"https://localhost"`
 * regardless of what the running container's env actually says. The
 * OAuth callbacks worked around this in W5 D3 by reading `APP_URL`
 * first (a *non*-NEXT_PUBLIC var that's a true runtime read); this
 * helper centralizes that pattern so every email / scheduled task
 * uses the right precedence.
 *
 * Precedence:
 *   1. `APP_URL`              — runtime, set in container .env
 *   2. `NEXT_PUBLIC_APP_URL`  — build-time inlined; correct ONLY if the
 *                               docker build matched prod (it doesn't —
 *                               see Dockerfile L61)
 *   3. `http://localhost:3002` — dev fallback so e2e debug log entries
 *                                stay useful when neither is set
 */

/** Dev / unset-env fallback. Exported so tests can assert it directly. */
export const DEV_FALLBACK_APP_URL = 'http://localhost:3002';

export function getAppUrl(): string {
    return process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || DEV_FALLBACK_APP_URL;
}
