import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// new-api 权威用量端点:admin 守门 + tenantScope IDOR;数据来自 3 个 new-api
// 上游调用;关键回归 = 响应行必须按 user_id 二次过滤(new-api 的 user_id query
// 会被忽略返回全量 —— 不过滤会把别的客户的调用算到这个人头上)。
const mockResolveAdmin = vi.fn();
const mockUserFindFirst = vi.fn();
const mockGetUser = vi.fn();
const mockGetUsageDashboard = vi.fn();
const mockQueryLogs = vi.fn();

vi.mock('@/lib/admin/auth', () => ({
    resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a),
}));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
// Real tenant-scope helper — exercise the where-clause wiring end-to-end.
vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findFirst: (...a: unknown[]) => mockUserFindFirst(...a) },
    },
}));
// quotaToCny mocked with the prod formula (1M quota/USD, ¥7/USD) for round numbers.
vi.mock('@/lib/newapi/client', () => ({
    getUser: (...a: unknown[]) => mockGetUser(...a),
    getUsageDashboard: (...a: unknown[]) => mockGetUsageDashboard(...a),
    queryLogs: (...a: unknown[]) => mockQueryLogs(...a),
    quotaToCny: (quota: number) => (quota / 1_000_000) * 7,
}));

import { GET } from '@/app/api/admin/customers/[id]/newapi-usage/route';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };
const PARTNER_ADMIN = { role: 'admin', tenant_id: 'tenant-7', user: {}, viaBreakGlass: false };

const req = (id: string) => new NextRequest(`https://x/api/admin/customers/${id}/newapi-usage`);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const LINKED_USER = {
    id: 'u1',
    newapi_user_id: 76,
    newapi_username: 'c-test',
    created_at: new Date('2026-05-29T00:00:00Z'),
};

// 2026-06-01T02:00:00Z = 北京 10:00 → '2026-06-01'
const TS_D1A = Math.floor(Date.parse('2026-06-01T02:00:00Z') / 1000);
// 同一天的第二个子桶(北京 18:00)→ 必须合并进同一天
const TS_D1B = Math.floor(Date.parse('2026-06-01T10:00:00Z') / 1000);
const TS_D2 = Math.floor(Date.parse('2026-06-02T02:00:00Z') / 1000);

beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ quota: 2_000_000, used_quota: 1_000_000 });
    mockGetUsageDashboard.mockResolvedValue([]);
    mockQueryLogs.mockResolvedValue({ items: [], total: 0 });
});

describe('GET /api/admin/customers/[id]/newapi-usage', () => {
    it('returns 401 when not an admin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        const res = await GET(req('u1'), params('u1'));
        expect(res.status).toBe(401);
        expect(mockUserFindFirst).not.toHaveBeenCalled();
    });

    it('partner admin → findFirst where includes BOTH id AND tenant_id (IDOR guard); 404 stops upstream calls', async () => {
        mockResolveAdmin.mockResolvedValue(PARTNER_ADMIN);
        mockUserFindFirst.mockResolvedValue(null);
        const res = await GET(req('other'), params('other'));
        expect(res.status).toBe(404);
        expect(mockUserFindFirst.mock.calls[0][0].where).toMatchObject({ id: 'other', tenant_id: 'tenant-7' });
        expect(mockGetUser).not.toHaveBeenCalled();
        expect(mockGetUsageDashboard).not.toHaveBeenCalled();
    });

    it('returns { linked: false } without touching new-api when the user has no newapi binding', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        mockUserFindFirst.mockResolvedValue({ ...LINKED_USER, newapi_user_id: null, newapi_username: null });
        const res = await GET(req('u1'), params('u1'));
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body).toEqual({ linked: false });
        expect(mockGetUser).not.toHaveBeenCalled();
    });

    it('aggregates by model + daily + per-call price; queries by username', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        mockUserFindFirst.mockResolvedValue(LINKED_USER);
        mockGetUsageDashboard.mockResolvedValue([
            // gpt-image-2:同一天两个子桶 + 次日一桶
            {
                user_id: 76,
                username: 'c-test',
                model_name: 'gpt-image-2',
                created_at: TS_D1A,
                count: 10,
                quota: 400_000,
                token_used: 1_000,
            },
            {
                user_id: 76,
                username: 'c-test',
                model_name: 'gpt-image-2',
                created_at: TS_D1B,
                count: 5,
                quota: 50_000,
                token_used: 500,
            },
            {
                user_id: 76,
                username: 'c-test',
                model_name: 'claude-x',
                created_at: TS_D2,
                count: 2,
                quota: 100_000,
                token_used: 200,
            },
        ]);
        mockQueryLogs.mockResolvedValue({
            items: [
                {
                    user_id: 76,
                    type: 2,
                    model_name: 'gpt-image-2',
                    quota: 10_000,
                    content: '品质 standard, 生成数量 1',
                    created_at: TS_D1A,
                    prompt_tokens: 1,
                    completion_tokens: 2,
                },
                {
                    user_id: 76,
                    type: 2,
                    model_name: 'gpt-image-2',
                    quota: 20_000,
                    content: '',
                    created_at: TS_D1B,
                    prompt_tokens: 1,
                    completion_tokens: 2,
                },
                {
                    user_id: 76,
                    type: 2,
                    model_name: 'gpt-image-2',
                    quota: 30_000,
                    content: '',
                    created_at: TS_D2,
                    prompt_tokens: 1,
                    completion_tokens: 2,
                },
            ],
            total: 3,
        });

        const res = await GET(req('u1'), params('u1'));
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.linked).toBe(true);

        // live:quota 2M → ¥14;used 1M → ¥7
        expect(body.live).toEqual({ balance_cny: 14, used_cny: 7 });

        // by_model:gpt-image-2 = 15 次 / 1500 tokens / 450k quota = ¥3.15,avg ¥0.21
        expect(body.by_model).toHaveLength(2);
        expect(body.by_model[0]).toMatchObject({ model: 'gpt-image-2', calls: 15, tokens: 1_500 });
        expect(body.by_model[0].cost_cny).toBeCloseTo(3.15, 6);
        expect(body.by_model[0].avg_cny).toBeCloseTo(0.21, 6);
        expect(body.by_model[1]).toMatchObject({ model: 'claude-x', calls: 2 });
        expect(body.totals.calls).toBe(17);
        expect(body.totals.cost_cny).toBeCloseTo(3.85, 6);

        // daily:同一天两个子桶合并成一行(北京时间日界),desc 排序
        expect(body.daily).toEqual([
            expect.objectContaining({ date: '2026-06-02', model: 'claude-x', calls: 2 }),
            expect.objectContaining({ date: '2026-06-01', model: 'gpt-image-2', calls: 15 }),
        ]);
        expect(body.daily[1].cost_cny).toBeCloseTo(3.15, 6);

        // 单价样本:min ¥0.07 / avg ¥0.14 / max ¥0.21,计价说明取首条非空 content
        expect(body.price_samples).toHaveLength(1);
        const ps = body.price_samples[0];
        expect(ps.model).toBe('gpt-image-2');
        expect(ps.samples).toBe(3);
        expect(ps.min_cny).toBeCloseTo(0.07, 6);
        expect(ps.avg_cny).toBeCloseTo(0.14, 6);
        expect(ps.max_cny).toBeCloseTo(0.21, 6);
        expect(ps.note).toBe('品质 standard, 生成数量 1');
        expect(ps.last_at).toBe(new Date(TS_D2 * 1000).toISOString());

        // 上游查询必须按 username(new-api 忽略 user_id query)
        expect(mockGetUsageDashboard.mock.calls[0][0]).toMatchObject({ username: 'c-test' });
        expect(mockQueryLogs.mock.calls[0][0]).toMatchObject({ username: 'c-test', type: 2, page_size: 100 });
    });

    it('CRITICAL: rows belonging to other users are excluded (new-api ignores user_id filter)', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        mockUserFindFirst.mockResolvedValue(LINKED_USER);
        mockGetUsageDashboard.mockResolvedValue([
            {
                user_id: 76,
                username: 'c-test',
                model_name: 'gpt-image-2',
                created_at: TS_D1A,
                count: 3,
                quota: 30_000,
                token_used: 30,
            },
            // 别的客户的行 —— 绝不能混进聚合
            {
                user_id: 99,
                username: 'c-other',
                model_name: 'gpt-image-2',
                created_at: TS_D1A,
                count: 1_000,
                quota: 9_999_999,
                token_used: 9,
            },
        ]);
        mockQueryLogs.mockResolvedValue({
            items: [
                {
                    user_id: 76,
                    type: 2,
                    model_name: 'gpt-image-2',
                    quota: 10_000,
                    content: '',
                    created_at: TS_D1A,
                    prompt_tokens: 0,
                    completion_tokens: 0,
                },
                {
                    user_id: 99,
                    type: 2,
                    model_name: 'gpt-image-2',
                    quota: 999_999,
                    content: '',
                    created_at: TS_D1A,
                    prompt_tokens: 0,
                    completion_tokens: 0,
                },
            ],
            total: 2,
        });

        const res = await GET(req('u1'), params('u1'));
        const body = await res.json();
        expect(body.totals.calls).toBe(3); // 不是 1003
        expect(body.by_model[0].calls).toBe(3);
        expect(body.price_samples[0].samples).toBe(1);
        expect(body.price_samples[0].max_cny).toBeCloseTo(0.07, 6); // 999_999 的行没混进来
        expect(body.sample_size).toBe(1);
    });

    it('returns 502 when new-api is unreachable', async () => {
        mockResolveAdmin.mockResolvedValue(SUPERADMIN);
        mockUserFindFirst.mockResolvedValue(LINKED_USER);
        mockGetUser.mockRejectedValue(new Error('connect ECONNREFUSED'));
        const res = await GET(req('u1'), params('u1'));
        expect(res.status).toBe(502);
        const body = await res.json();
        expect(body.error).toContain('new-api');
    });
});
