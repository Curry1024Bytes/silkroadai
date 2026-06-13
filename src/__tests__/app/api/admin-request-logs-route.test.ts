/**
 * 数据存储第③步 — request-logs admin API 单测(brief §13)。
 *
 * 用【真】resolveAdmin + mock getCurrentUser/isBreakGlassToken,端到端验角色门
 * (customer/staff/admin → 401;superadmin session 与 break-glass 放行,后者
 * via_break_glass=true)。其余 mock prisma(RequestLog + RequestLogAccess)+
 * log-store(getLogObject)。
 *
 * 覆盖:门 / 审计(list·view_meta·view_input·view_output + body fail-closed)/
 * R2 读回(内容·截断·getLogObject 抛→404)/ 筛选+分页。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockGetCurrentUser = vi.fn();
const mockIsBreakGlass = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    isBreakGlassToken: (...a: unknown[]) => mockIsBreakGlass(...a),
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
    AdminUnauthorizedError: class AdminUnauthorizedError extends Error {},
}));

const mockFindMany = vi.fn();
const mockCount = vi.fn();
const mockFindUnique = vi.fn();
const mockAccessCreate = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        requestLog: {
            findMany: (...a: unknown[]) => mockFindMany(...a),
            count: (...a: unknown[]) => mockCount(...a),
            findUnique: (...a: unknown[]) => mockFindUnique(...a),
        },
        requestLogAccess: { create: (...a: unknown[]) => mockAccessCreate(...a) },
    },
}));

const mockGetLogObject = vi.fn();
const mockIsLogStoreConfigured = vi.fn();
vi.mock('@/lib/r2/log-store', () => ({
    getLogObject: (...a: unknown[]) => mockGetLogObject(...a),
    isLogStoreConfigured: () => mockIsLogStoreConfigured(),
}));

import { GET as LIST } from '@/app/api/admin/request-logs/route';
import { GET as META } from '@/app/api/admin/request-logs/[id]/route';
import { GET as BODY } from '@/app/api/admin/request-logs/[id]/body/route';

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const asUser = (role: string) => ({ id: 'actor-1', role, tenant_id: null });
const listReq = (qs = '') => new NextRequest(`https://x/api/admin/request-logs${qs}`);
const metaReq = () => new NextRequest(`https://x/api/admin/request-logs/${UUID}`);
const bodyReq = (which = 'in', extra = '') =>
    new NextRequest(`https://x/api/admin/request-logs/${UUID}/body?which=${which}${extra}`);
const params = (id = UUID) => ({ params: Promise.resolve({ id }) });
const flush = () => new Promise((r) => setTimeout(r, 0)); // 让 fire-and-forget 审计跑完

beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue(asUser('superadmin'));
    mockIsBreakGlass.mockReturnValue(false);
    mockFindMany.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);
    mockFindUnique.mockResolvedValue(null);
    mockAccessCreate.mockResolvedValue({});
    mockGetLogObject.mockResolvedValue(Buffer.from('{"hi":1}'));
    mockIsLogStoreConfigured.mockReturnValue(true);
});

describe('superadmin 门(真 resolveAdmin)', () => {
    for (const role of ['customer', 'staff', 'admin'] as const) {
        it(`${role} → list/meta/body 全 401,不查数据不写审计`, async () => {
            mockGetCurrentUser.mockResolvedValue(asUser(role));
            const l = await LIST(listReq());
            const m = await META(metaReq(), params());
            mockFindUnique.mockResolvedValue({ input_r2_key: 'k', output_r2_key: 'k2' });
            const b = await BODY(bodyReq('in'), params());
            expect(l.status).toBe(401);
            expect(m.status).toBe(401);
            expect(b.status).toBe(401);
            expect(mockFindMany).not.toHaveBeenCalled();
            expect(mockAccessCreate).not.toHaveBeenCalled();
            expect(mockGetLogObject).not.toHaveBeenCalled();
        });
    }

    it('superadmin(session)→ 放行', async () => {
        const res = await LIST(listReq());
        expect(res.status).toBe(200);
    });

    it('break-glass ADMIN_TOKEN → 放行且审计 via_break_glass=true', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        mockIsBreakGlass.mockReturnValue(true);
        const res = await LIST(listReq());
        await flush();
        expect(res.status).toBe(200);
        expect(mockAccessCreate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ via_break_glass: true, actor_user_id: null }) }),
        );
    });
});

describe('审计', () => {
    it('list 写 action=list + 筛选摘要 + actor', async () => {
        await LIST(listReq('?model=gpt-5.4&page=2'));
        await flush();
        const data = (mockAccessCreate.mock.calls.at(-1)![0] as { data: Record<string, unknown> }).data;
        expect(data.action).toBe('list');
        expect(data.actor_user_id).toBe('actor-1');
        expect(data.via_break_glass).toBe(false);
        expect(String(data.query)).toContain('gpt-5.4');
        expect(data.request_log_id).toBeNull();
    });

    it('view_meta 写 action=view_meta + request_log_id(best-effort)', async () => {
        mockFindUnique.mockResolvedValue({ id: UUID, path: '/chat/completions' });
        const res = await META(metaReq(), params());
        await flush();
        expect(res.status).toBe(200);
        const data = (mockAccessCreate.mock.calls.at(-1)![0] as { data: Record<string, unknown> }).data;
        expect(data.action).toBe('view_meta');
        expect(data.request_log_id).toBe(UUID);
    });

    it('view_meta 审计写失败仍返回元数据(best-effort)', async () => {
        mockFindUnique.mockResolvedValue({ id: UUID });
        mockAccessCreate.mockRejectedValue(new Error('db down'));
        const res = await META(metaReq(), params());
        await flush();
        expect(res.status).toBe(200); // 元数据不含客户原文 → 不挡
    });

    it('view_input 写 action=view_input(在返回 body 之前)', async () => {
        mockFindUnique.mockResolvedValue({ input_r2_key: 'reqlog/x.in.json', output_r2_key: 'reqlog/x.out.json' });
        mockGetLogObject.mockResolvedValue(Buffer.from('CLIENT PROMPT'));
        const res = await BODY(bodyReq('in'), params());
        expect(res.status).toBe(200);
        const data = (mockAccessCreate.mock.calls.at(-1)![0] as { data: Record<string, unknown> }).data;
        expect(data.action).toBe('view_input');
        expect(data.request_log_id).toBe(UUID);
        expect((await res.json()).body).toBe('CLIENT PROMPT');
    });

    it('view_output 写 action=view_output', async () => {
        mockFindUnique.mockResolvedValue({ input_r2_key: 'i', output_r2_key: 'o' });
        await BODY(bodyReq('out'), params());
        const data = (mockAccessCreate.mock.calls.at(-1)![0] as { data: Record<string, unknown> }).data;
        expect(data.action).toBe('view_output');
    });

    it('fail-closed:body 审计写失败 → 503,不返回 body,不读 R2', async () => {
        mockFindUnique.mockResolvedValue({ input_r2_key: 'i', output_r2_key: 'o' });
        mockAccessCreate.mockRejectedValue(new Error('audit db down'));
        const res = await BODY(bodyReq('in'), params());
        expect(res.status).toBe(503);
        expect(mockGetLogObject).not.toHaveBeenCalled();
    });
});

describe('R2 读回', () => {
    it('正确返回 in/out 内容', async () => {
        mockFindUnique.mockResolvedValue({ input_r2_key: 'i', output_r2_key: 'o' });
        mockGetLogObject.mockResolvedValue(Buffer.from('{"messages":[]}'));
        const res = await BODY(bodyReq('in'), params());
        const j = await res.json();
        expect(j.body).toBe('{"messages":[]}');
        expect(j.truncated).toBe(false);
        expect(j.total_bytes).toBe(15);
    });

    it('超大 body → 截断 + total_bytes;full=1 → 完整', async () => {
        const big = 'x'.repeat(300_000);
        mockFindUnique.mockResolvedValue({ input_r2_key: 'i', output_r2_key: 'o' });
        mockGetLogObject.mockResolvedValue(Buffer.from(big));
        const cut = await (await BODY(bodyReq('in'), params())).json();
        expect(cut.truncated).toBe(true);
        expect(cut.total_bytes).toBe(300_000);
        expect(cut.body.length).toBe(256 * 1024); // 默认 256KB 截断
        const full = await (await BODY(bodyReq('in', '&full=1'), params())).json();
        expect(full.truncated).toBe(false);
        expect(full.body.length).toBe(300_000);
    });

    it('getLogObject 抛(对象不存在)→ 友好 404 不 500', async () => {
        mockFindUnique.mockResolvedValue({ input_r2_key: 'i', output_r2_key: 'o' });
        mockGetLogObject.mockRejectedValue(new Error('NoSuchKey'));
        const res = await BODY(bodyReq('in'), params());
        expect(res.status).toBe(404);
    });

    it('which 非法 → 400', async () => {
        const res = await BODY(bodyReq('sideways'), params());
        expect(res.status).toBe(400);
    });

    it('row 无对应 r2 key → 404 no body stored', async () => {
        mockFindUnique.mockResolvedValue({ input_r2_key: null, output_r2_key: 'o' });
        const res = await BODY(bodyReq('in'), params());
        expect(res.status).toBe(404);
        expect(mockAccessCreate).not.toHaveBeenCalled(); // 没东西可看 → 不写 view_input
    });

    it('非 uuid id → 404(不打 DB)', async () => {
        const res = await BODY(
            new NextRequest('https://x/api/admin/request-logs/not-a-uuid/body?which=in'),
            params('not-a-uuid'),
        );
        expect(res.status).toBe(404);
        expect(mockFindUnique).not.toHaveBeenCalled();
    });
});

describe('筛选 + 分页', () => {
    it('user_id / model / status / success / streamed / 日期 → where 正确', async () => {
        await LIST(
            listReq(
                '?user_id=U1&model=claude&status_code=200&success=true&streamed=false&from=2026-01-01&to=2026-02-01',
            ),
        );
        const arg = mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
        expect(arg.where.user_id).toBe('U1');
        expect(arg.where.model).toEqual({ contains: 'claude', mode: 'insensitive' });
        expect(arg.where.status_code).toBe(200);
        expect(arg.where.success).toBe(true);
        expect(arg.where.streamed).toBe(false);
        const ca = arg.where.created_at as { gte: Date; lte: Date };
        expect(ca.gte).toBeInstanceOf(Date);
        expect(ca.lte).toBeInstanceOf(Date);
    });

    it('分页 skip/take 正确', async () => {
        await LIST(listReq('?page=3&page_size=20'));
        const arg = mockFindMany.mock.calls[0][0] as { skip: number; take: number };
        expect(arg.skip).toBe(40);
        expect(arg.take).toBe(20);
    });

    it('空筛选 → where 空对象', async () => {
        await LIST(listReq());
        const arg = mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
        expect(arg.where).toEqual({});
    });
});
