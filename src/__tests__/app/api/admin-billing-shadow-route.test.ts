import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockGroupBy = vi.fn();
const mockModelFindMany = vi.fn();
const mockUserFindMany = vi.fn();
const mockTenantFindMany = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        usageRecord: { groupBy: (...a: unknown[]) => mockGroupBy(...a) },
        catalogModel: { findMany: (...a: unknown[]) => mockModelFindMany(...a) },
        user: { findMany: (...a: unknown[]) => mockUserFindMany(...a) },
        tenant: { findMany: (...a: unknown[]) => mockTenantFindMany(...a) },
    },
}));

import { GET } from '@/app/api/admin/billing-shadow/route';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };
const PARTNER = { role: 'admin', tenant_id: 'tenant-7', user: { id: 'admin-1' }, viaBreakGlass: false };

function req(url = 'https://x/api/admin/billing-shadow') {
    return new NextRequest(url, { method: 'GET' });
}

// gpt: matched, ¥100 retail, 2M tok, has cost price ¥30/1M → cost 60, margin 40 (40%).
// nocost: matched, ¥30 retail, no cost price → cost-missing.
function wire() {
    mockGroupBy.mockResolvedValue([
        {
            user_id: 'u1',
            tenant_id: 't1',
            model_slug: 'gpt',
            tier: 'pool',
            matched: true,
            _count: { _all: 10 },
            _sum: { cost_cny: '100', input_tokens: 1_500_000, output_tokens: 500_000 },
        },
        {
            user_id: 'u2',
            tenant_id: 't2',
            model_slug: 'nocost',
            tier: 'pool',
            matched: true,
            _count: { _all: 3 },
            _sum: { cost_cny: '30', input_tokens: 300_000, output_tokens: 200_000 },
        },
    ]);
    mockModelFindMany.mockResolvedValue([
        {
            tenant_id: 't1',
            slug: 'gpt',
            // two versions — the report must pick the latest effective_from (¥30, not ¥25).
            prices: [
                { tier: 'pool', cost_cny_per_1m: '30', effective_from: new Date('2026-02-01') },
                { tier: 'pool', cost_cny_per_1m: '25', effective_from: new Date('2026-01-01') },
            ],
        },
        {
            tenant_id: 't2',
            slug: 'nocost',
            prices: [{ tier: 'pool', cost_cny_per_1m: null, effective_from: new Date('2026-01-01') }],
        },
    ]);
    mockUserFindMany.mockResolvedValue([
        { id: 'u1', email: 'a@b.com' },
        { id: 'u2', email: 'c@d.com' },
    ]);
    mockTenantFindMany.mockResolvedValue([
        { id: 't1', slug: 'plat', brand_name: 'Platform' },
        { id: 't2', slug: 'partner', brand_name: 'Partner' },
    ]);
}

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(SUPERADMIN);
    wire();
});

describe('GET /api/admin/billing-shadow (P4b-v2 margin)', () => {
    it('401 when not an admin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await GET(req())).status).toBe(401);
        expect(mockGroupBy).not.toHaveBeenCalled();
    });

    it('summary: retail / cost / margin / coverage (cost = latest price × tokens)', async () => {
        const body = await (await GET(req())).json();
        expect(body.summary).toMatchObject({
            records: 13,
            matchedRecords: 13,
            costCoveredRecords: 10, // only gpt has a cost price
            retailCny: 130,
            costCny: 60, // 30(latest, not 25) × 2M tok = 60
            marginCny: 70,
        });
        expect(body.summary.marginRate).toBeCloseTo(70 / 130, 6);
        expect(body.summary.costCoverage).toBeCloseTo(10 / 13, 6);
        expect(body.marginYellowThreshold).toBe(0.2);
    });

    it('drops the new-api quota basis entirely (no newapi/diff fields)', async () => {
        const body = await (await GET(req())).json();
        for (const k of ['newapiCny', 'newapiQuota', 'diffCny', 'diffRate', 'matchedNewapiCny', 'unmatchedNewapiCny']) {
            expect(body.summary).not.toHaveProperty(k);
        }
        expect(body.byModel[0]).not.toHaveProperty('newapiCny');
        expect(body.byModel[0]).not.toHaveProperty('diffCny');
        expect(body).not.toHaveProperty('unmatched'); // the old 未配价 list is gone
    });

    it('byModel: margin per row + cost-missing flagged & listed', async () => {
        const body = await (await GET(req())).json();
        expect(body.byModel.map((m: { model_slug: string }) => m.model_slug)).toEqual(['gpt', 'nocost']);
        expect(body.byModel[0]).toMatchObject({
            model_slug: 'gpt',
            retailCny: 100,
            costCny: 60,
            marginCny: 40,
            hasCost: true,
        });
        expect(body.byModel[0].marginRate).toBeCloseTo(0.4, 6);
        expect(body.byModel[1]).toMatchObject({ model_slug: 'nocost', hasCost: false, costCny: 0 });
        expect(body.costMissing).toEqual([{ model_slug: 'nocost', tier: 'pool', retailCny: 30, records: 3 }]);
    });

    it('byCustomer email join + byTenant name join', async () => {
        const body = await (await GET(req())).json();
        expect(body.byCustomer[0]).toMatchObject({ user_id: 'u1', email: 'a@b.com', retailCny: 100 });
        expect(body.byTenant[0]).toMatchObject({ tenant_id: 't1', name: 'Platform', retailCny: 100 });
    });

    it('tenantScope: superadmin unfiltered; partner scopes BOTH usage + catalog queries', async () => {
        await GET(req());
        expect(mockGroupBy.mock.calls[0][0].where).not.toHaveProperty('tenant_id');
        expect(mockModelFindMany.mock.calls[0][0].where).not.toHaveProperty('tenant_id');

        vi.clearAllMocks();
        wire();
        mockResolveAdmin.mockResolvedValue(PARTNER);
        await GET(req());
        expect(mockGroupBy.mock.calls[0][0].where.tenant_id).toBe('tenant-7');
        expect(mockModelFindMany.mock.calls[0][0].where.tenant_id).toBe('tenant-7');
    });

    it('period: default 30d windowed; all → no time filter', async () => {
        const d30 = await (await GET(req())).json();
        expect(d30.period).toBe('30d');
        expect(mockGroupBy.mock.calls[0][0].where.log_created_at?.gte).toBeInstanceOf(Date);

        vi.clearAllMocks();
        wire();
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        const dall = await (await GET(req('https://x/api/admin/billing-shadow?period=all'))).json();
        expect(dall.period).toBe('all');
        expect(dall.rangeStart).toBeNull();
        expect(mockGroupBy.mock.calls[0][0].where).not.toHaveProperty('log_created_at');
    });
});
