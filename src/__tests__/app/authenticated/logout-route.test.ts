/**
 * W4-2 D4 — POST /api/auth/logout endpoint
 */
import { describe, expect, it } from 'vitest';
import { POST } from '@/app/api/auth/logout/route';

describe('POST /api/auth/logout', () => {
    it('returns 200 + body { ok: true }', async () => {
        const res = await POST();
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ ok: true });
    });

    it('sets Set-Cookie clearing silkroad_session (httpOnly + maxAge=0)', async () => {
        const res = await POST();
        const cookies = res.headers.getSetCookie();
        const sessionLine = cookies.find((c) => c.startsWith('silkroad_session='))!;
        expect(sessionLine).toBeDefined();
        // Empty value + Max-Age=0 (or expired Expires) tells the browser to drop it
        expect(sessionLine).toMatch(/silkroad_session=;/);
        expect(sessionLine).toMatch(/Max-Age=0/i);
        expect(sessionLine).toMatch(/HttpOnly/i);
        expect(sessionLine).toMatch(/SameSite=lax/i);
        expect(sessionLine).toMatch(/Path=\//i);
    });

    it('idempotent: a second call without any cookie still 200s and re-emits the clear header', async () => {
        // The endpoint doesn't read the request — there's nothing to short-
        // circuit on. Confirms "no-op for already-logged-out" path.
        const a = await POST();
        const b = await POST();
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(b.headers.getSetCookie().some((c) => c.startsWith('silkroad_session='))).toBe(true);
    });
});
