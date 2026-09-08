/**
 * 企业运营后台两级守门 + 审计单测:super/secondary 解析、superOnly 门、
 * 权限不外溢(customer 无行 → null)、脱敏、fire-and-forget 落库。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { db, getCurrentUser, isBreakGlassToken } = vi.hoisted(() => ({
    db: {
        enterpriseAdmin: { findUnique: vi.fn() },
        adminAuditLog: { create: vi.fn(async () => ({})) },
    },
    getCurrentUser: vi.fn(),
    isBreakGlassToken: vi.fn(() => false),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser }));
vi.mock('@/lib/admin-auth', () => ({ isBreakGlassToken }));

import { auditAdminAction, redactAuditParams, resolveEnterpriseAdmin } from '../admin-auth';

const req = (headers: Record<string, string> = {}) =>
    new NextRequest('http://internal/api/admin/enterprise/credit', { method: 'POST', headers });

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    vi.clearAllMocks();
    isBreakGlassToken.mockReturnValue(false);
    db.adminAuditLog.create.mockResolvedValue({});
});

describe('resolveEnterpriseAdmin', () => {
    it('superadmin session → level=super', async () => {
        getCurrentUser.mockResolvedValue({ id: 'su', role: 'superadmin', status: 'active' });
        const r = await resolveEnterpriseAdmin(req());
        expect(r).toMatchObject({ level: 'super', viaBreakGlass: false });
        expect(db.enterpriseAdmin.findUnique).not.toHaveBeenCalled();
    });

    it('break-glass token → super(user=null)', async () => {
        getCurrentUser.mockResolvedValue(null);
        isBreakGlassToken.mockReturnValue(true);
        const r = await resolveEnterpriseAdmin(req());
        expect(r).toMatchObject({ level: 'super', user: null, viaBreakGlass: true });
    });

    it('enterprise_admins 有行的 customer → level=secondary(不动全局 role)', async () => {
        getCurrentUser.mockResolvedValue({ id: 'u2', role: 'customer', status: 'active' });
        db.enterpriseAdmin.findUnique.mockResolvedValue({ user_id: 'u2' });
        const r = await resolveEnterpriseAdmin(req());
        expect(r).toMatchObject({ level: 'secondary' });
    });

    it('无行的 customer → null(普通客户进不来)', async () => {
        getCurrentUser.mockResolvedValue({ id: 'u3', role: 'customer', status: 'active' });
        db.enterpriseAdmin.findUnique.mockResolvedValue(null);
        expect(await resolveEnterpriseAdmin(req())).toBeNull();
    });

    it('停用账号即使有行也拒(status != active)', async () => {
        getCurrentUser.mockResolvedValue({ id: 'u4', role: 'customer', status: 'disabled' });
        db.enterpriseAdmin.findUnique.mockResolvedValue({ user_id: 'u4' });
        expect(await resolveEnterpriseAdmin(req())).toBeNull();
    });

    it('superOnly:secondary 被拒,super 通过(监督面不给次级)', async () => {
        getCurrentUser.mockResolvedValue({ id: 'u2', role: 'customer', status: 'active' });
        db.enterpriseAdmin.findUnique.mockResolvedValue({ user_id: 'u2' });
        expect(await resolveEnterpriseAdmin(req(), { superOnly: true })).toBeNull();
        getCurrentUser.mockResolvedValue({ id: 'su', role: 'superadmin', status: 'active' });
        expect(await resolveEnterpriseAdmin(req(), { superOnly: true })).toMatchObject({ level: 'super' });
    });

    it('主站 admin/staff role【不】自动进企业后台(权限对称:无行照样拒)', async () => {
        getCurrentUser.mockResolvedValue({ id: 'u5', role: 'admin', status: 'active' });
        db.enterpriseAdmin.findUnique.mockResolvedValue(null);
        expect(await resolveEnterpriseAdmin(req())).toBeNull();
    });
});

describe('redactAuditParams', () => {
    it('password / upstream_key / secret / token 字段值 → [redacted]', () => {
        const out = redactAuditParams({
            email: 'a@b.com',
            password: 'hunter22',
            upstream_key: 'sk-real-key',
            nested: { api_secret: 'x', access_token: 'y', note: 'keep' },
        }) as Record<string, unknown>;
        expect(out.email).toBe('a@b.com');
        expect(out.password).toBe('[redacted]');
        expect(out.upstream_key).toBe('[redacted]');
        expect((out.nested as Record<string, unknown>).api_secret).toBe('[redacted]');
        expect((out.nested as Record<string, unknown>).access_token).toBe('[redacted]');
        expect((out.nested as Record<string, unknown>).note).toBe('keep');
    });

    it('非敏感字段与非字符串值原样', () => {
        expect(redactAuditParams({ amount_cny: 100, note: 'x', flag: true })).toEqual({
            amount_cny: 100,
            note: 'x',
            flag: true,
        });
    });
});

describe('auditAdminAction', () => {
    const superAdmin = {
        user: { id: 'su', email: 'boss@x.com' } as never,
        level: 'super' as const,
        viaBreakGlass: false,
    };

    it('落行:操作者/等级/action/target/脱敏后 params/IP/UA', async () => {
        auditAdminAction(
            req({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1', 'user-agent': 'test-ua' }),
            superAdmin,
            'credit',
            { target: 'cust@x.com', params: { amount_cny: 100, password: 'zzz' } },
        );
        await flush();
        const data = (db.adminAuditLog.create.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>)[0][0]
            .data;
        expect(data).toMatchObject({
            admin_user_id: 'su',
            admin_email: 'boss@x.com',
            level: 'super',
            action: 'credit',
            method: 'POST',
            path: '/api/admin/enterprise/credit',
            target: 'cust@x.com',
            client_ip: '1.2.3.4',
            user_agent: 'test-ua',
        });
        expect(data.params).toContain('"amount_cny":100');
        expect(data.params).toContain('[redacted]');
        expect(data.params).not.toContain('zzz');
    });

    it('break-glass → level=break_glass,admin 字段空', async () => {
        auditAdminAction(req(), { user: null, level: 'super', viaBreakGlass: true }, 'onboard');
        await flush();
        const data = (db.adminAuditLog.create.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>)[0][0]
            .data;
        expect(data).toMatchObject({ admin_user_id: null, admin_email: null, level: 'break_glass' });
    });

    it('写失败绝不抛(fire-and-forget)', async () => {
        db.adminAuditLog.create.mockRejectedValue(new Error('db down'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(() => auditAdminAction(req(), superAdmin, 'credit')).not.toThrow();
        await flush();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
