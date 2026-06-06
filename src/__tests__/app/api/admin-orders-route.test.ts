import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockFindMany = vi.fn();
const mockCount = vi.fn();
const mockFindFirst = vi.fn();

vi.mock('@/lib/admin/auth', () => ({
    resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a),
}));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
// Use the REAL tenant-scope helper so the where-clause wiring is exercised end-to-end.
vi.mock('@/lib/db', () => ({
    prisma: {
        order: {
            findMany: (...a: unknown[]) => mockFindMany(...a),
            count: (...a: unknown[]) => mockCount(...a),
            findFirst: (...a: unknown[]) => mockFindFirst(...a),
        },
    },
}));

import { GET } from '@/app/api/admin/orders/route';
import { GET as GET_DETAIL } from '@/app/api/admin/orders/[id]/route';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };
const PARTNER_ADMIN = { role: 'admin', tenant_id: 'tenant-7', user: {}, viaBreakGlass: false };

function req(url = 'https://x/api/admin/orders') {
    return new NextRequest(url);
}

beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);
    mockFindFirst.mockResolvedValue(null);
});

describe('GET /api/admin/orders — cookie auth + tenant scope', () => {
    it('returns 401 (and never queries) when resolveAdmin is null', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        const res = await GET(req());
        expect(res.status).toBe(401);
        expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('superadmin → where carries NO tenant_id (sees all tenants)', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        const res = await GET(req());
        expect(res.status).toBe(200);
        const where = mockFindMany.mock.calls[0][0].where;
        expect(where).not.toHaveProperty('tenant_id');
    });

    it('partner admin → where filtered to their tenant_id', async () => {
        mockResolveAdmin.mockResolvedValue(PARTNER_ADMIN);
        await GET(req());
        expect(mockFindMany.mock.calls[0][0].where.tenant_id).toBe('tenant-7');
    });

    it('admin with null tenant_id → falls back to the platform tenant', async () => {
        mockResolveAdmin.mockResolvedValue({ ...PARTNER_ADMIN, tenant_id: null });
        await GET(req());
        expect(mockFindMany.mock.calls[0][0].where.tenant_id).toBe(PLATFORM_TENANT_ID);
    });
});

describe('GET /api/admin/orders/[id] — tenant-scoped findFirst', () => {
    function detailReq() {
        return req('https://x/api/admin/orders/o1');
    }
    const params = () => Promise.resolve({ id: 'o1' });

    it('returns 401 when not authorized', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        const res = await GET_DETAIL(detailReq(), { params: params() });
        expect(res.status).toBe(401);
    });

    it('superadmin → findFirst where = { id } only', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        const res = await GET_DETAIL(detailReq(), { params: params() });
        expect(res.status).toBe(404); // findFirst mocked → null
        const where = mockFindFirst.mock.calls[0][0].where;
        expect(where.id).toBe('o1');
        expect(where).not.toHaveProperty('tenant_id');
    });

    it('partner admin → findFirst where includes tenant_id', async () => {
        mockResolveAdmin.mockResolvedValue(PARTNER_ADMIN);
        await GET_DETAIL(detailReq(), { params: params() });
        expect(mockFindFirst.mock.calls[0][0].where).toMatchObject({ id: 'o1', tenant_id: 'tenant-7' });
    });
});
