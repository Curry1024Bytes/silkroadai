/** AK/SK 自助端点单测(2026-07-28):守门 401 / 生成返明文一次 / 禁用 IDOR。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { db, requireEnterpriseUser } = vi.hoisted(() => ({
    db: { enterpriseAkSk: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() } },
    requireEnterpriseUser: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/enterprise/session', () => ({ requireEnterpriseUser }));
vi.mock('@/lib/enterprise/crypto', () => ({ encryptSecret: (s: string) => `enc(${s})` }));

import { GET, POST } from '../route';
import { DELETE } from '../[id]/route';

const req = (method: string, body?: unknown) =>
    new NextRequest('http://internal/api/enterprise/aksk', {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

beforeEach(() => {
    vi.clearAllMocks();
    requireEnterpriseUser.mockResolvedValue({ id: 'u1', tenant_id: null });
});

describe('POST /api/enterprise/aksk', () => {
    it('未登录 → 401', async () => {
        requireEnterpriseUser.mockResolvedValue(null);
        expect((await POST(req('POST', { name: 'x' }))).status).toBe(401);
    });

    it('生成:返 AK 明文 + SK 明文(一次)+ DB 存密文', async () => {
        db.enterpriseAkSk.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({
                id: 'ak1',
                access_key: data.access_key,
                name: data.name,
                status: 'active',
                created_at: new Date(),
                last_used_at: null,
            }),
        );
        const res = await POST(req('POST', { name: 'prod-signer' }));
        expect(res.status).toBe(200);
        const j = (await res.json()) as { access_key: string; secret_key: string };
        expect(j.access_key).toMatch(/^ak_ent_[0-9a-f]{24}$/);
        expect(j.secret_key).toMatch(/^sk_ent_[0-9a-f]{48}$/);
        // DB 存的是密文,不是明文 SK
        const created = db.enterpriseAkSk.create.mock.calls[0][0].data as Record<string, string>;
        expect(created.secret_key_enc).toBe(`enc(${j.secret_key})`);
        expect(created.access_key).toBe(j.access_key);
    });

    it('缺 name → 400', async () => {
        expect((await POST(req('POST', {}))).status).toBe(400);
    });
});

describe('GET /api/enterprise/aksk', () => {
    it('列表永不回 SK/密文', async () => {
        db.enterpriseAkSk.findMany.mockResolvedValue([
            {
                id: 'ak1',
                access_key: 'ak_ent_x',
                name: 'p',
                status: 'active',
                created_at: new Date(),
                last_used_at: null,
            },
        ]);
        const res = await GET(req('GET'));
        const j = (await res.json()) as { items: Array<Record<string, unknown>> };
        expect(j.items[0].access_key).toBe('ak_ent_x');
        expect(j.items[0]).not.toHaveProperty('secret_key_enc');
    });
});

describe('DELETE /api/enterprise/aksk/[id]', () => {
    const params = { params: Promise.resolve({ id: 'ak1' }) };
    it('禁用本人;非本人/不存在 → 404;未登录 → 401', async () => {
        db.enterpriseAkSk.updateMany.mockResolvedValue({ count: 1 });
        expect((await DELETE(req('DELETE'), params)).status).toBe(200);
        expect(db.enterpriseAkSk.updateMany).toHaveBeenCalledWith({
            where: { id: 'ak1', user_id: 'u1' },
            data: { status: 'disabled' },
        });
        db.enterpriseAkSk.updateMany.mockResolvedValue({ count: 0 });
        expect((await DELETE(req('DELETE'), params)).status).toBe(404);
        requireEnterpriseUser.mockResolvedValue(null);
        expect((await DELETE(req('DELETE'), params)).status).toBe(401);
    });
});
