import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockFindMany = vi.fn();
const mockFindFirst = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockUpdateMany = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        channelGroup: {
            findMany: (...a: unknown[]) => mockFindMany(...a),
            findFirst: (...a: unknown[]) => mockFindFirst(...a),
            create: (...a: unknown[]) => mockCreate(...a),
            update: (...a: unknown[]) => mockUpdate(...a),
            delete: (...a: unknown[]) => mockDelete(...a),
            updateMany: (...a: unknown[]) => mockUpdateMany(...a),
        },
        // Invoke the callback with a tx whose channelGroup maps to the same mocks.
        $transaction: async (fn: (tx: unknown) => unknown) =>
            fn({
                channelGroup: {
                    updateMany: (...a: unknown[]) => mockUpdateMany(...a),
                    create: (...a: unknown[]) => mockCreate(...a),
                    update: (...a: unknown[]) => mockUpdate(...a),
                },
            }),
    },
}));

import { GET, POST } from '@/app/api/admin/channel-groups/route';
import { PUT, DELETE } from '@/app/api/admin/channel-groups/[id]/route';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };
const PARTNER = { role: 'admin', tenant_id: 'tenant-7', user: { id: 'a1' }, viaBreakGlass: false };
const VALID = { key: 'official', display_name: '官方稳定', newapi_group: 'official' };

function req(method = 'GET', body?: object, url = 'https://x/api/admin/channel-groups') {
    return new NextRequest(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
}
const params = (id = 'cg1') => Promise.resolve({ id });

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(SUPERADMIN);
    mockFindMany.mockResolvedValue([]);
    mockFindFirst.mockResolvedValue(null);
    mockUpdateMany.mockResolvedValue({ count: 0 });
    mockCreate.mockImplementation(({ data }: { data: object }) => Promise.resolve({ id: 'cg1', ...data }));
    mockUpdate.mockImplementation(({ data }: { data: object }) => Promise.resolve({ id: 'cg1', ...data }));
});

describe('GET /api/admin/channel-groups', () => {
    it('401 when not an admin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await GET(req())).status).toBe(401);
        expect(mockFindMany).not.toHaveBeenCalled();
    });
    it('superadmin → no tenant filter; partner → tenant-scoped', async () => {
        await GET(req());
        expect(mockFindMany.mock.calls[0][0].where).not.toHaveProperty('tenant_id');
        mockResolveAdmin.mockResolvedValue(PARTNER);
        await GET(req());
        expect(mockFindMany.mock.calls[1][0].where.tenant_id).toBe('tenant-7');
    });
});

describe('POST /api/admin/channel-groups', () => {
    it('401 when not an admin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await POST(req('POST', VALID))).status).toBe(401);
    });

    it('400 on invalid key (must be ^[a-z0-9-]+$)', async () => {
        expect((await POST(req('POST', { ...VALID, key: 'Official Tier!' }))).status).toBe(400);
    });

    it('409 on duplicate key within tenant', async () => {
        mockFindFirst.mockResolvedValue({ id: 'existing', key: 'official' });
        const res = await POST(req('POST', VALID));
        expect(res.status).toBe(409);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('stamps platform tenant for superadmin', async () => {
        const res = await POST(req('POST', VALID));
        expect(res.status).toBe(201);
        expect(mockCreate.mock.calls[0][0].data.tenant_id).toBe(PLATFORM_TENANT_ID);
        // not setting is_default → no clearing pass
        expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('enforces single default: is_default=true clears other defaults first', async () => {
        await POST(req('POST', { ...VALID, is_default: true }));
        expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { is_default: false } }));
        expect(mockCreate).toHaveBeenCalled();
    });

    it('rejects creating a disabled default tier', async () => {
        const res = await POST(req('POST', { ...VALID, is_default: true, enabled: false }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('default_tier_must_be_enabled');
        expect(mockCreate).not.toHaveBeenCalled();
    });
});

describe('PUT/DELETE /api/admin/channel-groups/[id]', () => {
    it('PUT 404 when not found in tenant', async () => {
        mockFindFirst.mockResolvedValue(null);
        const res = await PUT(req('PUT', { display_name: 'X' }, 'https://x/api/admin/channel-groups/cg1'), {
            params: params(),
        });
        expect(res.status).toBe(404);
    });

    it('PUT updates a tenant-owned group; setting default clears siblings', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'cg1',
            tenant_id: PLATFORM_TENANT_ID,
            key: 'official',
            is_default: false,
            enabled: true,
        });
        const res = await PUT(
            req('PUT', { is_default: true, display_name: '官方' }, 'https://x/api/admin/channel-groups/cg1'),
            {
                params: params(),
            },
        );
        expect(res.status).toBe(200);
        // clears other defaults for the same tenant, excluding self
        expect(mockUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ NOT: { id: 'cg1' } }),
                data: { is_default: false },
            }),
        );
        expect(mockUpdate).toHaveBeenCalled();
    });

    it.each([{ is_default: false }, { enabled: false }])(
        'PUT rejects removing the active default directly: %j',
        async (change) => {
            mockFindFirst.mockResolvedValue({
                id: 'cg1',
                tenant_id: PLATFORM_TENANT_ID,
                key: 'pool',
                is_default: true,
                enabled: true,
            });
            const res = await PUT(req('PUT', change, 'https://x/api/admin/channel-groups/cg1'), { params: params() });
            expect(res.status).toBe(409);
            expect((await res.json()).error).toMatch(/active_default_tier_required|default_tier_must_be_enabled/);
            expect(mockUpdate).not.toHaveBeenCalled();
        },
    );

    it('DELETE rejects the active default until another tier becomes default', async () => {
        mockFindFirst.mockResolvedValue({ id: 'cg1', key: 'pool', is_default: true, enabled: true });
        const res = await DELETE(req('DELETE', undefined, 'https://x/api/admin/channel-groups/cg1'), {
            params: params(),
        });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('active_default_tier_required');
        expect(mockDelete).not.toHaveBeenCalled();
    });

    it('DELETE 404 when not found, else removes the tenant-owned group', async () => {
        mockFindFirst.mockResolvedValue(null);
        expect(
            (await DELETE(req('DELETE', undefined, 'https://x/api/admin/channel-groups/cg1'), { params: params() }))
                .status,
        ).toBe(404);

        mockFindFirst.mockResolvedValue({ id: 'cg1', key: 'official' });
        mockDelete.mockResolvedValue(undefined);
        const res = await DELETE(req('DELETE', undefined, 'https://x/api/admin/channel-groups/cg1'), {
            params: params(),
        });
        expect(res.status).toBe(200);
        expect(mockDelete).toHaveBeenCalled();
    });
});
