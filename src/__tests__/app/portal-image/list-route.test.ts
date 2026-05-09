/**
 * PR-T1 Phase 3b — GET /api/portal/image/list handler tests.
 *
 * Mocks: getCurrentUser, prisma. Asserts cursor pagination, filter,
 * cross-user isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockFindMany = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        imageGeneration: {
            findMany: (...args: unknown[]) => mockFindMany(...args),
        },
    },
}));

vi.mock('@/lib/r2/client', () => ({
    getPublicUrl: (key: string) => `https://r2-stub/${key}`,
}));

import { GET } from '@/app/api/portal/image/list/route';

const USER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.restoreAllMocks();
});

function row(id: string, isFavorite = false) {
    return {
        id,
        prompt: 'p',
        model_name: 'gpt-image-2',
        size: '1024x1024',
        count: 1,
        r2_keys: [`image-gen/${USER.id}/${id}/0.png`],
        cost_usd: '0.060000',
        is_favorite: isFavorite,
        is_deleted: false,
        created_at: new Date('2026-05-09T00:00:00Z'),
        expires_at: null,
    };
}

function makeReq(query = ''): NextRequest {
    return new NextRequest(`http://internal/api/portal/image/list${query ? `?${query}` : ''}`);
}

describe('GET /api/portal/image/list — auth', () => {
    it('401 when no session', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(null);
        const res = await GET(makeReq());
        expect(res.status).toBe(401);
    });
});

describe('GET /api/portal/image/list — pagination', () => {
    it('returns up to limit + has_more flag when overflow', async () => {
        mockGetCurrentUser.mockResolvedValue(USER);
        // Take=limit+1 = 21 → 21 rows means there's a next page
        mockFindMany.mockResolvedValueOnce(
            Array.from({ length: 21 }, (_, i) =>
                row(`abcdef${i.toString().padStart(2, '0')}-1111-4111-8111-aaaaaaaaaaaa`),
            ),
        );

        const res = await GET(makeReq());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.items).toHaveLength(20);
        expect(body.has_more).toBe(true);
        expect(body.next_cursor).toBe(body.items[19].id);
    });

    it('honors a custom limit (clamped 1..50)', async () => {
        mockGetCurrentUser.mockResolvedValue(USER);
        mockFindMany.mockResolvedValueOnce([row('id1')]);

        await GET(makeReq('limit=5'));
        const args = mockFindMany.mock.calls[0][0];
        expect(args.take).toBe(6); // limit + 1
    });

    it('rejects invalid cursor (non-uuid)', async () => {
        mockGetCurrentUser.mockResolvedValue(USER);
        const res = await GET(makeReq('cursor=not-a-uuid'));
        expect(res.status).toBe(400);
    });
});

describe('GET /api/portal/image/list — filter', () => {
    it('default `all` does not filter by is_favorite', async () => {
        mockGetCurrentUser.mockResolvedValue(USER);
        mockFindMany.mockResolvedValueOnce([]);

        await GET(makeReq());
        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.is_favorite).toBeUndefined();
    });

    it('`favorite` filters where is_favorite=true', async () => {
        mockGetCurrentUser.mockResolvedValue(USER);
        mockFindMany.mockResolvedValueOnce([]);

        await GET(makeReq('filter=favorite'));
        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.is_favorite).toBe(true);
    });

    it('always filters where is_deleted=false', async () => {
        mockGetCurrentUser.mockResolvedValue(USER);
        mockFindMany.mockResolvedValueOnce([]);

        await GET(makeReq());
        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.is_deleted).toBe(false);
    });
});

describe('GET /api/portal/image/list — cross-user isolation', () => {
    it('always scopes by user.id (no cross-user leak vector)', async () => {
        mockGetCurrentUser.mockResolvedValue(USER);
        mockFindMany.mockResolvedValueOnce([]);

        await GET(makeReq('cursor=99999999-aaaa-4aaa-baaa-aaaaaaaaaaaa'));
        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.user_id).toBe(USER.id);
    });
});
