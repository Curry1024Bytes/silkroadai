import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';

// P6b-2: tenant-scoped customer management. gate = admin (partner admins use it); tenantScope
// confines partner admins to their own tenant; detail is IDOR-safe via findFirst+scope.
const mockResolveAdmin = vi.fn();
const mockQueryRaw = vi.fn();
const mockUserUpdateMany = vi.fn();
const mockUserCount = vi.fn();
const mockUserFindFirst = vi.fn();
const mockUsageGroupBy = vi.fn();
const mockTokenFindMany = vi.fn();
const mockRechargeFindMany = vi.fn();
const mockAccountFindUnique = vi.fn();

vi.mock('@/lib/admin/auth', () => ({
    resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a),
}));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
// Use the REAL tenant-scope helper so the where-clause wiring is exercised end-to-end.
vi.mock('@/lib/db', () => ({
    prisma: {
        $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
        user: {
            updateMany: (...a: unknown[]) => mockUserUpdateMany(...a),
            count: (...a: unknown[]) => mockUserCount(...a),
            findFirst: (...a: unknown[]) => mockUserFindFirst(...a),
        },
        usageRecord: { groupBy: (...a: unknown[]) => mockUsageGroupBy(...a) },
        newApiToken: { findMany: (...a: unknown[]) => mockTokenFindMany(...a) },
        rechargeLog: { findMany: (...a: unknown[]) => mockRechargeFindMany(...a) },
        account: { findUnique: (...a: unknown[]) => mockAccountFindUnique(...a) },
    },
}));
// quotaToCny is server-only via client.ts — mock with the real formula (500k/USD, ¥7.2).
vi.mock('@/lib/newapi/client', () => ({
    quotaToCny: (quota: number) => (quota / 500_000) * 7.2,
}));
vi.mock('@/lib/newapi/quota-units', () => ({ QUOTA_PER_USD: 500_000, USD_TO_CNY_RATE: 7.2 }));
// Detail header live-refetches balance via getQuotaWithCache. Default it to REJECT
// so the existing detail assertions exercise the graceful fallback (→ cache columns,
// the pre-change behavior). One dedicated test below drives the live-success path.
const mockGetQuotaWithCache = vi.fn();
vi.mock('@/lib/newapi/quota-cache', () => ({
    getQuotaWithCache: (...a: unknown[]) => mockGetQuotaWithCache(...a),
}));

import { GET as LIST } from '@/app/api/admin/customers/route';
import { GET as DETAIL, PATCH as SET_ALIAS } from '@/app/api/admin/customers/[id]/route';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };
const PARTNER_ADMIN = { role: 'admin', tenant_id: 'tenant-7', user: {}, viaBreakGlass: false };

const listReq = (qs = '') => new NextRequest(`https://x/api/admin/customers${qs}`);
const detailReq = (id: string) => new NextRequest(`https://x/api/admin/customers/${id}`);
const detailParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
    vi.clearAllMocks();
    mockQueryRaw.mockResolvedValue([]);
    mockUserUpdateMany.mockResolvedValue({ count: 1 });
    mockUserCount.mockResolvedValue(0);
    mockUsageGroupBy.mockResolvedValue([]);
    mockTokenFindMany.mockResolvedValue([]);
    mockRechargeFindMany.mockResolvedValue([]);
    mockAccountFindUnique.mockResolvedValue(null); // P4c-1: no ledger Account by default
    // default: live refetch unavailable → route falls back to cache columns (pre-change behavior)
    mockGetQuotaWithCache.mockRejectedValue(new Error('no upstream in test'));
});

describe('GET /api/admin/customers (list)', () => {
    it('returns 401 when not an admin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        const res = await LIST(listReq());
        expect(res.status).toBe(401);
        expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    const executedSql = () => {
        const [strings, ...values] = mockQueryRaw.mock.calls[0];
        return Prisma.sql(strings, ...values);
    };

    it('confines both rows and count to the partner tenant', async () => {
        mockResolveAdmin.mockResolvedValue(PARTNER_ADMIN);
        await LIST(listReq());
        const query = executedSql();
        expect(query.sql).toContain('u.tenant_id = ?::uuid');
        expect(query.values).toContain('tenant-7');
        expect(mockUserCount.mock.calls[0][0].where).toMatchObject({ tenant_id: 'tenant-7' });
    });

    it('applies balance order before pagination and allows superadmin to see all tenants', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        await LIST(listReq('?page=2&page_size=3&sort=balance'));
        const query = executedSql();
        expect(query.sql).not.toContain('u.tenant_id =');
        expect(query.sql).toMatch(/ORDER BY balance_cny DESC, u\.created_at DESC, u\.id DESC\s+LIMIT \? OFFSET \?/);
        expect(query.sql).toContain('ORDER BY balance_cny DESC, p.created_at DESC, p.id DESC');
        expect(query.values).toEqual([7.2, 500000, 3, 3]);
        expect(mockUserCount.mock.calls[0][0].where.tenant_id).toBeUndefined();
    });

    it.each(['', '?sort=recent', '?sort=unknown'])('defaults to most recent registration for %j', async (qs) => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        await LIST(listReq(qs));
        const { sql } = executedSql();
        expect(sql).toMatch(/ORDER BY u\.created_at DESC, u\.id DESC\s+LIMIT \? OFFSET \?/);
        expect(sql).toContain('ORDER BY p.created_at DESC, p.id DESC');
        expect(sql).not.toContain('ORDER BY balance_cny');
    });

    it('matches either email or alias within the tenant', async () => {
        mockResolveAdmin.mockResolvedValue(PARTNER_ADMIN);
        await LIST(listReq('?q=Acme'));
        const query = executedSql();
        expect(query.sql).toContain('u.email ILIKE ? OR u.admin_alias ILIKE ?');
        expect(query.values).toEqual([7.2, 500000, 'tenant-7', '%Acme%', '%Acme%', 20, 0]);
        expect(mockUserCount.mock.calls[0][0].where).toEqual({
            tenant_id: 'tenant-7',
            OR: [
                { email: { contains: 'Acme', mode: 'insensitive' } },
                { admin_alias: { contains: 'Acme', mode: 'insensitive' } },
            ],
        });
    });

    it('maps balance (¥), key count, and 30d usage into the row', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        mockQueryRaw.mockResolvedValue([
            {
                id: 'u1',
                email: 'a@x.com',
                status: 'active',
                created_at: new Date('2026-01-01T00:00:00Z'),
                admin_alias: '项目 A',
                balance_cny: new Prisma.Decimal(7.2),
                balance_cached_at: null,
                balance_pending: false,
                key_count: 2,
            },
        ]);
        mockUserCount.mockResolvedValue(1);
        mockUsageGroupBy.mockResolvedValue([{ user_id: 'u1', _count: { _all: 5 }, _sum: { cost_cny: '1.25' } }]);

        const res = await LIST(listReq());
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.customers[0]).toMatchObject({
            id: 'u1',
            email: 'a@x.com',
            admin_alias: '项目 A',
            balance_cny: 7.2,
            key_count: 2,
            usage_30d: { calls: 5, costCny: 1.25 },
        });
        expect(body.total).toBe(1);
    });

    it('reports a pending balance when new-api has no cached quota', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        mockQueryRaw.mockResolvedValue([{ balance_cny: new Prisma.Decimal(0), balance_pending: true }]);
        mockUserCount.mockResolvedValue(1);
        const body = await (await LIST(listReq())).json();
        expect(body.customers[0]).toMatchObject({ balance_cny: 0, balance_pending: true });
    });
});

describe('GET /api/admin/customers/[id] (detail — IDOR-safe)', () => {
    it('returns 401 when not an admin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        const res = await DETAIL(detailReq('u1'), detailParams('u1'));
        expect(res.status).toBe(401);
        expect(mockUserFindFirst).not.toHaveBeenCalled();
    });

    it('partner admin → findFirst where includes BOTH id AND tenant_id (IDOR guard)', async () => {
        mockResolveAdmin.mockResolvedValue(PARTNER_ADMIN);
        mockUserFindFirst.mockResolvedValue(null); // cross-tenant id → not found
        await DETAIL(detailReq('other-tenant-user'), detailParams('other-tenant-user'));
        expect(mockUserFindFirst.mock.calls[0][0].where).toMatchObject({
            id: 'other-tenant-user',
            tenant_id: 'tenant-7',
        });
    });

    it('404 when the user is not in the admin tenant scope', async () => {
        mockResolveAdmin.mockResolvedValue(PARTNER_ADMIN);
        mockUserFindFirst.mockResolvedValue(null);
        const res = await DETAIL(detailReq('nope'), detailParams('nope'));
        expect(res.status).toBe(404);
        // no further reads once the user is out of scope
        expect(mockTokenFindMany).not.toHaveBeenCalled();
    });

    it('superadmin → findFirst where has id, no tenant_id; returns profile + keys + usage + recharges', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        mockUserFindFirst.mockResolvedValue({
            id: 'u1',
            email: 'a@x.com',
            nickname: 'Ada',
            admin_alias: '项目客户',
            status: 'active',
            created_at: new Date('2026-01-01T00:00:00Z'),
            last_login_at: null,
            newapi_quota_cache: BigInt(500_000),
            newapi_used_quota_cache: BigInt(250_000),
            newapi_cached_at: null,
            newapi_user_id: 13,
            newapi_username: 'c-4e23b655',
        });
        mockTokenFindMany.mockResolvedValue([
            { id: 'k1', key_alias: 'prod', tier: 'pool', status: 'active', created_at: new Date('2026-01-02Z') },
        ]);
        mockUsageGroupBy.mockResolvedValue([
            { model_slug: 'gpt-5.5', tier: 'pool', _count: { _all: 3 }, _sum: { cost_cny: '0.5' } },
        ]);
        mockRechargeFindMany.mockResolvedValue([
            { id: 'r1', amount: '100', source: 'payment', note: null, created_at: new Date('2026-01-03Z') },
        ]);

        const res = await DETAIL(detailReq('u1'), detailParams('u1'));
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(mockUserFindFirst.mock.calls[0][0].where).toMatchObject({ id: 'u1' });
        expect(mockUserFindFirst.mock.calls[0][0].where.tenant_id).toBeUndefined();
        expect(body.customer).toMatchObject({
            email: 'a@x.com',
            balance_cny: 7.2,
            used_cny: 3.6,
            admin_alias: '项目客户',
            newapi_user_id: 13,
            newapi_username: 'c-4e23b655',
        });
        expect(body.keys).toHaveLength(1);
        expect(body.keys[0]).toMatchObject({ key_alias: 'prod', tier: 'pool' });
        expect(body.usage_by_model[0]).toMatchObject({ model_slug: 'gpt-5.5', calls: 3, cost_cny: 0.5 });
        expect(body.recharges[0]).toMatchObject({ amount: 100, source: 'payment' });
        // P4c-1: no Account row → ledger balance ¥0, no entries (zero customer impact default).
        expect(body.ledger).toEqual({ balance_cny: 0, entries: [] });
        // flip-guardrail: BILLING_SOURCE unset in test env → false (UI grays the「迁移到 portal」钮).
        expect(body.billing_source_portal).toBe(false);
    });

    it('P4c-1: maps ledger balance + recent entries when an Account exists', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        mockUserFindFirst.mockResolvedValue({
            id: 'u1',
            email: 'a@x.com',
            nickname: null,
            status: 'active',
            created_at: new Date('2026-01-01T00:00:00Z'),
            last_login_at: null,
            newapi_quota_cache: BigInt(0),
            newapi_used_quota_cache: BigInt(0),
            newapi_cached_at: null,
        });
        mockAccountFindUnique.mockResolvedValue({
            balance_cny: '12.5',
            entries: [
                {
                    id: 'le1',
                    kind: 'adjustment',
                    amount_cny: '12.5',
                    balance_after: '12.5',
                    ref: null,
                    note: 'comp',
                    created_at: new Date('2026-01-05T00:00:00Z'),
                },
            ],
        });
        const res = await DETAIL(detailReq('u1'), detailParams('u1'));
        const body = await res.json();
        expect(body.ledger.balance_cny).toBe(12.5);
        expect(body.ledger.entries[0]).toMatchObject({
            kind: 'adjustment',
            amount_cny: 12.5,
            balance_after: 12.5,
            note: 'comp',
        });
        expect(mockAccountFindUnique.mock.calls[0][0].where).toMatchObject({ user_id: 'u1' });
    });

    it('detail keys query has no sk plaintext field selected (read-only)', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        mockUserFindFirst.mockResolvedValue({
            id: 'u1',
            email: 'a@x.com',
            nickname: null,
            status: 'active',
            created_at: new Date('2026-01-01T00:00:00Z'),
            last_login_at: null,
            newapi_quota_cache: BigInt(0),
            newapi_used_quota_cache: BigInt(0),
            newapi_cached_at: null,
        });
        await DETAIL(detailReq('u1'), detailParams('u1'));
        const keySelect = mockTokenFindMany.mock.calls[0][0].select;
        expect(keySelect.newapi_token_value).toBeUndefined();
        expect(keySelect).toMatchObject({ key_alias: true, tier: true, status: true });
    });

    it('header live-refetches balance: NULL cache + live value → shows live ¥, NOT ¥0 (2026-06-13 migrate-out regression)', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        mockUserFindFirst.mockResolvedValue({
            id: 'u1',
            email: 'a@x.com',
            nickname: null,
            status: 'active',
            created_at: new Date('2026-01-01T00:00:00Z'),
            last_login_at: null,
            // cache busted by migrate-out — column reads would show ¥0
            newapi_quota_cache: null,
            newapi_used_quota_cache: null,
            newapi_cached_at: null,
        });
        // live new-api: 1,000,000 quota → ¥14.4 remain, 500,000 → ¥7.2 used
        mockGetQuotaWithCache.mockResolvedValue({ remain_quota: 1_000_000, used_quota: 500_000, source: 'live' });

        const res = await DETAIL(detailReq('u1'), detailParams('u1'));
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(mockGetQuotaWithCache).toHaveBeenCalledWith('u1');
        expect(body.customer.balance_cny).toBeCloseTo(14.4, 5); // live, not 0
        expect(body.customer.used_cny).toBeCloseTo(7.2, 5);
        expect(body.customer.balance_cached_at).not.toBeNull(); // stamped fresh on live
    });

    it('header refetch fallback: live throws → degrades to cache columns, never 500s', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        mockUserFindFirst.mockResolvedValue({
            id: 'u1',
            email: 'a@x.com',
            nickname: null,
            status: 'active',
            created_at: new Date('2026-01-01T00:00:00Z'),
            last_login_at: null,
            newapi_quota_cache: BigInt(500_000), // ¥7.2
            newapi_used_quota_cache: BigInt(250_000), // ¥3.6
            newapi_cached_at: new Date('2026-01-02T00:00:00Z'),
        });
        mockGetQuotaWithCache.mockRejectedValue(new Error('new-api down'));

        const res = await DETAIL(detailReq('u1'), detailParams('u1'));
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.customer.balance_cny).toBeCloseTo(7.2, 5); // from cache column
        expect(body.customer.used_cny).toBeCloseTo(3.6, 5);
    });
});

describe('PATCH /api/admin/customers/[id] (admin alias)', () => {
    const id = '9e06cc13-7777-4eda-bf9d-fb0346e18bbb';
    const patch = (payload: unknown) =>
        SET_ALIAS(
            new NextRequest('https://x/api/admin/customers/' + id, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }),
            detailParams(id),
        );

    it('saves a trimmed alias with the tenant predicate on the write itself', async () => {
        mockResolveAdmin.mockResolvedValue(PARTNER_ADMIN);
        const response = await patch({ admin_alias: '  视频客户 A  ' });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ admin_alias: '视频客户 A' });
        expect(mockUserUpdateMany).toHaveBeenCalledWith({
            where: { id, tenant_id: 'tenant-7' },
            data: { admin_alias: '视频客户 A' },
        });
    });

    it('allows clearing the alias', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        const response = await patch({ admin_alias: '  ' });
        expect(await response.json()).toEqual({ admin_alias: null });
        expect(mockUserUpdateMany).toHaveBeenCalledWith({ where: { id }, data: { admin_alias: null } });
    });

    it('returns 404 for an out-of-tenant customer', async () => {
        mockResolveAdmin.mockResolvedValue(PARTNER_ADMIN);
        mockUserUpdateMany.mockResolvedValue({ count: 0 });
        expect((await patch({ admin_alias: '跨租户' })).status).toBe(404);
    });

    it('rejects unauthenticated writes and invalid payloads without updating the user', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await patch({ admin_alias: '新别名' })).status).toBe(401);
        mockResolveAdmin.mockResolvedValue(PARTNER_ADMIN);
        expect((await patch({ admin_alias: 'x'.repeat(81) })).status).toBe(400);
        expect((await patch({ admin_alias: '新别名', nickname: '客户昵称' })).status).toBe(400);
        expect(mockUserUpdateMany).not.toHaveBeenCalled();
    });
});
