/**
 * 企业密钥管理 API 单测(P2):cookie 会话守门 / 上限 / 明文一次性 / IDOR 禁用。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { db, requireEnterpriseUser } = vi.hoisted(() => ({
    db: {
        enterpriseKey: { findMany: vi.fn(), count: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
        enterpriseUpstreamKey: { findUnique: vi.fn() },
    },
    requireEnterpriseUser: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/enterprise/session', () => ({ requireEnterpriseUser }));

import { GET, POST } from '../keys/route';
import { DELETE } from '../keys/[id]/route';

const USER = { id: 'u1', tenant_id: null };

function req(method: string, body?: unknown): NextRequest {
    return new NextRequest('http://internal/api/enterprise/keys', {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ id: 'up1' }); // 版本默认已开通
    requireEnterpriseUser.mockResolvedValue(USER);
});

describe('GET /api/enterprise/keys', () => {
    it('未登录/非企业客户 → 401', async () => {
        requireEnterpriseUser.mockResolvedValue(null);
        expect((await GET(req('GET'))).status).toBe(401);
    });

    it('只查本人的 key,select 不含 key_hash', async () => {
        db.enterpriseKey.findMany.mockResolvedValue([]);
        const res = await GET(req('GET'));
        expect(res.status).toBe(200);
        const call = db.enterpriseKey.findMany.mock.calls[0][0];
        expect(call.where).toEqual({ user_id: 'u1' });
        expect(call.select.key_hash).toBeUndefined();
    });
});

describe('POST /api/enterprise/keys', () => {
    it('active 满 10 → 400 key_limit_reached', async () => {
        db.enterpriseKey.count.mockResolvedValue(10);
        const res = await POST(req('POST', { name: 'prod' }));
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe('key_limit_reached');
        expect(db.enterpriseKey.create).not.toHaveBeenCalled();
    });

    it('happy:返明文 sk-ent- 一次 + row;DB 只存 hash', async () => {
        db.enterpriseKey.count.mockResolvedValue(1);
        db.enterpriseKey.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({
                id: 'k-new',
                name: data.name,
                key_prefix: data.key_prefix,
                status: 'active',
                created_at: new Date(),
                last_used_at: null,
            }),
        );
        const res = await POST(req('POST', { name: 'prod' }));
        expect(res.status).toBe(200);
        const j = (await res.json()) as { key: string; row: { key_prefix: string } };
        expect(j.key).toMatch(/^sk-ent-[0-9a-f]{48}$/);
        expect(j.key.startsWith(j.row.key_prefix)).toBe(true);
        const created = db.enterpriseKey.create.mock.calls[0][0].data;
        expect(created.key_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(created)).not.toContain(j.key); // 明文不落库
    });

    it('name 缺失/空 → 400', async () => {
        expect((await POST(req('POST', { name: '' }))).status).toBe(400);
    });
});

describe('DELETE /api/enterprise/keys/[id]', () => {
    const params = { params: Promise.resolve({ id: 'k1' }) };

    it('IDOR:updateMany 带 (id, user_id);别人的 key → 0 行 → 404', async () => {
        db.enterpriseKey.updateMany.mockResolvedValue({ count: 0 });
        const res = await DELETE(req('DELETE'), params);
        expect(res.status).toBe(404);
        expect(db.enterpriseKey.updateMany).toHaveBeenCalledWith({
            where: { id: 'k1', user_id: 'u1' },
            data: { status: 'disabled' },
        });
    });

    it('本人 key → 软禁用成功', async () => {
        db.enterpriseKey.updateMany.mockResolvedValue({ count: 1 });
        expect((await DELETE(req('DELETE'), params)).status).toBe(200);
    });

    it('未登录 → 401 不触 DB', async () => {
        requireEnterpriseUser.mockResolvedValue(null);
        expect((await DELETE(req('DELETE'), params)).status).toBe(401);
        expect(db.enterpriseKey.updateMany).not.toHaveBeenCalled();
    });
});

describe('POST /api/enterprise/keys — 版本开通门(2026-07-24)', () => {
    it('该版本未配上游 key → 400 region_not_enabled(防拿到 key 一调 503)', async () => {
        requireEnterpriseUser.mockResolvedValue({ id: 'u1', tenant_id: null });
        db.enterpriseKey.count.mockResolvedValue(0);
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue(null);
        const res = await POST(
            new NextRequest('http://x/api/enterprise/keys', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'k', region: 'promax' }),
            }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe('region_not_enabled');
        expect(db.enterpriseUpstreamKey.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { user_id_region: { user_id: 'u1', region: 'promax' } } }),
        );
        expect(db.enterpriseKey.create).not.toHaveBeenCalled();
    });
});
