/**
 * 运营后台数据端点单测:客户列表 / 详情 / 密钥启停(全部 superadmin 门)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { db, resolveAdmin } = vi.hoisted(() => ({
    db: {
        enterpriseUpstreamKey: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
        enterpriseKey: { groupBy: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
        enterpriseRateOverride: { findMany: vi.fn() },
        user: { findMany: vi.fn(), findUnique: vi.fn() },
        account: { findMany: vi.fn(), findUnique: vi.fn() },
        ledgerEntry: { groupBy: vi.fn(), aggregate: vi.fn(), findMany: vi.fn() },
        seedanceVideoTask: { findMany: vi.fn() },
    },
    resolveAdmin: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => new Response(null, { status: 401 }),
}));

import { GET as listGET } from '../customers/route';
import { GET as detailGET, PATCH as customerPATCH } from '../customers/[id]/route';
import { PATCH as keyPATCH } from '../keys/[id]/route';

const req = (url: string, method = 'GET', body?: unknown) =>
    new NextRequest(`http://internal${url}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

beforeEach(() => {
    vi.clearAllMocks();
    resolveAdmin.mockResolvedValue({ user: { id: 'admin-1' } });
});

describe('GET /api/admin/enterprise/customers', () => {
    it('非 superadmin → 401', async () => {
        resolveAdmin.mockResolvedValue(null);
        expect((await listGET(req('/api/admin/enterprise/customers'))).status).toBe(401);
    });

    it('列表 = 有上游 key 的用户,带余额/消费/active key 数', async () => {
        db.enterpriseUpstreamKey.findMany.mockResolvedValue([{ user_id: 'u1', note: '客户A上游' }]);
        db.user.findMany.mockResolvedValue([
            { id: 'u1', email: 'a@b.com', nickname: '客户A', created_at: new Date('2026-07-19') },
        ]);
        db.account.findMany.mockResolvedValue([{ id: 'acc1', user_id: 'u1', balance_cny: '8.80529' }]);
        db.enterpriseKey.groupBy.mockResolvedValue([{ user_id: 'u1', status: 'active', _count: { _all: 2 } }]);
        db.ledgerEntry.groupBy.mockResolvedValue([{ account_id: 'acc1', _sum: { amount_cny: '-9.80936' } }]);
        const res = await listGET(req('/api/admin/enterprise/customers'));
        const j = (await res.json()) as { customers: Array<Record<string, unknown>> };
        expect(j.customers).toHaveLength(1);
        expect(j.customers[0]).toMatchObject({
            user_id: 'u1',
            email: 'a@b.com',
            active_keys: 2,
            upstream_note: '客户A上游',
        });
        expect(j.customers[0].balance_cny).toBeCloseTo(8.80529, 4);
        expect(j.customers[0].spent_cny).toBeCloseTo(9.80936, 4);
    });
});

describe('GET /api/admin/enterprise/customers/[id]', () => {
    const params = { params: Promise.resolve({ id: 'u1' }) };

    it('非企业客户 → 404', async () => {
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue(null);
        db.user.findUnique.mockResolvedValue(null);
        expect((await detailGET(req('/x'), params)).status).toBe(404);
    });

    it('详情带 keys/overrides/ledger/tasks', async () => {
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ note: 'n', created_at: new Date() });
        db.user.findUnique.mockResolvedValue({
            id: 'u1',
            email: 'a@b.com',
            nickname: null,
            created_at: new Date(),
        });
        db.account.findUnique.mockResolvedValue({ id: 'acc1', balance_cny: '10' });
        db.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amount_cny: '-4.25' } });
        db.enterpriseKey.findMany.mockResolvedValue([
            {
                id: 'k1',
                name: 'default',
                key_prefix: 'sk-ent-abcde',
                status: 'active',
                created_at: new Date(),
                last_used_at: null,
            },
        ]);
        db.enterpriseRateOverride.findMany.mockResolvedValue([
            { variant: 'mini', resolution: '720p', has_video: false, cny_per_m: '15' },
        ]);
        db.ledgerEntry.findMany.mockResolvedValue([]);
        db.seedanceVideoTask.findMany.mockResolvedValue([]);
        const res = await detailGET(req('/x'), params);
        expect(res.status).toBe(200);
        const j = (await res.json()) as Record<string, unknown>;
        expect((j.keys as unknown[]).length).toBe(1);
        expect((j.overrides as Array<{ cny_per_m: number }>)[0].cny_per_m).toBe(15);
        expect(j.spent_cny).toBeCloseTo(4.25, 4);
    });
});

describe('PATCH /api/admin/enterprise/customers/[id](折扣率)', () => {
    const params = { params: Promise.resolve({ id: 'u1' }) };

    it('设置 0.9 → updateMany;非法(0 / 3 / 缺字段)→ 400;不存在 → 404;非 superadmin → 401', async () => {
        db.enterpriseUpstreamKey.updateMany.mockResolvedValue({ count: 1 });
        const ok = await customerPATCH(req('/x', 'PATCH', { discount: 0.9 }), params);
        expect(ok.status).toBe(200);
        expect(db.enterpriseUpstreamKey.updateMany).toHaveBeenCalledWith({
            where: { user_id: 'u1' },
            data: { discount: 0.9 },
        });
        expect((await customerPATCH(req('/x', 'PATCH', { discount: 0 }), params)).status).toBe(400);
        expect((await customerPATCH(req('/x', 'PATCH', { discount: 3 }), params)).status).toBe(400);
        expect((await customerPATCH(req('/x', 'PATCH', {}), params)).status).toBe(400);
        db.enterpriseUpstreamKey.updateMany.mockResolvedValue({ count: 0 });
        expect((await customerPATCH(req('/x', 'PATCH', { discount: 0.9 }), params)).status).toBe(404);
        resolveAdmin.mockResolvedValue(null);
        expect((await customerPATCH(req('/x', 'PATCH', { discount: 0.9 }), params)).status).toBe(401);
    });
});

describe('PATCH /api/admin/enterprise/keys/[id]', () => {
    const params = { params: Promise.resolve({ id: 'k1' }) };

    it('启用/禁用;非法 status → 400;不存在 → 404', async () => {
        db.enterpriseKey.updateMany.mockResolvedValue({ count: 1 });
        const ok = await keyPATCH(req('/x', 'PATCH', { status: 'disabled' }), params);
        expect(ok.status).toBe(200);
        expect(db.enterpriseKey.updateMany).toHaveBeenCalledWith({
            where: { id: 'k1' },
            data: { status: 'disabled' },
        });
        expect((await keyPATCH(req('/x', 'PATCH', { status: 'weird' }), params)).status).toBe(400);
        db.enterpriseKey.updateMany.mockResolvedValue({ count: 0 });
        expect((await keyPATCH(req('/x', 'PATCH', { status: 'active' }), params)).status).toBe(404);
    });

    it('非 superadmin → 401', async () => {
        resolveAdmin.mockResolvedValue(null);
        expect((await keyPATCH(req('/x', 'PATCH', { status: 'active' }), params)).status).toBe(401);
    });
});
