/**
 * 企业客户 set-password 单测(P2):守门 / 校验 / bcrypt 落库 + 踢登。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { db, resolveAdmin, hash } = vi.hoisted(() => ({
    db: { user: { findFirst: vi.fn(), update: vi.fn() } },
    resolveAdmin: vi.fn(),
    hash: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => new Response(null, { status: 401 }),
}));
vi.mock('bcryptjs', () => ({ hash }));

import { POST } from '../set-password/route';

function req(body?: unknown): NextRequest {
    return new NextRequest('http://internal/api/admin/enterprise/set-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    resolveAdmin.mockResolvedValue({ user: { id: 'admin-1' } });
    hash.mockResolvedValue('$2a$12$hashed');
});

describe('POST /api/admin/enterprise/set-password', () => {
    it('非 superadmin → 401', async () => {
        resolveAdmin.mockResolvedValue(null);
        expect((await POST(req({ email: 'a@b.com', password: 'longenough' }))).status).toBe(401);
    });

    it('密码 <8 位 / 缺标识 → 400', async () => {
        expect((await POST(req({ email: 'a@b.com', password: 'short' }))).status).toBe(400);
        expect((await POST(req({ password: 'longenough' }))).status).toBe(400);
    });

    it('用户不存在 → 404', async () => {
        db.user.findFirst.mockResolvedValue(null);
        expect((await POST(req({ email: 'a@b.com', password: 'longenough' }))).status).toBe(404);
    });

    it('happy:bcrypt(12) 落库 + session_token_version++ 踢登', async () => {
        db.user.findFirst.mockResolvedValue({ id: 'u1', email: 'a@b.com' });
        db.user.update.mockResolvedValue({});
        const res = await POST(req({ email: 'a@b.com', password: 'longenough' }));
        expect(res.status).toBe(200);
        expect(hash).toHaveBeenCalledWith('longenough', 12);
        expect(db.user.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { password_hash: '$2a$12$hashed', session_token_version: { increment: 1 } },
        });
    });

    it('email 大小写归一:混合大小写按小写查(与 login/register 一致,2026-08-07)', async () => {
        db.user.findFirst.mockResolvedValue({ id: 'u1', email: 'mixed@case.com' });
        db.user.update.mockResolvedValue({});
        const res = await POST(req({ email: 'Mixed@Case.COM', password: 'longenough' }));
        expect(res.status).toBe(200);
        expect(db.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { email: 'mixed@case.com' } }));
    });
});
