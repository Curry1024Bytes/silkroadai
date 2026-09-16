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
const mockFindFirst = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockUpdateMany = vi.fn();
const mockCatalogFindMany = vi.fn();
const mockKeyFindFirst = vi.fn();

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
        catalogModel: {
            findMany: (...a: unknown[]) => mockCatalogFindMany(...a),
        },
        // Invoke the callback with a tx whose channelGroup maps to the same mocks.
        $transaction: async (fn: (tx: unknown) => unknown) =>
            fn({
                newApiToken: { findFirst: (...a: unknown[]) => mockKeyFindFirst(...a) },
                catalogModel: { findMany: (...a: unknown[]) => mockCatalogFindMany(...a) },
                channelGroup: {
                    findMany: (...a: unknown[]) => mockFindMany(...a),
                    findFirst: (...a: unknown[]) => mockFindFirst(...a),
                    delete: (...a: unknown[]) => mockDelete(...a),
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
const VALID = { key: 'official', display_name: '官方稳定', newapi_group: 'official', newapi_channel_ids: [8] };

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
    mockCatalogFindMany.mockResolvedValue([]);
    mockKeyFindFirst.mockResolvedValue(null);
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
        const response = await POST(req('POST', { ...VALID, key: 'Official Tier!' }));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
            error: 'invalid_input',
            issues: { key: ['只能使用小写字母、数字和连字符；也可以留空自动生成'] },
        });
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it.each([undefined, '', '   '])('generates a key when the manual key is %j', async (key) => {
        const response = await POST(req('POST', { ...VALID, key, newapi_group: 'CCMax（支持外接）' }));
        expect(response.status).toBe(201);
        expect((await response.json()).group).toMatchObject({
            key: expect.stringMatching(/^ccmax-[a-f0-9]{10}$/),
            newapi_group: 'CCMax（支持外接）',
            enabled: false,
        });
        expect(mockFindMany).toHaveBeenCalledWith({ where: { tenant_id: PLATFORM_TENANT_ID }, select: { key: true } });
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it.each([0, -13, 1.5])('rejects invalid channel id %s on create and update before writing', async (id) => {
        const createResponse = await POST(req('POST', { ...VALID, newapi_channel_ids: [id] }));
        expect(createResponse.status).toBe(400);
        expect(await createResponse.json()).toMatchObject({
            error: 'invalid_input',
            issues: { newapi_channel_ids: expect.any(Array) },
        });
        const updateResponse = await PUT(
            req('PUT', { newapi_channel_ids: [id] }, 'https://x/api/admin/channel-groups/cg1'),
            { params: Promise.resolve({ id: 'cg1' }) },
        );
        expect(updateResponse.status).toBe(400);
        expect(mockCreate).not.toHaveBeenCalled();
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('generates a free key without renaming existing keys', async () => {
        mockFindMany.mockResolvedValue([{ key: 'official' }, { key: 'official-2' }, { key: '图片模型' }]);
        const response = await POST(req('POST', { ...VALID, key: undefined }));
        expect(response.status).toBe(201);
        expect((await response.json()).group.key).toBe('official-3');
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('retries generated keys after a concurrent unique-key collision', async () => {
        mockFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ key: 'official' }]);
        mockCreate.mockRejectedValueOnce({ code: 'P2002', meta: { target: ['tenant_id', 'key'] } });
        const response = await POST(req('POST', { ...VALID, key: undefined }));
        expect(response.status).toBe(201);
        expect((await response.json()).group.key).toBe('official-2');
        expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('reports a concurrent explicit-key collision without silently changing the chosen key', async () => {
        mockCreate.mockRejectedValueOnce({ code: 'P2002', meta: { target: ['tenant_id', 'key'] } });
        const response = await POST(req('POST', VALID));
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: '档次 key "official" 已存在' });
        expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('does not retry unrelated database constraint failures', async () => {
        const error = { code: 'P2002', meta: { target: ['tenant_id', 'newapi_group'] } };
        mockCreate.mockRejectedValueOnce(error);
        await expect(POST(req('POST', { ...VALID, key: undefined }))).rejects.toEqual(error);
        expect(mockCreate).toHaveBeenCalledTimes(1);
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
        expect(mockCreate.mock.calls[0][0].data.enabled).toBe(false);
        // not setting is_default → no clearing pass
        expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('enforces single default: is_default=true clears other defaults first', async () => {
        await POST(req('POST', { ...VALID, enabled: true, is_default: true }));
        expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { is_default: false } }));
        expect(mockCreate).toHaveBeenCalled();
    });

    it('rejects creating a disabled default tier', async () => {
        const res = await POST(req('POST', { ...VALID, is_default: true, enabled: false }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('default_tier_must_be_enabled');
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects enabling a tier with no registered channels', async () => {
        const res = await POST(req('POST', { ...VALID, enabled: true, newapi_channel_ids: [] }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('active_tier_requires_channels');
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects exposing the same new-api group through two enabled tiers', async () => {
        mockFindMany.mockResolvedValue([{ key: 'sale', newapi_group: 'official', newapi_channel_ids: [6] }]);
        const res = await POST(req('POST', { ...VALID, enabled: true }));
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('newapi_group_already_assigned');
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects assigning a channel already owned by another enabled tier', async () => {
        mockFindMany.mockResolvedValue([{ key: 'sale', newapi_channel_ids: [6, 7] }]);
        const res = await POST(req('POST', { ...VALID, enabled: true, newapi_channel_ids: [6] }));
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({
            error: 'channel_already_assigned',
            conflicts: [{ tier: 'sale', channel_ids: [6] }],
        });
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
            newapi_group: 'official',
            newapi_channel_ids: [8],
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
                newapi_group: 'default',
                newapi_channel_ids: [1],
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

    it('PUT rejects a channel assignment owned by a sibling tier', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'cg1',
            tenant_id: PLATFORM_TENANT_ID,
            key: 'official',
            newapi_group: 'official',
            is_default: false,
            enabled: true,
            newapi_channel_ids: [],
        });
        mockFindMany.mockResolvedValue([{ key: 'sale', newapi_group: 'sale', newapi_channel_ids: [6] }]);
        const res = await PUT(req('PUT', { newapi_channel_ids: [6] }, 'https://x/api/admin/channel-groups/cg1'), {
            params: params(),
        });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('channel_already_assigned');
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('PUT rejects enabling an empty tier', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'cg1',
            tenant_id: PLATFORM_TENANT_ID,
            key: 'official',
            newapi_group: 'official',
            is_default: false,
            enabled: false,
            newapi_channel_ids: [],
        });
        const res = await PUT(req('PUT', { enabled: true }, 'https://x/api/admin/channel-groups/cg1'), {
            params: params(),
        });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('active_tier_requires_channels');
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('PUT rejects removing a channel still used by an enabled model', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'cg1',
            tenant_id: PLATFORM_TENANT_ID,
            key: 'official',
            newapi_group: 'official',
            is_default: false,
            enabled: true,
            newapi_channel_ids: [8, 9],
        });
        mockCatalogFindMany.mockResolvedValue([
            { id: 'm1', slug: 'gpt-pro', upstream_map: { official: { channel_id: 9 } } },
        ]);
        const res = await PUT(req('PUT', { newapi_channel_ids: [8] }, 'https://x/api/admin/channel-groups/cg1'), {
            params: params(),
        });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({
            error: 'tier_in_use_by_enabled_models',
            models: [{ id: 'm1', slug: 'gpt-pro', channel_id: 9 }],
        });
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('DELETE rejects a tier still used by an enabled model', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'cg1',
            tenant_id: PLATFORM_TENANT_ID,
            key: 'official',
            is_default: false,
            enabled: true,
        });
        mockCatalogFindMany.mockResolvedValue([
            { id: 'm1', slug: 'gpt-pro', upstream_map: { official: { channel_id: 8 } } },
        ]);
        const res = await DELETE(req('DELETE', undefined, 'https://x/api/admin/channel-groups/cg1'), {
            params: params(),
        });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('tier_in_use_by_enabled_models');
        expect(mockDelete).not.toHaveBeenCalled();
    });

    it('legacy DELETE cannot bypass verified revocation even for a disabled historical key', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'cg1',
            key: 'official',
            tenant_id: PLATFORM_TENANT_ID,
            is_default: false,
        });
        mockKeyFindFirst.mockResolvedValue({ id: 'old-key' });
        const res = await DELETE(req('DELETE'), { params: params() });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ error: 'retirement_preview_required' });
        expect(mockDelete).not.toHaveBeenCalled();
        expect(mockKeyFindFirst).toHaveBeenCalledWith({
            where: { tier: 'official', user: { OR: [{ tenant_id: PLATFORM_TENANT_ID }, { tenant_id: null }] } },
            select: { id: true },
        });
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

it.each(['create', 'update', 'delete'])(
    'blocks tier %s before reading or writing while a price publication is active',
    async (operation) => {
        mockCatalogGuard.mockRejectedValueOnce(new PricingPublishError('pricing_publish_busy', 'busy'));
        const response =
            operation === 'create'
                ? await POST(req('POST', VALID))
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
