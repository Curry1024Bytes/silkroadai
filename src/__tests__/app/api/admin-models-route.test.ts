import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCatalogGuard = vi.fn();
vi.mock('@/lib/admin/pricing-publish-lock', async () => ({
    ...(await vi.importActual<typeof import('@/lib/admin/pricing-publish-lock')>('@/lib/admin/pricing-publish-lock')),
    assertPricingCatalogWritable: (...args: unknown[]) => mockCatalogGuard(...args),
}));
import { PricingPublishError } from '@/lib/admin/pricing-publish-lock';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockFindMany = vi.fn();
const mockGroupFindMany = vi.fn();
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
        channelGroup: { findMany: (...a: unknown[]) => mockGroupFindMany(...a) },
        $transaction: async (fn: (tx: unknown) => unknown) =>
            fn({
                catalogModel: {
                    findMany: (...a: unknown[]) => mockFindMany(...a),
                    findFirst: (...a: unknown[]) => mockFindFirst(...a),
                    create: (...a: unknown[]) => mockCreate(...a),
                    update: (...a: unknown[]) => mockUpdate(...a),
                    delete: (...a: unknown[]) => mockDelete(...a),
                },
                channelGroup: { findMany: (...a: unknown[]) => mockGroupFindMany(...a) },
            }),
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
    upstream_map: { pool: { channel_id: 3, upstream_model: 'gpt-5.4' } },
};

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(SUPERADMIN);
    mockFindMany.mockResolvedValue([]);
    mockGroupFindMany.mockResolvedValue([
        {
            key: 'pool',
            newapi_group: 'default',
            newapi_channel_ids: [3],
            is_default: true,
            enabled: true,
            tier_level: 0,
        },
    ]);
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

    it('rejects an enabled model whose tier/channel mapping is not in the active topology', async () => {
        const res = await POST(
            req('POST', {
                ...VALID_CREATE,
                upstream_map: { ghost: { channel_id: 3, upstream_model: 'gpt-5.4' } },
            }),
        );
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('channel_group_topology_invalid');
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('allows a disabled draft model with an empty upstream map', async () => {
        const res = await POST(req('POST', { ...VALID_CREATE, enabled: false, upstream_map: {} }));
        expect(res.status).toBe(201);
        expect(mockCreate).toHaveBeenCalled();
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

        mockFindFirst.mockResolvedValue({
            id: 'm1',
            tenant_id: PLATFORM_TENANT_ID,
            slug: 'gpt-5.4',
            enabled: true,
            upstream_map: VALID_CREATE.upstream_map,
        });
        const res = await PUT(req('PUT', { display_name: 'New Name' }, 'https://x/api/admin/models/m1'), {
            params: params(),
        });
        expect(res.status).toBe(200);
        expect(mockUpdate.mock.calls[0][0].data.display_name).toBe('New Name');
    });

    it('PUT rejects moving an enabled model onto a channel owned by another tier', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'm1',
            tenant_id: PLATFORM_TENANT_ID,
            slug: 'gpt-5.4',
            enabled: true,
            upstream_map: VALID_CREATE.upstream_map,
        });
        const res = await PUT(
            req(
                'PUT',
                { upstream_map: { pool: { channel_id: 99, upstream_model: 'gpt-5.4' } } },
                'https://x/api/admin/models/m1',
            ),
            { params: params() },
        );
        expect(res.status).toBe(409);
        expect((await res.json()).issues).toContainEqual({
            code: 'channel_not_owned_by_tier',
            tier: 'pool',
            channel_id: 99,
            owner: null,
        });
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('DELETE removes a tenant-owned model (404 otherwise)', async () => {
        mockFindFirst.mockResolvedValue({ id: 'm1' });
        mockDelete.mockResolvedValue(undefined);
        const res = await DELETE(req('DELETE', undefined, 'https://x/api/admin/models/m1'), { params: params() });
        expect(res.status).toBe(200);
        expect(mockDelete).toHaveBeenCalled();
    });
});

it.each(['create', 'update', 'delete'])(
    'blocks model %s before reading or writing while a price publication is active',
    async (operation) => {
        mockCatalogGuard.mockRejectedValueOnce(new PricingPublishError('pricing_publish_busy', 'busy'));
        const response =
            operation === 'create'
                ? await POST(req('POST', VALID_CREATE))
                : operation === 'update'
                  ? await PUT(req('PUT', { display_name: 'New' }), { params: params() })
                  : await DELETE(req('DELETE'), { params: params() });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: 'pricing_publish_busy' });
        expect(mockFindFirst).not.toHaveBeenCalled();
        expect(mockCreate).not.toHaveBeenCalled();
        expect(mockUpdate).not.toHaveBeenCalled();
        expect(mockDelete).not.toHaveBeenCalled();
    },
);

it.each(['P2028', 'P2034'])('returns a retriable 409 for transaction barrier %s instead of a 500', async (code) => {
    mockCatalogGuard.mockRejectedValueOnce(Object.assign(new Error('transaction coordination failed'), { code }));
    const response = await POST(req('POST', VALID_CREATE));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'catalog_write_busy' });
    expect(mockCreate).not.toHaveBeenCalled();
});
