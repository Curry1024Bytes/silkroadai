/**
 * P6a §9.5 security test: the admin dashboard MUST tenant-scope every query so a
 * partner admin can't see全平台营收. superadmin → unscoped (sees all). Covers both
 * the Prisma aggregates/counts/groupBy AND the two $queryRaw (daily series / leaderboard).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockAggregate = vi.fn();
const mockCount = vi.fn();
const mockGroupBy = vi.fn();
const mockQueryRaw = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        order: {
            aggregate: (...a: unknown[]) => mockAggregate(...a),
            count: (...a: unknown[]) => mockCount(...a),
            groupBy: (...a: unknown[]) => mockGroupBy(...a),
        },
        $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
    },
}));

import { GET } from '@/app/api/admin/dashboard/route';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };
const PARTNER = { role: 'admin', tenant_id: 'tenant-7', user: { id: 'a1' }, viaBreakGlass: false };

const req = () => new NextRequest('https://x/api/admin/dashboard?days=30', { method: 'GET' });

// Does any $queryRaw substitution carry the tenant id? (the AND tenant_id = ${id}::uuid clause)
function rawCarriesTenant(id: string): boolean {
    return mockQueryRaw.mock.calls.some((call) =>
        call.some(
            (arg: unknown) =>
                !!arg &&
                typeof arg === 'object' &&
                Array.isArray((arg as { values?: unknown[] }).values) &&
                (arg as { values: unknown[] }).values.includes(id),
        ),
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(SUPERADMIN);
    mockAggregate.mockResolvedValue({ _sum: { amount: null }, _count: { _all: 0 } });
    mockCount.mockResolvedValue(0);
    mockGroupBy.mockResolvedValue([]);
    mockQueryRaw.mockResolvedValue([]);
});

describe('GET /api/admin/dashboard tenant scope', () => {
    it('401 when not an admin (now resolveAdmin-gated)', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await GET(req())).status).toBe(401);
        expect(mockAggregate).not.toHaveBeenCalled();
    });

    it('superadmin → NO tenant filter anywhere (sees全平台)', async () => {
        await GET(req());
        for (const call of mockAggregate.mock.calls) expect(call[0].where).not.toHaveProperty('tenant_id');
        for (const call of mockCount.mock.calls) expect(call[0]?.where ?? {}).not.toHaveProperty('tenant_id');
        expect(mockGroupBy.mock.calls[0][0].where).not.toHaveProperty('tenant_id');
        expect(rawCarriesTenant('tenant-7')).toBe(false);
    });

    it('partner admin → every query scoped to their tenant (Prisma + raw SQL)', async () => {
        mockResolveAdmin.mockResolvedValue(PARTNER);
        await GET(req());

        // Prisma aggregates + counts + groupBy all carry tenant_id.
        expect(mockAggregate.mock.calls.length).toBeGreaterThan(0);
        for (const call of mockAggregate.mock.calls) expect(call[0].where.tenant_id).toBe('tenant-7');
        for (const call of mockCount.mock.calls) expect(call[0].where.tenant_id).toBe('tenant-7');
        expect(mockGroupBy.mock.calls[0][0].where.tenant_id).toBe('tenant-7');

        // Both raw queries (daily series + leaderboard) carry the tenant clause.
        expect(mockQueryRaw).toHaveBeenCalledTimes(2);
        expect(rawCarriesTenant('tenant-7')).toBe(true);
    });
});
