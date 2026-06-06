import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockFindMany = vi.fn();
const mockFindFirst = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
// Real tenant-scope so the where-wiring is exercised end-to-end.
vi.mock('@/lib/db', () => ({
    prisma: {
        catalogModel: {
            findMany: (...a: unknown[]) => mockFindMany(...a),
            findFirst: (...a: unknown[]) => mockFindFirst(...a),
            create: (...a: unknown[]) => mockCreate(...a),
            update: (...a: unknown[]) => mockUpdate(...a),
            delete: (...a: unknown[]) => mockDelete(...a),
        },
    },
}));

import { GET, POST } from '@/app/api/admin/models/route';
import { GET as GET_ID, PUT, DELETE } from '@/app/api/admin/models/[id]/route';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };
const PARTNER = { role: 'admin', tenant_id: 'tenant-7', user: { id: 'admin-1' }, viaBreakGlass: false };

function req(method = 'GET', body?: object, url = 'https://x/api/admin/models') {
    return new NextRequest(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
}
const params = (id = 'm1') => Promise.resolve({ id });

const VALID_CREATE = {
    slug: 'gpt-5.4',
    display_name: 'GPT-5.4',
    vendor: 'openai',
    upstream_map: { default: { channel_id: 3, upstream_model: 'gpt-5.4' } },
};

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(SUPERADMIN);
    mockFindMany.mockResolvedValue([]);
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockImplementation(({ data }: { data: object }) => Promise.resolve({ id: 'm1', ...data }));
    mockUpdate.mockImplementation(({ data }: { data: object }) => Promise.resolve({ id: 'm1', ...data }));
});

describe('GET /api/admin/models', () => {
    it('401 when not an admin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await GET(req())).status).toBe(401);
        expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('superadmin → no tenant filter; partner admin → tenant-scoped', async () => {
        await GET(req());
        expect(mockFindMany.mock.calls[0][0].where).not.toHaveProperty('tenant_id');

        mockResolveAdmin.mockResolvedValue(PARTNER);
        await GET(req());
        expect(mockFindMany.mock.calls[1][0].where.tenant_id).toBe('tenant-7');
    });
});

describe('POST /api/admin/models', () => {
    it('401 when not an admin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await POST(req('POST', VALID_CREATE))).status).toBe(401);
    });

    it('400 on invalid body (missing required fields)', async () => {
        expect((await POST(req('POST', { slug: 'x' }))).status).toBe(400);
    });

    it('409 on duplicate slug within tenant', async () => {
        mockFindFirst.mockResolvedValue({ id: 'existing', slug: 'gpt-5.4' });
        const res = await POST(req('POST', VALID_CREATE));
        expect(res.status).toBe(409);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('stamps tenant_id = platform tenant for superadmin', async () => {
        const res = await POST(req('POST', VALID_CREATE));
        expect(res.status).toBe(201);
        expect(mockCreate.mock.calls[0][0].data.tenant_id).toBe(PLATFORM_TENANT_ID);
        expect(mockCreate.mock.calls[0][0].data.slug).toBe('gpt-5.4');
    });

    it('stamps the partner admin tenant_id', async () => {
        mockResolveAdmin.mockResolvedValue(PARTNER);
        await POST(req('POST', VALID_CREATE));
        expect(mockCreate.mock.calls[0][0].data.tenant_id).toBe('tenant-7');
    });
});

describe('GET/PUT/DELETE /api/admin/models/[id]', () => {
    it('GET 404 when not found in tenant', async () => {
        mockFindFirst.mockResolvedValue(null);
        const res = await GET_ID(req('GET', undefined, 'https://x/api/admin/models/m1'), { params: params() });
        expect(res.status).toBe(404);
        // tenant scope joined the where
        expect(mockFindFirst.mock.calls[0][0].where).toHaveProperty('id', 'm1');
    });

    it('PUT updates a tenant-owned model (404 otherwise)', async () => {
        mockFindFirst.mockResolvedValue(null);
        expect(
            (await PUT(req('PUT', { display_name: 'X' }, 'https://x/api/admin/models/m1'), { params: params() }))
                .status,
        ).toBe(404);

        mockFindFirst.mockResolvedValue({ id: 'm1', slug: 'gpt-5.4' });
        const res = await PUT(req('PUT', { display_name: 'New Name' }, 'https://x/api/admin/models/m1'), {
            params: params(),
        });
        expect(res.status).toBe(200);
        expect(mockUpdate.mock.calls[0][0].data.display_name).toBe('New Name');
    });

    it('DELETE removes a tenant-owned model (404 otherwise)', async () => {
        mockFindFirst.mockResolvedValue({ id: 'm1' });
        mockDelete.mockResolvedValue(undefined);
        const res = await DELETE(req('DELETE', undefined, 'https://x/api/admin/models/m1'), { params: params() });
        expect(res.status).toBe(200);
        expect(mockDelete).toHaveBeenCalled();
    });
});
