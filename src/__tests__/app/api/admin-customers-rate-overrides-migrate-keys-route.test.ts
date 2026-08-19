import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockUserFindFirst = vi.fn();
const mockMigrate = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...args: unknown[]) => mockResolveAdmin(...args) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: { user: { findFirst: (...args: unknown[]) => mockUserFindFirst(...args) } },
}));
vi.mock('@/lib/newapi/user-tier-multiplier', async () => {
    const actual = await vi.importActual<typeof import('@/lib/newapi/user-tier-multiplier')>(
        '@/lib/newapi/user-tier-multiplier',
    );
    return { ...actual, migrateUserKeysToTier: (...args: unknown[]) => mockMigrate(...args) };
});

import { POST } from '@/app/api/admin/customers/[id]/rate-overrides/migrate-keys/route';
import { UserTierMultiplierError } from '@/lib/newapi/user-tier-multiplier';

const ADMIN = { role: 'admin', tenant_id: 'tenant-1', user: { id: 'admin-1' }, viaBreakGlass: false };
const customer = {
    id: 'u-1',
    tenant_id: 'tenant-1',
    newapi_user_id: 12,
    newapi_access_token: 'persistent-token',
};

function request(body?: unknown) {
    return new NextRequest('https://x/api/admin/customers/u-1/rate-overrides/migrate-keys', {
        method: 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(ADMIN);
    mockUserFindFirst.mockResolvedValue(customer);
    mockMigrate.mockResolvedValue({
        tier_key: 'gpt-pro20x',
        tier_display_name: 'GPT-Pro20x（企业级）',
        migrated_count: 2,
        already_target_count: 0,
        total_active_keys: 2,
    });
});

describe('admin dedicated-tier key migration', () => {
    it('requires an admin before looking up the customer', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect(
            (await POST(request({ tier_key: 'gpt-pro20x' }), { params: Promise.resolve({ id: 'u-1' }) })).status,
        ).toBe(401);
        expect(mockUserFindFirst).not.toHaveBeenCalled();
    });

    it('keeps customer lookup tenant-scoped and returns 404 across tenants', async () => {
        mockUserFindFirst.mockResolvedValue(null);
        expect(
            (await POST(request({ tier_key: 'gpt-pro20x' }), { params: Promise.resolve({ id: 'u-1' }) })).status,
        ).toBe(404);
        expect(mockUserFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'u-1', tenant_id: 'tenant-1' } }),
        );
        expect(mockMigrate).not.toHaveBeenCalled();
    });

    it('validates the target tier before starting a migration', async () => {
        expect((await POST(request({ tier_key: '' }), { params: Promise.resolve({ id: 'u-1' }) })).status).toBe(400);
        expect(mockUserFindFirst).not.toHaveBeenCalled();
        expect(mockMigrate).not.toHaveBeenCalled();
    });

    it('delegates the linked customer and returns a non-sensitive summary', async () => {
        const response = await POST(request({ tier_key: 'gpt-pro20x' }), { params: Promise.resolve({ id: 'u-1' }) });

        expect(response.status).toBe(200);
        expect(mockMigrate).toHaveBeenCalledWith({ user: customer, tierKey: 'gpt-pro20x' });
        const payload = await response.json();
        expect(payload).toMatchObject({ ok: true, migrated_count: 2, total_active_keys: 2 });
        expect(JSON.stringify(payload)).not.toContain('persistent-token');
    });

    it('returns the controlled service error without exposing credentials', async () => {
        mockMigrate.mockRejectedValue(
            new UserTierMultiplierError('Selected tier has no active dedicated multiplier', 409),
        );
        const response = await POST(request({ tier_key: 'gpt-pro20x' }), { params: Promise.resolve({ id: 'u-1' }) });

        expect(response.status).toBe(409);
        expect(JSON.stringify(await response.json())).not.toContain('persistent-token');
    });
});
