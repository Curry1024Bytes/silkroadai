/**
 * 次级管理员管理端点单测:superOnly 门 / 授予(已有账号·新建账号·缺密码)/
 * 撤销 / 审计留痕(admin_grant / admin_revoke)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { db, resolveEnterpriseAdmin, auditAdminAction, hash } = vi.hoisted(() => ({
    db: {
        enterpriseAdmin: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
        user: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    },
    resolveEnterpriseAdmin: vi.fn(),
    auditAdminAction: vi.fn(),
    hash: vi.fn(async () => 'bcrypt-hash'),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/enterprise/admin-auth', () => ({ resolveEnterpriseAdmin, auditAdminAction }));
vi.mock('@/lib/admin-auth', () => ({ unauthorizedResponse: () => new Response(null, { status: 401 }) }));
vi.mock('bcryptjs', () => ({ hash }));

import { GET as listGET, POST as grantPOST } from '../admins/route';
import { DELETE as revokeDELETE } from '../admins/[id]/route';

const req = (method: string, body?: unknown) =>
    new NextRequest('http://internal/api/admin/enterprise/admins', {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

const SUPER = { user: { id: 'su', email: 'boss@x.com' }, level: 'super', viaBreakGlass: false };

beforeEach(() => {
    vi.clearAllMocks();
    resolveEnterpriseAdmin.mockResolvedValue(SUPER);
    db.enterpriseAdmin.findMany.mockResolvedValue([]);
    db.user.findMany.mockResolvedValue([]);
});

describe('守门(superOnly)', () => {
    it('非 super → 401,且传了 superOnly 选项', async () => {
        resolveEnterpriseAdmin.mockResolvedValue(null);
        expect((await listGET(req('GET'))).status).toBe(401);
        expect((await grantPOST(req('POST', { email: 'a@b.com' }))).status).toBe(401);
        expect((await revokeDELETE(req('DELETE'), { params: Promise.resolve({ id: 'u1' }) })).status).toBe(401);
        for (const call of resolveEnterpriseAdmin.mock.calls) {
            expect(call[1]).toEqual({ superOnly: true });
        }
    });
});

describe('POST 授予', () => {
    it('已有账号:直接加行,不动密码;审计 admin_grant', async () => {
        db.user.findUnique.mockResolvedValue({ id: 'u1', status: 'active' });
        db.enterpriseAdmin.upsert.mockResolvedValue({});
        const res = await grantPOST(req('POST', { email: 'Ops1@X.com', note: '合伙人A' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
            ok: true,
            user_id: 'u1',
            email: 'ops1@x.com',
            account_created: false,
        });
        expect(db.user.create).not.toHaveBeenCalled();
        expect(db.enterpriseAdmin.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { user_id: 'u1' } }));
        expect(auditAdminAction).toHaveBeenCalledWith(
            expect.anything(),
            SUPER,
            'admin_grant',
            expect.objectContaining({ target: 'ops1@x.com' }),
        );
    });

    it('新账号:email+password 建裸 User(bcrypt,验证过邮箱,不 provision new-api)', async () => {
        db.user.findUnique.mockResolvedValue(null);
        db.user.create.mockResolvedValue({ id: 'u9', status: 'active' });
        db.enterpriseAdmin.upsert.mockResolvedValue({});
        const res = await grantPOST(req('POST', { email: 'ops2@x.com', password: 'S3curePwd!' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, account_created: true });
        expect(hash).toHaveBeenCalledWith('S3curePwd!', 12);
        const created = db.user.create.mock.calls[0][0].data;
        expect(created).toMatchObject({ email: 'ops2@x.com', password_hash: 'bcrypt-hash', email_verified: true });
        expect(created).not.toHaveProperty('newapi_user_id');
    });

    it('无账号且没给密码 → 400 提示', async () => {
        db.user.findUnique.mockResolvedValue(null);
        const res = await grantPOST(req('POST', { email: 'ops3@x.com' }));
        expect(res.status).toBe(400);
        expect(db.enterpriseAdmin.upsert).not.toHaveBeenCalled();
    });

    it('已有账号 + 又传密码 → 409(不许授予顺手改密)', async () => {
        db.user.findUnique.mockResolvedValue({ id: 'u1', status: 'active' });
        const res = await grantPOST(req('POST', { email: 'ops1@x.com', password: 'whatever123' }));
        expect(res.status).toBe(409);
        expect(db.enterpriseAdmin.upsert).not.toHaveBeenCalled();
    });

    it('停用账号 → 400', async () => {
        db.user.findUnique.mockResolvedValue({ id: 'u1', status: 'disabled' });
        expect((await grantPOST(req('POST', { email: 'ops1@x.com' }))).status).toBe(400);
    });
});

describe('DELETE 撤销', () => {
    it('删行 + 审计 admin_revoke;账号保留', async () => {
        db.user.findUnique.mockResolvedValue({ email: 'ops1@x.com' });
        db.enterpriseAdmin.deleteMany.mockResolvedValue({ count: 1 });
        const res = await revokeDELETE(req('DELETE'), { params: Promise.resolve({ id: 'u1' }) });
        expect(res.status).toBe(200);
        expect(db.enterpriseAdmin.deleteMany).toHaveBeenCalledWith({ where: { user_id: 'u1' } });
        expect(auditAdminAction).toHaveBeenCalledWith(
            expect.anything(),
            SUPER,
            'admin_revoke',
            expect.objectContaining({ target: 'ops1@x.com' }),
        );
    });

    it('行不存在 → 404,不审计', async () => {
        db.user.findUnique.mockResolvedValue(null);
        db.enterpriseAdmin.deleteMany.mockResolvedValue({ count: 0 });
        const res = await revokeDELETE(req('DELETE'), { params: Promise.resolve({ id: 'u1' }) });
        expect(res.status).toBe(404);
        expect(auditAdminAction).not.toHaveBeenCalled();
    });
});
