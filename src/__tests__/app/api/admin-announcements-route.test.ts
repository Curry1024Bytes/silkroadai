/**
 * /api/admin/announcements{,/[id]} — superadmin 鉴权 + CRUD + zod 校验。
 * 镜像 admin-customers-route.test.ts 的 mock 套路(resolveAdmin / unauthorizedResponse / prisma)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockFindMany = vi.fn();
const mockCreate = vi.fn();
const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/lib/admin/auth', () => ({
    resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a),
}));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        announcement: {
            findMany: (...a: unknown[]) => mockFindMany(...a),
            create: (...a: unknown[]) => mockCreate(...a),
            findUnique: (...a: unknown[]) => mockFindUnique(...a),
            update: (...a: unknown[]) => mockUpdate(...a),
            delete: (...a: unknown[]) => mockDelete(...a),
        },
    },
}));

import { GET, POST } from '@/app/api/admin/announcements/route';
import { PUT, DELETE } from '@/app/api/admin/announcements/[id]/route';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };

const jsonReq = (url: string, method: string, body?: unknown) =>
    new NextRequest(`https://x${url}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([]);
    mockCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data }));
    mockFindUnique.mockResolvedValue({ id: 'a1' });
    mockUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'a1', ...data }));
    mockDelete.mockResolvedValue({ id: 'a1' });
});

describe('GET /api/admin/announcements', () => {
    it('401 when not superadmin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        const res = await GET(jsonReq('/api/admin/announcements', 'GET'));
        expect(res.status).toBe(401);
        expect(mockFindMany).not.toHaveBeenCalled();
    });
    it('superadmin → list desc', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        const res = await GET(jsonReq('/api/admin/announcements', 'GET'));
        expect(res.status).toBe(200);
        expect(mockResolveAdmin).toHaveBeenCalledWith(expect.anything(), 'superadmin');
        expect(mockFindMany.mock.calls[0][0].orderBy).toEqual({ created_at: 'desc' });
    });
});

describe('POST /api/admin/announcements', () => {
    it('401 when not superadmin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        const res = await POST(jsonReq('/api/admin/announcements', 'POST', { title: 'x' }));
        expect(res.status).toBe(401);
        expect(mockCreate).not.toHaveBeenCalled();
    });
    it('400 when title is empty', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        const res = await POST(jsonReq('/api/admin/announcements', 'POST', { title: '   ' }));
        expect(res.status).toBe(400);
        expect(mockCreate).not.toHaveBeenCalled();
    });
    it('400 when link_url is not http(s) — XSS guard (javascript: scheme)', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        const res = await POST(
            jsonReq('/api/admin/announcements', 'POST', { title: 'hi', link_url: 'javascript:alert(1)' }),
        );
        expect(res.status).toBe(400);
        expect(mockCreate).not.toHaveBeenCalled();
    });
    it('201 with defaults (level=info, is_active=true, empty link → null)', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        const res = await POST(jsonReq('/api/admin/announcements', 'POST', { title: '维护通知', body: 'x' }));
        expect(res.status).toBe(201);
        const data = mockCreate.mock.calls[0][0].data;
        expect(data).toMatchObject({
            title: '维护通知',
            level: 'info',
            is_active: true,
            link_url: null,
            link_label: null,
        });
    });
    it('accepts a valid https link + non-default level', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        const res = await POST(
            jsonReq('/api/admin/announcements', 'POST', {
                title: 'hi',
                link_url: 'https://silkroadai.io/pay',
                link_label: '去充值',
                level: 'critical',
            }),
        );
        expect(res.status).toBe(201);
        const data = mockCreate.mock.calls[0][0].data;
        expect(data).toMatchObject({
            link_url: 'https://silkroadai.io/pay',
            link_label: '去充值',
            level: 'critical',
        });
    });
});

describe('PUT /api/admin/announcements/[id]', () => {
    it('401 when not superadmin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        const res = await PUT(jsonReq('/api/admin/announcements/a1', 'PUT', { title: 'x' }), idCtx('a1'));
        expect(res.status).toBe(401);
    });
    it('404 when the announcement does not exist', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        mockFindUnique.mockResolvedValue(null);
        const res = await PUT(jsonReq('/api/admin/announcements/gone', 'PUT', { title: 'x' }), idCtx('gone'));
        expect(res.status).toBe(404);
        expect(mockUpdate).not.toHaveBeenCalled();
    });
    it('200 updates is_active (publish/unpublish path)', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        const res = await PUT(
            jsonReq('/api/admin/announcements/a1', 'PUT', { title: 'x', is_active: false }),
            idCtx('a1'),
        );
        expect(res.status).toBe(200);
        expect(mockUpdate.mock.calls[0][0].where).toEqual({ id: 'a1' });
        expect(mockUpdate.mock.calls[0][0].data.is_active).toBe(false);
    });
});

describe('DELETE /api/admin/announcements/[id]', () => {
    it('401 when not superadmin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        const res = await DELETE(jsonReq('/api/admin/announcements/a1', 'DELETE'), idCtx('a1'));
        expect(res.status).toBe(401);
        expect(mockDelete).not.toHaveBeenCalled();
    });
    it('200 deletes by id', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        const res = await DELETE(jsonReq('/api/admin/announcements/a1', 'DELETE'), idCtx('a1'));
        expect(res.status).toBe(200);
        expect(mockDelete.mock.calls[0][0].where).toEqual({ id: 'a1' });
    });
    it('404 when delete targets a missing id (P2025)', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        mockDelete.mockRejectedValue(new Error('P2025'));
        const res = await DELETE(jsonReq('/api/admin/announcements/gone', 'DELETE'), idCtx('gone'));
        expect(res.status).toBe(404);
    });
});
