/**
 * fix/resend-verification-empty-body — UnverifiedBanner sends email in body.
 *
 * Regression test for the PR-U2 → 2026-05-12 incident: client was POSTing
 * with no body to /api/auth/resend-verification, server schema requires
 * `email`, so every "重发验证邮件" click returned 400 invalid_input.
 *
 * Tests the exported callResendVerification helper directly (the function
 * the component's onClick handler invokes), so we exercise the actual
 * request shape — not a parallel replay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { UnverifiedBanner, callResendVerification } from '@/app/(authenticated)/unverified-banner';

const TEST_EMAIL = 'happy@silkroadai.io';

describe('<UnverifiedBanner /> SSR smoke', () => {
    it('renders the soft-block copy + 重发验证邮件 button', () => {
        const html = renderToString(<UnverifiedBanner email={TEST_EMAIL} />);
        expect(html).toContain('邮箱未验证');
        expect(html).toContain('重发验证邮件');
        // Email shouldn't leak into rendered HTML — it's only used in the
        // fetch body. Defensive: stale prefill of an old layout pattern
        // could accidentally put it in a hidden input or data attr.
        expect(html).not.toContain(TEST_EMAIL);
    });
});

describe('callResendVerification request shape (the actual bug fix)', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;
    let originalFetch: typeof globalThis.fetch | undefined;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
        globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    });
    afterEach(() => {
        if (originalFetch) globalThis.fetch = originalFetch;
    });

    it('POSTs to the right endpoint with a JSON body containing email', async () => {
        const r = await callResendVerification(TEST_EMAIL);
        expect(r.ok).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/auth/resend-verification');
        expect(init.method).toBe('POST');
        // Critical regression check: body MUST exist + contain email.
        // The 2026-05-12 incident was caused by this being undefined.
        expect(init.body).toBeTruthy();
        const parsed = JSON.parse(init.body as string);
        expect(parsed.email).toBe(TEST_EMAIL);
    });

    it('sets Content-Type: application/json (else server cannot parse body)', async () => {
        await callResendVerification(TEST_EMAIL);
        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const headers = init.headers as Record<string, string>;
        expect(headers['Content-Type']).toBe('application/json');
    });

    it('credentials: same-origin (forwards session cookie for future session-aware backend)', async () => {
        await callResendVerification(TEST_EMAIL);
        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(init.credentials).toBe('same-origin');
    });

    it('on 400 invalid_input → returns { ok: false, error: "invalid_input" } from body', async () => {
        fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_input' }), { status: 400 }));
        const r = await callResendVerification(TEST_EMAIL);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('invalid_input');
    });

    it('on non-JSON error response → falls back to "请求失败 (status)" message', async () => {
        fetchSpy.mockResolvedValueOnce(new Response('not json', { status: 500 }));
        const r = await callResendVerification(TEST_EMAIL);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('500');
    });
});
