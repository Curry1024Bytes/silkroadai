/**
 * PR-T1 Phase 3 — in-memory rate-limiter unit tests.
 *
 * Sliding-window correctness: trim old timestamps before count check,
 * reject when at cap, admit + record otherwise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rateLimitCheck, _resetRateLimitForTest } from '@/lib/image-gen/rate-limit';

const USER_A = 'user-a';
const USER_B = 'user-b';

beforeEach(() => {
    _resetRateLimitForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T00:00:00Z'));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('rateLimitCheck — single user', () => {
    it('admits up to maxHits in a window and rejects the next', () => {
        for (let i = 0; i < 10; i++) {
            const r = rateLimitCheck(USER_A);
            expect(r.allowed).toBe(true);
            expect(r.remaining).toBe(9 - i);
        }
        const reject = rateLimitCheck(USER_A);
        expect(reject.allowed).toBe(false);
        expect(reject.remaining).toBe(0);
        expect(reject.retryAfterMs).toBeGreaterThanOrEqual(0);
    });

    it('admits after the window slides past the oldest hit', () => {
        for (let i = 0; i < 10; i++) {
            rateLimitCheck(USER_A);
        }
        // Advance just past the first hit's window
        vi.advanceTimersByTime(60_001);
        const r = rateLimitCheck(USER_A);
        expect(r.allowed).toBe(true);
    });

    it('rejection does NOT consume a slot', () => {
        for (let i = 0; i < 10; i++) rateLimitCheck(USER_A);
        const r1 = rateLimitCheck(USER_A);
        const r2 = rateLimitCheck(USER_A);
        // Both rejections; bucket size unchanged. After advancing time
        // 60s+1, exactly one slot should free up.
        expect(r1.allowed).toBe(false);
        expect(r2.allowed).toBe(false);

        vi.advanceTimersByTime(60_001);
        const admit = rateLimitCheck(USER_A);
        expect(admit.allowed).toBe(true);
        expect(admit.remaining).toBe(9); // 10 timestamps trimmed (all aged out) + 1 just admitted
    });
});

describe('rateLimitCheck — isolation', () => {
    it('different users have independent buckets', () => {
        for (let i = 0; i < 10; i++) rateLimitCheck(USER_A);
        const userARejected = rateLimitCheck(USER_A);
        const userBAdmitted = rateLimitCheck(USER_B);
        expect(userARejected.allowed).toBe(false);
        expect(userBAdmitted.allowed).toBe(true);
    });

    it('different scopes have independent buckets for the same user', () => {
        for (let i = 0; i < 10; i++) rateLimitCheck(USER_A, { scope: 'image_gen' });
        const sameScopeReject = rateLimitCheck(USER_A, { scope: 'image_gen' });
        const otherScopeOk = rateLimitCheck(USER_A, { scope: 'image_describe' });
        expect(sameScopeReject.allowed).toBe(false);
        expect(otherScopeOk.allowed).toBe(true);
    });
});

describe('rateLimitCheck — custom limits', () => {
    it('respects windowMs + maxHits overrides', () => {
        for (let i = 0; i < 3; i++) {
            const r = rateLimitCheck(USER_A, { maxHits: 3, windowMs: 1000 });
            expect(r.allowed).toBe(true);
        }
        expect(rateLimitCheck(USER_A, { maxHits: 3, windowMs: 1000 }).allowed).toBe(false);

        vi.advanceTimersByTime(1001);
        expect(rateLimitCheck(USER_A, { maxHits: 3, windowMs: 1000 }).allowed).toBe(true);
    });
});
