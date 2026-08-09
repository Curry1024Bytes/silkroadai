/**
 * 全局折扣路由单测:守门 / 校验 / 设置(upsert)/ 清除(discount=null)/ 列表。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { db, resolveAdmin } = vi.hoisted(() => ({
    db: {
        enterpriseGlobalDiscount: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    },
    resolveAdmin: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin }));
vi.mock('@/lib/admin-auth', () => ({ unauthorizedResponse: () => new Response(null, { status: 401 }) }));

import { GET, POST } from '../global-discount/route';

function req(body?: unknown, method = 'POST'): NextRequest {
    return new NextRequest('http://internal/api/admin/enterprise/global-discount', {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    resolveAdmin.mockResolvedValue({ user: { id: 'admin-1' } });
    db.enterpriseGlobalDiscount.upsert.mockResolvedValue({ discount: '0.6', expires_at: null });
    db.enterpriseGlobalDiscount.deleteMany.mockResolvedValue({ count: 1 });
    db.enterpriseGlobalDiscount.findMany.mockResolvedValue([]);
});

describe('POST /api/admin/enterprise/global-discount', () => {
    it('非 superadmin → 401', async () => {
        resolveAdmin.mockResolvedValue(null);
        expect((await POST(req({ region: 'cn', variant: 'fast', discount: 0.6 }))).status).toBe(401);
    });

    it('非法 region/variant/discount → 400', async () => {
        expect((await POST(req({ region: 'xx', variant: 'fast', discount: 0.6 }))).status).toBe(400);
        expect((await POST(req({ region: 'cn', variant: 'nope', discount: 0.6 }))).status).toBe(400);
        expect((await POST(req({ region: 'cn', variant: 'fast', discount: 3 }))).status).toBe(400);
    });

    it('设置:upsert 到 (region, variant),带 expires_at', async () => {
        const res = await POST(
            req({ region: 'cn', variant: 'fast', discount: 0.6, expires_at: '2026-09-08T00:00:00.000Z' }),
        );
        expect(res.status).toBe(200);
        expect(db.enterpriseGlobalDiscount.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ where: { region_variant: { region: 'cn', variant: 'fast' } } }),
        );
    });

    it('discount=null → 清除该档(deleteMany),不 upsert', async () => {
        const res = await POST(req({ region: 'cn', variant: 'mini', discount: null }));
        expect(res.status).toBe(200);
        expect((await res.json()).cleared).toBe(true);
        expect(db.enterpriseGlobalDiscount.deleteMany).toHaveBeenCalledWith({
            where: { region: 'cn', variant: 'mini' },
        });
        expect(db.enterpriseGlobalDiscount.upsert).not.toHaveBeenCalled();
    });
});

describe('GET /api/admin/enterprise/global-discount', () => {
    it('列出并标记 expired', async () => {
        db.enterpriseGlobalDiscount.findMany.mockResolvedValue([
            {
                region: 'cn',
                variant: 'fast',
                discount: '0.6',
                expires_at: new Date(Date.now() - 1000),
                note: null,
                created_at: new Date(),
            },
            { region: 'cn', variant: 'mini', discount: '0.7', expires_at: null, note: 'x', created_at: new Date() },
        ]);
        const j = (await (await GET(req(undefined, 'GET'))).json()) as {
            discounts: Array<{ variant: string; expired: boolean }>;
        };
        expect(j.discounts.find((d) => d.variant === 'fast')?.expired).toBe(true);
        expect(j.discounts.find((d) => d.variant === 'mini')?.expired).toBe(false);
    });
});
