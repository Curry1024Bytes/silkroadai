import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockUserFindFirst = vi.fn();
const mockGroupFindMany = vi.fn();
const mockGetGroupRatios = vi.fn();
const mockList = vi.fn();
const mockSave = vi.fn();
const mockDisable = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...args: unknown[]) => mockResolveAdmin(...args) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findFirst: (...args: unknown[]) => mockUserFindFirst(...args) },
        channelGroup: { findMany: (...args: unknown[]) => mockGroupFindMany(...args) },
    },
}));
vi.mock('@/lib/channel-group', () => ({ getGroupRatios: (...args: unknown[]) => mockGetGroupRatios(...args) }));
vi.mock('@/lib/newapi/user-tier-multiplier', async () => {
    const actual = await vi.importActual<typeof import('@/lib/newapi/user-tier-multiplier')>(
        '@/lib/newapi/user-tier-multiplier',
    );
    return {
        ...actual,
        listUserTierMultipliers: (...args: unknown[]) => mockList(...args),
        saveUserTierMultiplier: (...args: unknown[]) => mockSave(...args),
        disableUserTierMultiplier: (...args: unknown[]) => mockDisable(...args),
    };
});

import { GET, PUT } from '@/app/api/admin/customers/[id]/rate-overrides/route';
import { DELETE } from '@/app/api/admin/customers/[id]/rate-overrides/[overrideId]/route';
import { UserTierMultiplierError } from '@/lib/newapi/user-tier-multiplier';

const ADMIN = { role: 'admin', tenant_id: 'tenant-1', user: { id: 'admin-1' }, viaBreakGlass: false };

function req(method: string, body?: unknown, path = 'https://x/api/admin/customers/u-1/rate-overrides') {
    return new NextRequest(path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const params = (id = 'u-1') => Promise.resolve({ id });

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(ADMIN);
    mockUserFindFirst.mockResolvedValue({ id: 'u-1', tenant_id: 'tenant-1', newapi_user_id: 12 });
    mockGroupFindMany.mockResolvedValue([
        { key: 'gpt-pro20x', display_name: 'GPT-Pro20x（企业级）', newapi_group: 'GPT-Pro20x(企业级)' },
    ]);
    mockGetGroupRatios.mockResolvedValue({ 'GPT-Pro20x(企业级)': 0.2 });
    mockList.mockResolvedValue([
        {
            id: 'override-1',
            tier_key: 'gpt-pro20x',
            multiplier: '0.18',
            synced_at: new Date('2026-08-19T00:00:00.000Z'),
            created_at: new Date('2026-08-19T00:00:00.000Z'),
            updated_at: new Date('2026-08-19T00:00:00.000Z'),
        },
    ]);
    mockSave.mockResolvedValue({
        id: 'override-1',
        tier_key: 'gpt-pro20x',
        multiplier: '0.18',
        synced_at: new Date('2026-08-19T00:00:00.000Z'),
        created_at: new Date('2026-08-19T00:00:00.000Z'),
        updated_at: new Date('2026-08-19T00:00:00.000Z'),
    });
});

describe('admin customer rate overrides', () => {
    it('requires an admin for reads and writes', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await GET(req('GET'), { params: params() })).status).toBe(401);
        expect((await PUT(req('PUT', { tier_key: 'gpt-pro20x', multiplier: 0.18 }), { params: params() })).status).toBe(
            401,
        );
        expect(
            (
                await DELETE(req('DELETE', undefined, 'https://x/api/admin/customers/u-1/rate-overrides/override-1'), {
                    params: Promise.resolve({ id: 'u-1', overrideId: 'override-1' }),
                })
            ).status,
        ).toBe(401);
        expect(mockUserFindFirst).not.toHaveBeenCalled();
    });

    it('keeps customer lookup tenant-scoped and returns 404 across tenants', async () => {
        mockUserFindFirst.mockResolvedValue(null);
        const response = await GET(req('GET'), { params: params() });
        expect(response.status).toBe(404);
        expect(mockList).not.toHaveBeenCalled();
        expect(mockUserFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'u-1', tenant_id: 'tenant-1' } }),
        );
    });

    it('rejects invalid multipliers before touching new-api', async () => {
        const response = await PUT(req('PUT', { tier_key: 'gpt-pro20x', multiplier: 0 }), { params: params() });
        expect(response.status).toBe(400);
        expect(mockSave).not.toHaveBeenCalled();
    });

    it('returns public 0.20 and customer effective 0.18 without exposing internal user group', async () => {
        const response = await GET(req('GET'), { params: params() });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.tiers).toEqual([
            {
                key: 'gpt-pro20x',
                display_name: 'GPT-Pro20x（企业级）',
                public_multiplier: 0.2,
                effective_multiplier: 0.18,
            },
        ]);
        expect(JSON.stringify(body)).not.toContain('portal-user-');
    });

    it('returns the public 0.20 rate for a customer without an override', async () => {
        mockList.mockResolvedValue([]);
        const response = await GET(req('GET'), { params: params() });
        expect(response.status).toBe(200);
        expect((await response.json()).tiers).toEqual([
            {
                key: 'gpt-pro20x',
                display_name: 'GPT-Pro20x（企业级）',
                public_multiplier: 0.2,
                effective_multiplier: 0.2,
            },
        ]);
    });

    it('rejects an unlinked customer and forwards a valid save to the sync service', async () => {
        mockUserFindFirst.mockResolvedValue({ id: 'u-1', tenant_id: 'tenant-1', newapi_user_id: null });
        mockSave.mockRejectedValue(new UserTierMultiplierError('Customer has no linked new-api account', 409));
        expect((await PUT(req('PUT', { tier_key: 'gpt-pro20x', multiplier: 0.18 }), { params: params() })).status).toBe(
            409,
        );

        mockSave.mockResolvedValueOnce({
            id: 'override-1',
            tier_key: 'gpt-pro20x',
            multiplier: 0.18,
            synced_at: new Date('2026-08-19T00:00:00.000Z'),
            created_at: new Date('2026-08-19T00:00:00.000Z'),
            updated_at: new Date('2026-08-19T00:00:00.000Z'),
        });
        mockUserFindFirst.mockResolvedValue({ id: 'u-1', tenant_id: 'tenant-1', newapi_user_id: 12 });
        const response = await PUT(req('PUT', { tier_key: 'gpt-pro20x', multiplier: 0.18 }), { params: params() });
        expect(response.status).toBe(200);
        expect(mockSave).toHaveBeenLastCalledWith({
            user: { id: 'u-1', tenant_id: 'tenant-1', newapi_user_id: 12 },
            tierKey: 'gpt-pro20x',
            multiplier: 0.18,
            createdBy: 'admin-1',
        });
    });

    it('deletes only the requested override through the sync service', async () => {
        mockDisable.mockResolvedValue({ id: 'override-1' });
        const response = await DELETE(
            req('DELETE', undefined, 'https://x/api/admin/customers/u-1/rate-overrides/override-1'),
            { params: Promise.resolve({ id: 'u-1', overrideId: 'override-1' }) },
        );
        expect(response.status).toBe(200);
        expect(mockDisable).toHaveBeenCalledWith({
            user: { id: 'u-1', tenant_id: 'tenant-1', newapi_user_id: 12 },
            overrideId: 'override-1',
        });
    });
});
