/**
 * PR-T1 Phase 3b — GET / DELETE /api/portal/image/[id] +
 * PATCH /api/portal/image/[id]/favorite handler tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockFindFirst = vi.fn();
const mockUpdate = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        imageGeneration: {
            findFirst: (...args: unknown[]) => mockFindFirst(...args),
            update: (...args: unknown[]) => mockUpdate(...args),
        },
    },
}));

vi.mock('@/lib/r2/client', () => ({
    getPublicUrl: (key: string) => `https://r2-stub/${key}`,
}));

import { GET, DELETE } from '@/app/api/portal/image/[id]/route';
import { PATCH } from '@/app/api/portal/image/[id]/favorite/route';

const USER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
const ID = 'cccccccc-1234-4111-8111-cccccccccccc';

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.restoreAllMocks();
});

function reqGet(): NextRequest {
    return new NextRequest(`http://internal/api/portal/image/${ID}`);
}
function reqDelete(): NextRequest {
    return new NextRequest(`http://internal/api/portal/image/${ID}`, { method: 'DELETE' });
}
function reqPatch(body: unknown): NextRequest {
    return new NextRequest(`http://internal/api/portal/image/${ID}/favorite`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const ctx = { params: Promise.resolve({ id: ID }) };

function row(overrides: Record<string, unknown> = {}) {
    return {
        id: ID,
        user_id: USER.id,
        prompt: 'a cat',
        model_name: 'gpt-image-2',
        size: '1024x1024',
        count: 1,
        r2_keys: [`image-gen/${USER.id}/${ID}/0.png`],
        cost_usd: '0.060000',
        is_favorite: false,
        is_deleted: false,
        created_at: new Date('2026-05-09T00:00:00Z'),
        expires_at: new Date('2026-06-08T00:00:00Z'),
        ...overrides,
    };
}

describe('GET /api/portal/image/[id] — auth + ownership', () => {
    it('401 when no session', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(null);
        const res = await GET(reqGet(), ctx);
        expect(res.status).toBe(401);
    });

    it('400 on non-uuid id', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        const res = await GET(reqGet(), { params: Promise.resolve({ id: 'not-uuid' }) });
        expect(res.status).toBe(400);
    });

    it('404 when row exists but belongs to another user (no leak)', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockFindFirst.mockResolvedValueOnce(null); // findFirst with user_id filter returns null
        const res = await GET(reqGet(), ctx);
        expect(res.status).toBe(404);
    });

    it('200 with image_urls when owned', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockFindFirst.mockResolvedValueOnce(row());
        const res = await GET(reqGet(), ctx);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.id).toBe(ID);
        expect(body.image_urls).toHaveLength(1);
        expect(body.image_urls[0]).toContain(`image-gen/${USER.id}/${ID}/0.png`);
    });

    it('always filters where is_deleted=false (soft-deleted hidden)', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockFindFirst.mockResolvedValueOnce(null);
        await GET(reqGet(), ctx);
        const where = mockFindFirst.mock.calls[0][0].where;
        expect(where.is_deleted).toBe(false);
        expect(where.user_id).toBe(USER.id);
    });
});

describe('DELETE /api/portal/image/[id] — soft delete', () => {
    it('marks is_deleted=true and returns ok', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockFindFirst.mockResolvedValueOnce(row());
        mockUpdate.mockResolvedValueOnce({ id: ID, is_deleted: true });

        const res = await DELETE(reqDelete(), ctx);
        expect(res.status).toBe(200);
        expect(mockUpdate).toHaveBeenCalledWith({
            where: { id: ID },
            data: { is_deleted: true },
        });
    });

    it('404 when not owned', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockFindFirst.mockResolvedValueOnce(null);
        const res = await DELETE(reqDelete(), ctx);
        expect(res.status).toBe(404);
        expect(mockUpdate).not.toHaveBeenCalled();
    });
});

describe('PATCH /api/portal/image/[id]/favorite — toggle', () => {
    it('flipping to true sets expires_at=null (永久)', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockFindFirst.mockResolvedValueOnce(row());
        mockUpdate.mockResolvedValueOnce({ id: ID, is_favorite: true, expires_at: null });

        const res = await PATCH(reqPatch({ is_favorite: true }), ctx);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.is_favorite).toBe(true);
        expect(body.expires_at).toBeNull();

        const data = mockUpdate.mock.calls[0][0].data;
        expect(data.is_favorite).toBe(true);
        expect(data.expires_at).toBeNull();
    });

    it('flipping to false picks the later of (created+30d, now+30d)', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        const oldRow = row({
            // Created Day 0; now we're at Day 5; un-favoriting → expires_at = max(Day 30, Day 35) = Day 35
            created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
            is_favorite: true,
        });
        mockFindFirst.mockResolvedValueOnce(oldRow);
        mockUpdate.mockResolvedValueOnce({
            id: ID,
            is_favorite: false,
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });

        await PATCH(reqPatch({ is_favorite: false }), ctx);

        const data = mockUpdate.mock.calls[0][0].data;
        expect(data.is_favorite).toBe(false);
        expect(data.expires_at).not.toBeNull();
        const expiresAt = (data.expires_at as Date).getTime();
        const expected = Date.now() + 30 * 24 * 60 * 60 * 1000;
        expect(Math.abs(expiresAt - expected)).toBeLessThan(1000);
    });

    it('400 on missing is_favorite field', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        const res = await PATCH(reqPatch({}), ctx);
        expect(res.status).toBe(400);
    });

    it('404 when not owned', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockFindFirst.mockResolvedValueOnce(null);
        const res = await PATCH(reqPatch({ is_favorite: true }), ctx);
        expect(res.status).toBe(404);
    });
});
