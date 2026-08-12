/**
 * 运营后台数据端点单测:客户列表 / 详情 / 密钥启停(全部 superadmin 门)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { db, resolveAdmin } = vi.hoisted(() => ({
    db: {
        enterpriseUpstreamKey: {
            findMany: vi.fn(),
            findUnique: vi.fn(),
            updateMany: vi.fn(),
            upsert: vi.fn(),
            count: vi.fn(),
        },
        enterpriseKey: { groupBy: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
        enterpriseAkSk: { updateMany: vi.fn() },
        enterpriseModelDiscount: { findMany: vi.fn() },
        user: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
        account: { findMany: vi.fn(), findUnique: vi.fn() },
        ledgerEntry: { groupBy: vi.fn(), aggregate: vi.fn(), findMany: vi.fn() },
        seedanceVideoTask: { findMany: vi.fn() },
        $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    },
    resolveAdmin: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => new Response(null, { status: 401 }),
}));
vi.mock('@/lib/enterprise/crypto', () => ({ encryptUpstreamKey: (k: string) => `enc(${k})` }));

import { GET as listGET } from '../customers/route';
import { GET as detailGET, PATCH as customerPATCH, DELETE as customerDELETE } from '../customers/[id]/route';
import { PATCH as keyPATCH } from '../keys/[id]/route';
import { POST as upstreamKeyPOST } from '../upstream-key/route';

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
        db.enterpriseModelDiscount.findMany.mockResolvedValue([{ region: 'cn', variant: 'mini', discount: '0.8' }]);
        db.ledgerEntry.findMany.mockResolvedValue([]);
        db.seedanceVideoTask.findMany.mockResolvedValue([]);
        const res = await detailGET(req('/x'), params);
        expect(res.status).toBe(200);
        const j = (await res.json()) as Record<string, unknown>;
        expect((j.keys as unknown[]).length).toBe(1);
        expect((j.overrides as Array<{ discount: number }>)[0].discount).toBe(0.8);
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
            where: { user_id: 'u1', region: 'cn' },
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

describe('POST /api/admin/enterprise/upstream-key(版本上游 key upsert)', () => {
    const UID = '11111111-2222-4333-8444-555555555555';

    it('global 开通:upsert (user, global) 行,secret 加密存;user 不存在 404;非法 region 400;非 superadmin 401', async () => {
        db.user.findUnique.mockResolvedValue({ id: UID });
        db.enterpriseUpstreamKey.upsert.mockResolvedValue({});
        const ok = await upstreamKeyPOST(
            req('/x', 'POST', { user_id: UID, region: 'global', upstream_key: 'sk-intl-123456', note: '海外' }),
        );
        expect(ok.status).toBe(200);
        expect(db.enterpriseUpstreamKey.upsert).toHaveBeenCalledWith({
            where: { user_id_region: { user_id: UID, region: 'global' } },
            create: { user_id: UID, region: 'global', upstream_key_enc: 'enc(sk-intl-123456)', note: '海外' },
            update: { upstream_key_enc: 'enc(sk-intl-123456)', note: '海外' },
        });
        expect(
            (await upstreamKeyPOST(req('/x', 'POST', { user_id: UID, region: 'jp', upstream_key: 'sk-x-123456' })))
                .status,
        ).toBe(400);
        db.user.findUnique.mockResolvedValue(null);
        expect(
            (await upstreamKeyPOST(req('/x', 'POST', { user_id: UID, region: 'global', upstream_key: 'sk-x-123456' })))
                .status,
        ).toBe(404);
        resolveAdmin.mockResolvedValue(null);
        expect(
            (await upstreamKeyPOST(req('/x', 'POST', { user_id: UID, region: 'global', upstream_key: 'sk-x-123456' })))
                .status,
        ).toBe(401);
    });
});

describe('DELETE /api/admin/enterprise/customers/[id] — 软删除账号', () => {
    const UID = '11111111-1111-4111-8111-111111111111';
    const p = { params: Promise.resolve({ id: UID }) };

    it('软删除:置 deleted_at + 禁 keys/aksk + user.status=disabled;保留历史', async () => {
        db.enterpriseUpstreamKey.count.mockResolvedValue(2);
        db.enterpriseUpstreamKey.updateMany.mockResolvedValue({ count: 2 });
        db.enterpriseKey.updateMany.mockResolvedValue({ count: 3 });
        db.enterpriseAkSk.updateMany.mockResolvedValue({ count: 1 });
        db.user.updateMany.mockResolvedValue({ count: 1 });
        const res = await customerDELETE(req(`/${UID}`, 'DELETE'), p);
        expect(res.status).toBe(200);
        expect((await res.json()).deleted).toBe(true);
        // upstream keys 置 deleted_at(仅未删的行)
        expect(db.enterpriseUpstreamKey.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { user_id: UID, deleted_at: null },
                data: expect.objectContaining({ deleted_at: expect.any(Date) }),
            }),
        );
        // keys / aksk 禁用
        expect(db.enterpriseKey.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: 'disabled' } }),
        );
        expect(db.enterpriseAkSk.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: 'disabled' } }),
        );
        // user 停用(登录被拒)
        expect(db.user.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ id: UID }), data: { status: 'disabled' } }),
        );
    });

    it('非企业客户(无 upstream key 行)→ 404', async () => {
        db.enterpriseUpstreamKey.count.mockResolvedValue(0);
        expect((await customerDELETE(req(`/${UID}`, 'DELETE'), p)).status).toBe(404);
    });

    it('非 superadmin → 401', async () => {
        resolveAdmin.mockResolvedValue(null);
        expect((await customerDELETE(req(`/${UID}`, 'DELETE'), p)).status).toBe(401);
    });
});
