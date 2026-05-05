/**
 * W6 D2 — POST /api/portal/balance-alert-threshold tests.
 *
 * Cookie-session auth, zod validated body, prisma.user.update on the
 * authenticated user. Tests confirm:
 *   - 401 when no session
 *   - 200 + persisted value on valid 0..1000 integer
 *   - 400 on out-of-range / non-integer / wrong shape
 *   - prisma.user.update called with the session user id (no IDOR — body
 *     has no `user_id` to spoof)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockUserUpdate = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        user: {
            update: (...args: unknown[]) => mockUserUpdate(...args),
        },
    },
}));

import { POST } from '@/app/api/portal/balance-alert-threshold/route';

const USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeReq(body: unknown): NextRequest {
    return new NextRequest('http://internal/api/portal/balance-alert-threshold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockUserUpdate.mockResolvedValue({ id: USER_ID });
});

describe('POST /api/portal/balance-alert-threshold', () => {
    it('returns 401 when no session', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        const r = await POST(makeReq({ threshold: 50 }));
        expect(r.status).toBe(401);
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('returns 200 + persists threshold for the authenticated user', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: USER_ID, email: 'a@x.io' });
        const r = await POST(makeReq({ threshold: 50 }));
        expect(r.status).toBe(200);
        const data = (await r.json()) as { threshold: number };
        expect(data.threshold).toBe(50);
        expect(mockUserUpdate).toHaveBeenCalledWith({
            where: { id: USER_ID },
            data: { balance_alert_threshold_cny: expect.any(Prisma.Decimal) },
        });
        // Decimal value matches
        const args = mockUserUpdate.mock.calls[0][0] as {
            data: { balance_alert_threshold_cny: Prisma.Decimal };
        };
        expect(args.data.balance_alert_threshold_cny.toNumber()).toBe(50);
    });

    it('threshold=0 (opt-out) is accepted and persisted', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: USER_ID, email: 'a@x.io' });
        const r = await POST(makeReq({ threshold: 0 }));
        expect(r.status).toBe(200);
        const args = mockUserUpdate.mock.calls[0][0] as {
            data: { balance_alert_threshold_cny: Prisma.Decimal };
        };
        expect(args.data.balance_alert_threshold_cny.toNumber()).toBe(0);
    });

    it('threshold=1000 (upper bound) is accepted', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: USER_ID, email: 'a@x.io' });
        const r = await POST(makeReq({ threshold: 1000 }));
        expect(r.status).toBe(200);
    });

    it('returns 400 on threshold > 1000', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: USER_ID, email: 'a@x.io' });
        const r = await POST(makeReq({ threshold: 1001 }));
        expect(r.status).toBe(400);
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('returns 400 on negative threshold', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: USER_ID, email: 'a@x.io' });
        const r = await POST(makeReq({ threshold: -1 }));
        expect(r.status).toBe(400);
    });

    it('returns 400 on non-integer threshold (zod int rule)', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: USER_ID, email: 'a@x.io' });
        const r = await POST(makeReq({ threshold: 12.5 }));
        expect(r.status).toBe(400);
    });

    it('returns 400 on missing threshold', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: USER_ID, email: 'a@x.io' });
        const r = await POST(makeReq({ wrong_field: 50 }));
        expect(r.status).toBe(400);
    });

    it('returns 400 on invalid json', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: USER_ID, email: 'a@x.io' });
        const req = new NextRequest('http://internal/api/portal/balance-alert-threshold', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{not json}',
        });
        const r = await POST(req);
        expect(r.status).toBe(400);
    });

    it('IDOR-safe: prisma.user.update WHERE clause uses the session user id, not the body', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: USER_ID, email: 'a@x.io' });
        // Inject a stray user_id in the body to confirm the route ignores it
        const r = await POST(makeReq({ threshold: 25, user_id: 'evil-other-user' }));
        expect(r.status).toBe(200);
        const args = mockUserUpdate.mock.calls[0][0] as { where: { id: string } };
        expect(args.where.id).toBe(USER_ID);
        expect(args.where.id).not.toBe('evil-other-user');
    });
});
