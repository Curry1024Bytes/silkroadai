/**
 * 请求日志 admin 端点单测:CSV 导出(superadmin 门 + BOM + 筛选透传 + 行上限)+ 单条 JSON 下载。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { db, resolveAdmin } = vi.hoisted(() => ({
    db: {
        enterpriseRequestLog: { findMany: vi.fn(), findUnique: vi.fn() },
        user: { findMany: vi.fn() },
    },
    resolveAdmin: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
// 2026-09-04 起路由守门换到 enterprise/admin-auth(两级管理员);测试沿用 resolveAdmin 变量名
vi.mock('@/lib/enterprise/admin-auth', () => ({
    resolveEnterpriseAdmin: resolveAdmin,
    auditAdminAction: vi.fn(),
}));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => new Response(null, { status: 401 }),
}));

import { GET as exportGET } from '../logs/export/route';
import { GET as detailGET } from '../logs/[id]/route';

const req = (url: string) => new NextRequest(`http://internal${url}`);

const LOG_ROW = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    created_at: new Date('2026-09-03T04:00:00Z'),
    kind: 'submit',
    format: 'v1',
    user_id: 'u1',
    region: 'volc',
    model: 'doubao-seedance-2.5',
    task_id: 'cgt-1',
    vendor_task_id: null,
    client_request_id: 'cli-1',
    http_status: 200,
    upstream_status: 200,
    cache_hit: false,
    outcome: null,
    error_code: null,
    error_message: null,
    duration_ms: 1234,
    upstream_ms: 900,
    client_ip: '1.2.3.4',
};

beforeEach(() => {
    vi.clearAllMocks();
    resolveAdmin.mockResolvedValue({ user: { id: 'admin-1' } });
    db.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@b.com' }]);
});

describe('GET /api/admin/enterprise/logs/export', () => {
    it('非 superadmin → 401', async () => {
        resolveAdmin.mockResolvedValue(null);
        const res = await exportGET(req('/api/admin/enterprise/logs/export'));
        expect(res.status).toBe(401);
        expect(db.enterpriseRequestLog.findMany).not.toHaveBeenCalled();
    });

    it('CSV:UTF-8 BOM 头 + 客户邮箱 + 北京时间;筛选转成 where', async () => {
        db.enterpriseRequestLog.findMany.mockResolvedValue([LOG_ROW]);
        const res = await exportGET(req('/api/admin/enterprise/logs/export?region=volc&kind=submit&q=cgt-1'));
        expect(res.status).toBe(200);
        const buf = new Uint8Array(await res.arrayBuffer());
        expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]); // BOM(Response.text() 会剥,读字节验)
        const text = new TextDecoder().decode(buf);
        expect(text).toContain('a@b.com');
        expect(text).toContain('2026-09-03 12:00:00'); // UTC 04:00 → 北京 12:00
        expect(text).toContain('doubao-seedance-2.5');
        const where = db.enterpriseRequestLog.findMany.mock.calls[0][0].where;
        expect(where.region).toBe('volc');
        expect(where.kind).toBe('submit');
        expect(where.OR).toHaveLength(4);
    });

    it('超 5 万行 → 400 提示缩小范围', async () => {
        db.enterpriseRequestLog.findMany.mockResolvedValue(
            Array.from({ length: 50_001 }, (_, i) => ({ ...LOG_ROW, id: `id-${i}` })),
        );
        const res = await exportGET(req('/api/admin/enterprise/logs/export'));
        expect(res.status).toBe(400);
    });
});

describe('GET /api/admin/enterprise/logs/[id]', () => {
    const params = (id: string) => ({ params: Promise.resolve({ id }) });

    it('非 superadmin → 401', async () => {
        resolveAdmin.mockResolvedValue(null);
        const res = await detailGET(req('/api/admin/enterprise/logs/x'), params(LOG_ROW.id));
        expect(res.status).toBe(401);
    });

    it('非 uuid → 400;未找到 → 404', async () => {
        expect((await detailGET(req('/x'), params('nope'))).status).toBe(400);
        db.enterpriseRequestLog.findUnique.mockResolvedValue(null);
        expect((await detailGET(req('/x'), params(LOG_ROW.id))).status).toBe(404);
    });

    it('?download=1 → attachment;全量字段含 body 原文', async () => {
        db.enterpriseRequestLog.findUnique.mockResolvedValue({
            ...LOG_ROW,
            request_body: '{"model":"doubao-seedance-2.5"}',
            upstream_body: '{"id":"kz-cgt-1"}',
            user_agent: 'curl/8',
        });
        const res = await detailGET(req(`/x?download=1`), params(LOG_ROW.id));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-disposition')).toContain('attachment');
        const j = (await res.json()) as Record<string, unknown>;
        expect(j.upstream_body).toContain('kz-cgt-1');
    });
});
