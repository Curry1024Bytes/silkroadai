/**
 * W4-2 D7 — getCurrentUser dedup via React.cache().
 *
 * `cache()` from React 19 only memoizes inside a server-component render
 * context. Outside (e.g. in a vitest worker) it's a no-op pass-through. So
 * we can't directly assert "1 DB read for 2 calls" — we'd need a real
 * Next.js render harness for that.
 *
 * Instead the test surface here is split:
 *   1. Behavioral: the public function still returns correct results across
 *      typical scenarios (no cookie / valid / invalid jwt / tv mismatch).
 *      These pass regardless of whether dedup is active.
 *   2. Structural: assert the source actually wraps the inner work in
 *      `cache()` so the dedup IS active at runtime. If a refactor accidentally
 *      drops the wrap, this test fails loudly even though the behavioral
 *      tests would still pass.
 *
 * The actual N+1 elimination is observed in production via reduced DB row
 * counts; for unit-test infrastructure we settle for the structural pin.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const mockUserFindUnique = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        user: {
            findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
        },
    },
}));

const mockVerifySession = vi.fn();
vi.mock('@/lib/auth/jwt', async (importActual) => {
    const actual = await importActual<typeof import('@/lib/auth/jwt')>();
    return {
        ...actual,
        verifySession: (...args: unknown[]) => mockVerifySession(...args),
    };
});

import { getCurrentUser } from '@/lib/auth/session';

const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeReq(cookieValue: string | null): NextRequest {
    const headers: Record<string, string> = cookieValue ? { cookie: `silkroad_session=${cookieValue}` } : {};
    return new NextRequest('http://localhost/internal', { method: 'GET', headers });
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('getCurrentUser — behavioral (cache() impact transparent)', () => {
    it('returns user when cookie + jwt + tv all valid', async () => {
        mockVerifySession.mockResolvedValue({ userId: PORTAL_USER_ID, tokenVersion: 1 });
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'happy@llmroute.club',
            session_token_version: 1,
        });

        const u = await getCurrentUser(makeReq('jwt-aaa'));
        expect(u?.id).toBe(PORTAL_USER_ID);
    });

    it('no cookie → returns null without verifying or hitting DB', async () => {
        const u = await getCurrentUser(makeReq(null));
        expect(u).toBeNull();
        expect(mockVerifySession).not.toHaveBeenCalled();
        expect(mockUserFindUnique).not.toHaveBeenCalled();
    });

    it('invalid jwt → returns null, no DB read', async () => {
        mockVerifySession.mockResolvedValue(null);
        const u = await getCurrentUser(makeReq('garbage-jwt'));
        expect(u).toBeNull();
        expect(mockVerifySession).toHaveBeenCalledTimes(1);
        expect(mockUserFindUnique).not.toHaveBeenCalled();
    });

    it('tv mismatch → returns null even if user exists', async () => {
        mockVerifySession.mockResolvedValue({ userId: PORTAL_USER_ID, tokenVersion: 1 });
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            session_token_version: 2, // bumped since this jwt was issued
        });

        const u = await getCurrentUser(makeReq('jwt-stale'));
        expect(u).toBeNull();
    });

    it('user not found → null', async () => {
        mockVerifySession.mockResolvedValue({ userId: 'ghost', tokenVersion: 1 });
        mockUserFindUnique.mockResolvedValue(null);

        const u = await getCurrentUser(makeReq('jwt-ghost'));
        expect(u).toBeNull();
    });
});

describe('getCurrentUser — structural cache() pin (dedup runs in production)', () => {
    it('source wraps the inner verify+lookup in React.cache()', () => {
        const source = readFileSync(join(process.cwd(), 'src/lib/auth/session.ts'), 'utf-8');
        // cache imported from react
        expect(source).toMatch(/import\s*{[^}]*\bcache\b/);
        // cache(...) actually invoked
        expect(source).toMatch(/cache\s*\(/);
        // The wrapped helper is keyed by the cookie value (so layout + page
        // sharing the same session collapse to one DB read at render time).
        expect(source).toMatch(/cookieValue/);
    });
});
