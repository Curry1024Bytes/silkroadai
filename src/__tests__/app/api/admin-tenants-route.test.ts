import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockFindMany = vi.fn();
const mockFindUnique = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        tenant: {
            findMany: (...a: unknown[]) => mockFindMany(...a),
            findUnique: (...a: unknown[]) => mockFindUnique(...a),
            create: (...a: unknown[]) => mockCreate(...a),
            update: (...a: unknown[]) => mockUpdate(...a),
        },
    },
}));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => ({ get: () => null })) }));

import { GET, POST } from '@/app/api/admin/tenants/route';
import { GET as GET_ID, PUT } from '@/app/api/admin/tenants/[id]/route';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };

function req(method = 'GET', body?: object, url = 'https://x/api/admin/tenants') {
    return new NextRequest(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
}
const params = (id = 't1') => Promise.resolve({ id });

const VALID = { slug: 'acme', brand_name: 'Acme', domains: ['Acme.com', 'ACME.com:443', 'www.acme.com'] };

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(SUPERADMIN);
    mockFindMany.mockResolvedValue([]);
    mockFindUnique.mockResolvedValue(null);
    mockCreate.mockImplementation(({ data }: { data: object }) => Promise.resolve({ id: 't-new', ...data }));
    mockUpdate.mockImplementation(({ data }: { data: object }) => Promise.resolve({ id: 't1', ...data }));
});

describe('GET /api/admin/tenants — superadmin only', () => {
    it('401 when resolveAdmin(superadmin) is null (non-superadmin)', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await GET(req())).status).toBe(401);
        expect(mockFindMany).not.toHaveBeenCalled();
    });
    it('superadmin → lists tenants', async () => {
        mockFindMany.mockResolvedValue([{ id: 't1', slug: 'silkroadai' }]);
        const res = await GET(req());
        expect(res.status).toBe(200);
        expect((await res.json()).tenants).toHaveLength(1);
    });
});

describe('POST /api/admin/tenants — create partner', () => {
    it('401 non-superadmin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await POST(req('POST', VALID))).status).toBe(401);
    });

    it('creates with normalized + deduped domains; primary_color omitted → schema default', async () => {
        const res = await POST(req('POST', VALID));
        expect(res.status).toBe(201);
        const data = mockCreate.mock.calls[0][0].data;
        expect(data.slug).toBe('acme');
        expect(data.domains).toEqual(['acme.com', 'www.acme.com']); // lowercased, port-stripped, deduped
        expect(data.primary_color).toBeUndefined(); // → Prisma default #1E3A8A
        expect(data.signup_enabled).toBe(true);
        expect(data.status).toBe('active');
    });

    it('409 on duplicate slug', async () => {
        mockFindUnique.mockResolvedValue({ id: 'existing' });
        expect((await POST(req('POST', VALID))).status).toBe(409);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('400 on bad slug / bad color', async () => {
        expect((await POST(req('POST', { slug: 'Acme!', brand_name: 'X' }))).status).toBe(400);
        expect((await POST(req('POST', { slug: 'acme', brand_name: 'X', primary_color: 'red' }))).status).toBe(400);
    });
});

describe('GET/PUT /api/admin/tenants/[id]', () => {
    it('PUT 401 non-superadmin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        const res = await PUT(req('PUT', { brand_name: 'X' }, 'https://x/api/admin/tenants/t1'), { params: params() });
        expect(res.status).toBe(401);
    });

    it('PUT 404 when tenant missing', async () => {
        mockFindUnique.mockResolvedValue(null);
        const res = await PUT(req('PUT', { brand_name: 'X' }, 'https://x/api/admin/tenants/t1'), { params: params() });
        expect(res.status).toBe(404);
    });

    it('PUT updates brand/status/domains; slug is ignored (immutable)', async () => {
        mockFindUnique.mockResolvedValue({ id: 't1' });
        const res = await PUT(
            req(
                'PUT',
                { brand_name: 'New', status: 'suspended', domains: ['B.com'], slug: 'hacked' },
                'https://x/api/admin/tenants/t1',
            ),
            { params: params() },
        );
        expect(res.status).toBe(200);
        const data = mockUpdate.mock.calls[0][0].data;
        expect(data.brand_name).toBe('New');
        expect(data.status).toBe('suspended');
        expect(data.domains).toEqual(['b.com']);
        expect(data).not.toHaveProperty('slug'); // immutable
    });

    it('GET_ID 404 when missing', async () => {
        mockFindUnique.mockResolvedValue(null);
        const res = await GET_ID(req('GET', undefined, 'https://x/api/admin/tenants/t1'), { params: params() });
        expect(res.status).toBe(404);
    });
});
