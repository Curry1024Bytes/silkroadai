/**
 * W5 D4 — sentry.server.config.ts gating + scrubber.
 *
 * Verifies:
 *   - Sentry.init() runs ONLY when process.env.SENTRY_DSN is set.
 *     (Empty / missing DSN keeps the SDK loaded but un-initialized, so
 *     subsequent captureException calls are no-ops without throwing.)
 *   - The beforeSend scrubber redacts auth-bearing headers, sensitive body
 *     keys, and sk- token leaks in error messages.
 *
 * Module isolation: vi.resetModules() between cases so the top-level
 * `if (env)` runs fresh each time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockInit = vi.fn();
vi.mock('@sentry/nextjs', () => ({
    init: (...args: unknown[]) => mockInit(...args),
    // Stub captureException + captureMessage so call sites don't crash
    // even when the file is loaded outside test scope.
    captureException: vi.fn(),
    captureMessage: vi.fn(),
}));

const ORIG_DSN = process.env.SENTRY_DSN;

beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules(); // force re-eval of sentry.server.config on next import
});

afterEach(() => {
    if (ORIG_DSN === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = ORIG_DSN;
});

describe('sentry.server.config — init gating', () => {
    it('does NOT init when SENTRY_DSN is unset (no-op SDK, captureException is harmless)', async () => {
        delete process.env.SENTRY_DSN;
        await import('../../../sentry.server.config');
        expect(mockInit).not.toHaveBeenCalled();
    });

    it('does NOT init when SENTRY_DSN is empty string', async () => {
        process.env.SENTRY_DSN = '';
        await import('../../../sentry.server.config');
        expect(mockInit).not.toHaveBeenCalled();
    });

    it('initializes when SENTRY_DSN is set, with environment + tracesSampleRate + beforeSend', async () => {
        process.env.SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
        await import('../../../sentry.server.config');

        expect(mockInit).toHaveBeenCalledTimes(1);
        const cfg = mockInit.mock.calls[0][0] as Record<string, unknown>;
        expect(cfg.dsn).toBe('https://abc@o123.ingest.sentry.io/456');
        expect(cfg.environment).toBeDefined();
        expect(cfg.tracesSampleRate).toBe(0.1);
        expect(typeof cfg.beforeSend).toBe('function');
    });
});

describe('sentry.server.config — beforeSend scrubber', () => {
    it('redacts authorization + cookie + x-api-key headers', async () => {
        process.env.SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
        await import('../../../sentry.server.config');
        const cfg = mockInit.mock.calls[0][0] as { beforeSend: (e: unknown) => unknown };

        const event = {
            request: {
                headers: {
                    authorization: 'Bearer secret-token',
                    cookie: 'silkroad_session=jwt-leak',
                    'x-api-key': 'sk-real-key',
                    'x-request-id': 'safe-keep-this',
                    'user-agent': 'safe-keep-this-too',
                },
            },
        };
        const out = cfg.beforeSend(event) as typeof event;
        expect(out.request.headers.authorization).toBe('[REDACTED]');
        expect(out.request.headers.cookie).toBe('[REDACTED]');
        expect(out.request.headers['x-api-key']).toBe('[REDACTED]');
        // Non-sensitive headers untouched
        expect(out.request.headers['x-request-id']).toBe('safe-keep-this');
        expect(out.request.headers['user-agent']).toBe('safe-keep-this-too');
    });

    it('redacts sensitive body keys (password / token / sk / apiKey / etc)', async () => {
        process.env.SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
        await import('../../../sentry.server.config');
        const cfg = mockInit.mock.calls[0][0] as { beforeSend: (e: unknown) => unknown };

        const event = {
            request: {
                data: {
                    email: 'happy@llmroute.club',
                    password: 'plain-text-pw',
                    newPassword: 'shouldnt-survive',
                    token: 'reset-token-secret',
                    apiKey: 'sk-secret',
                    newapi_token_value: 'sk-real',
                    safeField: 'kept',
                },
            },
        };
        const out = cfg.beforeSend(event) as { request: { data: Record<string, unknown> } };
        expect(out.request.data.password).toBe('[REDACTED]');
        expect(out.request.data.newPassword).toBe('[REDACTED]');
        expect(out.request.data.token).toBe('[REDACTED]');
        expect(out.request.data.apiKey).toBe('[REDACTED]');
        expect(out.request.data.newapi_token_value).toBe('[REDACTED]');
        // Non-sensitive untouched
        expect(out.request.data.email).toBe('happy@llmroute.club');
        expect(out.request.data.safeField).toBe('kept');
    });

    it('truncates sk- tokens leaked in event.message', async () => {
        process.env.SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
        await import('../../../sentry.server.config');
        const cfg = mockInit.mock.calls[0][0] as { beforeSend: (e: unknown) => unknown };

        const event = { message: 'API call failed for token sk-abcd1234efgh5678 — retry?' };
        const out = cfg.beforeSend(event) as typeof event;
        expect(out.message).toContain('sk-[REDACTED]');
        expect(out.message).not.toContain('sk-abcd1234');
        // Surrounding context preserved
        expect(out.message).toContain('API call failed');
        expect(out.message).toContain('retry?');
    });

    it('handles events without request / message gracefully', async () => {
        process.env.SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
        await import('../../../sentry.server.config');
        const cfg = mockInit.mock.calls[0][0] as { beforeSend: (e: unknown) => unknown };

        const minimal = {};
        expect(() => cfg.beforeSend(minimal)).not.toThrow();
        expect(cfg.beforeSend(minimal)).toBe(minimal);
    });
});
