/**
 * PR-T3 — POST /api/portal/analytics handler tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockCreate = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        analyticsEvent: {
            create: (...args: unknown[]) => mockCreate(...args),
        },
    },
}));

import { POST } from '@/app/api/portal/analytics/route';

const USER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };

beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({});
});

afterEach(() => {
    vi.restoreAllMocks();
});

function makeReq(body: unknown): NextRequest {
    return new NextRequest('http://internal/api/portal/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('POST /api/portal/analytics', () => {
    it('401 when no session', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(null);
        const r = await POST(makeReq({ event_type: 'image_favorited' }));
        expect(r.status).toBe(401);
    });

    it('400 on unknown event_type', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        const r = await POST(makeReq({ event_type: 'arbitrary_made_up_event' }));
        expect(r.status).toBe(400);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('200 + persists for whitelisted event types', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        const r = await POST(
            makeReq({
                event_type: 'image_favorited',
                properties: { generation_id: 'gen-id-1' },
            }),
        );
        expect(r.status).toBe(200);
        expect(mockCreate).toHaveBeenCalledTimes(1);
        const args = mockCreate.mock.calls[0][0];
        expect(args.data.user_id).toBe(USER.id);
        expect(args.data.event_type).toBe('image_favorited');
        expect(args.data.properties).toEqual({ generation_id: 'gen-id-1' });
    });

    it('drops oversized properties payload (>4KB) silently', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        const big: Record<string, string> = {};
        for (let i = 0; i < 200; i++) big[`field_${i}`] = 'x'.repeat(50);

        const r = await POST(makeReq({ event_type: 'model_selected', properties: big }));
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.dropped).toBe('properties_too_large');
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('does NOT throw when prisma create fails (best-effort)', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockCreate.mockRejectedValueOnce(new Error('DB down'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const r = await POST(makeReq({ event_type: 'image_favorited' }));
        expect(r.status).toBe(200); // route still returns ok
        expect(warnSpy).toHaveBeenCalled();

        warnSpy.mockRestore();
    });
});
