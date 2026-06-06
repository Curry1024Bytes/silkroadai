import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = vi.fn();
const mockIsBreakGlass = vi.fn();

// admin/auth.ts pulls AdminUnauthorizedError (a class) from @/lib/admin-auth.
// Create it via vi.hoisted so it's initialized before the hoisted vi.mock
// factory references it — a plain top-level class would sit in the TDZ and
// throw "Cannot access before initialization".
const { FakeAdminUnauthorizedError } = vi.hoisted(() => {
    class FakeAdminUnauthorizedError extends Error {
        constructor(m = 'Unauthorized') {
            super(m);
            this.name = 'AdminUnauthorizedError';
        }
    }
    return { FakeAdminUnauthorizedError };
});

vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

vi.mock('@/lib/admin-auth', () => ({
    isBreakGlassToken: (...a: unknown[]) => mockIsBreakGlass(...a),
    AdminUnauthorizedError: FakeAdminUnauthorizedError,
}));

import { getAdminUser, resolveAdmin, requireRole } from '@/lib/admin/auth';
import { roleAtLeast } from '@/lib/admin/roles';

function req() {
    return new NextRequest('http://internal/api/admin/x', { method: 'GET' });
}
function user(role: string, tenant_id: string | null = 'tenant-1') {
    return { id: 'u1', email: 'a@b.c', role, tenant_id };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue(null);
    mockIsBreakGlass.mockReturnValue(false);
});

describe('roleAtLeast', () => {
    it('orders customer < staff < admin < superadmin', () => {
        expect(roleAtLeast('superadmin', 'admin')).toBe(true);
        expect(roleAtLeast('admin', 'admin')).toBe(true);
        expect(roleAtLeast('admin', 'staff')).toBe(true);
        expect(roleAtLeast('staff', 'admin')).toBe(false);
        expect(roleAtLeast('customer', 'staff')).toBe(false);
        expect(roleAtLeast('customer', 'customer')).toBe(true);
    });
});

describe('getAdminUser (cookie session only)', () => {
    it('returns the user when role >= staff', async () => {
        mockGetCurrentUser.mockResolvedValue(user('staff'));
        expect(await getAdminUser(req())).toMatchObject({ role: 'staff' });
    });

    it('returns null for a customer', async () => {
        mockGetCurrentUser.mockResolvedValue(user('customer'));
        expect(await getAdminUser(req())).toBeNull();
    });

    it('ignores a break-glass token (session-only)', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        mockIsBreakGlass.mockReturnValue(true);
        expect(await getAdminUser(req())).toBeNull();
    });
});

describe('resolveAdmin', () => {
    it('resolves a session admin meeting minRole', async () => {
        mockGetCurrentUser.mockResolvedValue(user('admin', 'tenant-7'));
        const p = await resolveAdmin(req(), 'admin');
        expect(p).toMatchObject({ role: 'admin', tenant_id: 'tenant-7', viaBreakGlass: false });
        expect(p?.user).not.toBeNull();
    });

    it('rejects a session user below minRole', async () => {
        mockGetCurrentUser.mockResolvedValue(user('staff'));
        expect(await resolveAdmin(req(), 'admin')).toBeNull();
    });

    it('falls back to break-glass token as superadmin (user=null, tenant=null)', async () => {
        mockIsBreakGlass.mockReturnValue(true);
        const p = await resolveAdmin(req(), 'admin');
        expect(p).toMatchObject({ role: 'superadmin', tenant_id: null, viaBreakGlass: true });
        expect(p?.user).toBeNull();
    });

    it('returns null when neither session nor break-glass', async () => {
        expect(await resolveAdmin(req(), 'admin')).toBeNull();
    });

    it('defaults minRole to staff', async () => {
        mockGetCurrentUser.mockResolvedValue(user('staff'));
        expect(await resolveAdmin(req())).toMatchObject({ role: 'staff' });
    });
});

describe('requireRole', () => {
    it('returns the principal when satisfied', async () => {
        mockGetCurrentUser.mockResolvedValue(user('superadmin', null));
        await expect(requireRole(req(), 'admin')).resolves.toMatchObject({ role: 'superadmin' });
    });

    it('throws AdminUnauthorizedError when not satisfied', async () => {
        mockGetCurrentUser.mockResolvedValue(user('customer'));
        await expect(requireRole(req(), 'admin')).rejects.toBeInstanceOf(FakeAdminUnauthorizedError);
    });
});
