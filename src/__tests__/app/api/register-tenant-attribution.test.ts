/**
 * P6a: register attributes the customer to the request-domain's tenant, and a
 * tenant with signup_enabled=false rejects self-serve registration early.
 * (Happy-path tenant_id stamping shares the create-with-tenant_id mechanism
 * proven in oauth-account-link-tenant.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolveTenant = vi.fn();
const mockUserCreate = vi.fn();
const mockUserFindUnique = vi.fn();

vi.mock('@/lib/tenant/resolve', () => ({ resolveTenantByHost: (...a: unknown[]) => mockResolveTenant(...a) }));
vi.mock('@/lib/db', () => ({
    prisma: {
        user: {
            create: (...a: unknown[]) => mockUserCreate(...a),
            findUnique: (...a: unknown[]) => mockUserFindUnique(...a),
            update: vi.fn(),
            delete: vi.fn(),
        },
        newApiToken: { create: vi.fn() },
        emailVerificationToken: { create: vi.fn() },
        $transaction: vi.fn(),
    },
}));

import { POST } from '@/app/api/auth/register/route';

function req(body: object, host = 'acme.com') {
    return new NextRequest(`https://${host}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTenant.mockResolvedValue({ id: 'tenant-7', signup_enabled: true });
    mockUserFindUnique.mockResolvedValue(null);
});

describe('POST /api/auth/register — tenant attribution', () => {
    it('signup_enabled=false tenant → 403 signup_disabled, no user created', async () => {
        mockResolveTenant.mockResolvedValue({ id: 'tenant-7', signup_enabled: false });
        const res = await POST(req({ email: 'a@b.com', password: 'password123' }));
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe('signup_disabled');
        expect(mockUserCreate).not.toHaveBeenCalled();
    });

    it('resolves the tenant from the request Host', async () => {
        mockResolveTenant.mockResolvedValue({ id: 'tenant-7', signup_enabled: false });
        await POST(req({ email: 'a@b.com', password: 'password123' }, 'acme.com'));
        expect(mockResolveTenant).toHaveBeenCalledWith('acme.com');
    });
});
