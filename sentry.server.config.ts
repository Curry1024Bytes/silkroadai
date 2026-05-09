/**
 * Sentry — server-side init (W5 D4).
 *
 * Conditional on SENTRY_DSN being set. Empty / missing DSN → SDK is loaded
 * but `init()` never runs, so subsequent `captureException` calls are
 * no-ops. Lets us sprinkle Sentry across hot paths without an env-gate at
 * each call site.
 *
 * `tracesSampleRate: 0.1` — performance monitoring on 10% of requests.
 * Cheap signal; bumpable later if cost not concerning.
 *
 * `beforeSend` strips fields likely to carry secrets so we never ship a
 * customer's sk-, password, or session cookie to Sentry. Defense-in-depth
 * — Sentry's own scrubber already covers most, but we add a paranoid
 * second pass.
 */
import * as Sentry from '@sentry/nextjs';

const SENSITIVE_HEADER_PATTERNS = [
    /authorization/i,
    /cookie/i,
    /x-api-key/i,
    /sentry/i, // own DSN if it ever leaks
];
const SENSITIVE_BODY_KEYS = new Set([
    'password',
    'newPassword',
    'oldPassword',
    'token',
    'access_token',
    'id_token',
    'client_secret',
    'apiKey',
    'newapi_token_value',
    'sk',
]);

if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'production',
        tracesSampleRate: 0.1,

        beforeSend(event) {
            // Scrub request headers
            if (event.request?.headers) {
                for (const key of Object.keys(event.request.headers)) {
                    if (SENSITIVE_HEADER_PATTERNS.some((re) => re.test(key))) {
                        event.request.headers[key] = '[REDACTED]';
                    }
                }
            }
            // Scrub request body fields (when sent as parsed object)
            if (event.request?.data && typeof event.request.data === 'object' && !Array.isArray(event.request.data)) {
                const data = event.request.data as Record<string, unknown>;
                for (const k of Object.keys(data)) {
                    if (SENSITIVE_BODY_KEYS.has(k)) data[k] = '[REDACTED]';
                }
            }
            // Defense against accidental sk- leak in error messages /
            // breadcrumbs (truncates rather than full redact so the message
            // shape stays useful).
            if (event.message) {
                event.message = event.message.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]');
            }
            return event;
        },
    });
}
