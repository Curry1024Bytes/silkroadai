import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockGroupBy = vi.fn();
const mockUserFindMany = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        usageRecord: { groupBy: (...a: unknown[]) => mockGroupBy(...a) },
        user: { findMany: (...a: unknown[]) => mockUserFindMany(...a) },
    },
}));
// 1 USD = 500k quota × ¥7.2/USD.
vi.mock('@/lib/newapi/client', () => ({ quotaToCny: (q: number) => (q / 500_000) * 7.2 }));

import { GET } from '@/app/api/admin/billing-shadow/route';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };
const PARTNER = { role: 'admin', tenant_id: 'tenant-7', user: { id: 'admin-1' }, viaBreakGlass: false };

function req(url = 'https://x/api/admin/billing-shadow') {
    return new NextRequest(url, { method: 'GET' });
}

// route calls groupBy 4× in order: byMatched, byModel(×tier), byUser, unmatched.
function wireGroupBy() {
    mockGroupBy.mockImplementation((args: { by: string[]; where?: { matched?: boolean } }) => {
        const by = args.by.join(',');
        if (by === 'matched')
            return Promise.resolve([
                { matched: true, _count: { _all: 2 }, _sum: { cost_cny: '12.5', newapi_quota: 900_000 } },
                { matched: false, _count: { _all: 1 }, _sum: { cost_cny: '0', newapi_quota: 50_000 } },
            ]);
        if (by === 'user_id')
            return Promise.resolve([
                { user_id: 'u1', _count: { _all: 3 }, _sum: { cost_cny: '12.5', newapi_quota: 950_000 } },
            ]);
        if (by === 'model_slug,tier' && args.where?.matched === false)
            return Promise.resolve([{ model_slug: 'claude-x', tier: 'pool', _count: { _all: 1 } }]);
        if (by === 'model_slug,tier')
            return Promise.resolve([
                {
                    model_slug: 'gpt-5.4',
                    tier: 'pool',
                    _count: { _all: 2 },
                    _sum: { cost_cny: '12.5', newapi_quota: 900_000 },
                },
            ]);
        return Promise.resolve([]);
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(SUPERADMIN);
    wireGroupBy();
    mockUserFindMany.mockResolvedValue([{ id: 'u1', email: 'a@b.com' }]);
});

describe('GET /api/admin/billing-shadow', () => {
    it('401 when not an admin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await GET(req())).status).toBe(401);
        expect(mockGroupBy).not.toHaveBeenCalled();
    });

    it('summary: portal ¥ vs new-api ¥ + diff, matched/unmatched counts', async () => {
        const res = await GET(req());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.summary).toMatchObject({
            records: 3,
            matched: 2,
            unmatched: 1,
            costCny: 12.5,
            newapiQuota: 950_000,
        });
        // newapiCny = 950k/500k × 7.2 = 13.68; diff = 12.5 − 13.68 = −1.18
        expect(body.summary.newapiCny).toBeCloseTo(13.68, 6);
        expect(body.summary.diffCny).toBeCloseTo(-1.18, 6);
        expect(body.summary.diffRate).toBeCloseTo(-1.18 / 13.68, 6);
    });

    it('drills down by model and customer (email joined), highlights unmatched', async () => {
        const body = await (await GET(req())).json();
        expect(body.byModel[0]).toMatchObject({ model_slug: 'gpt-5.4', tier: 'pool', records: 2, costCny: 12.5 });
        expect(body.byCustomer[0]).toMatchObject({ user_id: 'u1', email: 'a@b.com', records: 3 });
        expect(body.unmatched).toEqual([{ model_slug: 'claude-x', tier: 'pool', records: 1 }]);
    });

    it('superadmin → no tenant filter; partner → tenant-scoped where', async () => {
        await GET(req());
        expect(mockGroupBy.mock.calls[0][0].where).not.toHaveProperty('tenant_id');

        vi.clearAllMocks();
        wireGroupBy();
        mockUserFindMany.mockResolvedValue([]);
        mockResolveAdmin.mockResolvedValue(PARTNER);
        await GET(req());
        expect(mockGroupBy.mock.calls[0][0].where.tenant_id).toBe('tenant-7');
    });

    it('period: default 7d has a log_created_at window; all → no time filter', async () => {
        const d7 = await (await GET(req())).json();
        expect(d7.period).toBe('7d');
        expect(d7.rangeStart).not.toBeNull();
        expect(mockGroupBy.mock.calls[0][0].where.log_created_at?.gte).toBeInstanceOf(Date);

        vi.clearAllMocks();
        wireGroupBy();
        mockUserFindMany.mockResolvedValue([]);
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        const dall = await (await GET(req('https://x/api/admin/billing-shadow?period=all'))).json();
        expect(dall.period).toBe('all');
        expect(dall.rangeStart).toBeNull();
        expect(mockGroupBy.mock.calls[0][0].where).not.toHaveProperty('log_created_at');
    });
});
