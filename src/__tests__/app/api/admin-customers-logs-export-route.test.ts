import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// 日志导出端点:admin 守门 + tenantScope IDOR + 参数校验;数据来自 new-api
// 日志库只读直连(pg pool mock)。关键守护:
//   1. SQL 必须钉死 type=2(失败调用/入账不进账单)+ user_id 绑定(不能串客户);
//   2. CSV 列 = 客户可见字段,不得出现 ip / request_id / channel / group;
//   3. keyset 分页用最后一行 id 续查,直到批量 < BATCH_SIZE;
//   4. 未配置 NEWAPI_LOGS_DATABASE_URL → 503(功能静默关闭)。
const mockResolveAdmin = vi.fn();
const mockUserFindFirst = vi.fn();
const mockPoolQuery = vi.fn();
let mockPool: { query: typeof mockPoolQuery } | null;

vi.mock('@/lib/admin/auth', () => ({
    resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a),
}));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findFirst: (...a: unknown[]) => mockUserFindFirst(...a) },
    },
}));
vi.mock('@/lib/newapi/client', () => ({
    // prod 公式(500k quota = ¥1)取整数便于断言
    quotaToCny: (quota: number) => quota / 500_000,
}));
vi.mock('@/lib/newapi/logs-db', () => ({
    getNewapiLogsPool: () => mockPool,
}));

import { GET } from '@/app/api/admin/customers/[id]/logs-export/route';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };
const PARTNER_ADMIN = { role: 'admin', tenant_id: 'tenant-7', user: {}, viaBreakGlass: false };

const LINKED_USER = { id: 'u1', newapi_user_id: 560, newapi_username: 'c-5ba310b1' };

const req = (id: string, qs: string) => new NextRequest(`https://x/api/admin/customers/${id}/logs-export?${qs}`);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** epoch 秒(北京时间当天 00:00)。 */
const bjTs = (date: string) => Math.floor(Date.parse(`${date}T00:00:00+08:00`) / 1_000);

const row = (id: number, quota: number, model = 'gpt-image-2') => ({
    id: String(id),
    time_beijing: '2026-07-01 12:00:00',
    model_name: model,
    prompt_tokens: 10,
    completion_tokens: 20,
    use_time: 3,
    quota,
});

beforeEach(() => {
    vi.clearAllMocks();
    mockPool = { query: mockPoolQuery };
    mockResolveAdmin.mockResolvedValue(SUPERADMIN);
    mockUserFindFirst.mockResolvedValue(LINKED_USER);
    mockPoolQuery.mockResolvedValue({ rows: [] });
});

describe('GET /api/admin/customers/[id]/logs-export', () => {
    it('returns 401 when not an admin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        const res = await GET(req('u1', 'start=2026-07-01&end=2026-07-02'), params('u1'));
        expect(res.status).toBe(401);
        expect(mockUserFindFirst).not.toHaveBeenCalled();
    });

    it('400 on malformed dates / start>end / oversize range; DB untouched', async () => {
        for (const qs of [
            'start=2026-7-1&end=2026-07-02',
            'start=2026-07-01',
            'start=2026-07-05&end=2026-07-01',
            'start=2020-01-01&end=2026-07-01',
        ]) {
            const res = await GET(req('u1', qs), params('u1'));
            expect(res.status).toBe(400);
        }
        expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('partner admin → findFirst where includes BOTH id AND tenant_id (IDOR guard); 404 stops export', async () => {
        mockResolveAdmin.mockResolvedValue(PARTNER_ADMIN);
        mockUserFindFirst.mockResolvedValue(null);
        const res = await GET(req('other', 'start=2026-07-01&end=2026-07-02'), params('other'));
        expect(res.status).toBe(404);
        expect(mockUserFindFirst.mock.calls[0][0].where).toMatchObject({ id: 'other', tenant_id: 'tenant-7' });
        expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('400 when the customer has no newapi binding', async () => {
        mockUserFindFirst.mockResolvedValue({ ...LINKED_USER, newapi_user_id: null });
        const res = await GET(req('u1', 'start=2026-07-01&end=2026-07-02'), params('u1'));
        expect(res.status).toBe(400);
        expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('503 when NEWAPI_LOGS_DATABASE_URL is not configured', async () => {
        mockPool = null;
        const res = await GET(req('u1', 'start=2026-07-01&end=2026-07-02'), params('u1'));
        expect(res.status).toBe(503);
    });

    it('streams CSV with customer-safe columns; SQL pins type=2 + user_id + Beijing day window', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [row(101, 500_000), row(102, 250_000, 'a,b')] });
        const res = await GET(req('u1', 'start=2026-07-01&end=2026-07-02'), params('u1'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/csv');
        expect(res.headers.get('content-disposition')).toContain('logs_c-5ba310b1_2026-07-01_2026-07-02.csv');

        const bytes = new Uint8Array(await res.arrayBuffer());
        // BOM(EF BB BF)让 Excel 双击打开识别 UTF-8;res.text() 会剥 BOM,须按字节断言
        expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        const text = new TextDecoder().decode(bytes);
        expect(text).toContain('时间(北京),模型,输入tokens,输出tokens,耗时(秒),消耗quota,消耗(¥)');
        expect(text).toContain('2026-07-01 12:00:00,gpt-image-2,10,20,3,500000,1.0000');
        expect(text).toContain('"a,b"');
        // 内部字段绝不能出现
        for (const banned of ['ip', 'request_id', 'channel', 'group', 'ratio']) {
            expect(text.toLowerCase()).not.toContain(banned);
        }

        const [sql, sqlParams] = mockPoolQuery.mock.calls[0];
        expect(sql).toMatch(/type\s*=\s*2/);
        expect(sqlParams[0]).toBe(560); // user_id 绑定
        expect(sqlParams[1]).toBe(bjTs('2026-07-01')); // 北京 7-1 00:00 起
        expect(sqlParams[2]).toBe(bjTs('2026-07-02') + 86_400); // end 当天全天
        expect(sqlParams[3]).toBeNull(); // 无 model 过滤
    });

    it('keyset-paginates with the last row id until a short batch', async () => {
        const full = Array.from({ length: 5_000 }, (_, i) => row(i + 1, 500));
        mockPoolQuery.mockResolvedValueOnce({ rows: full }).mockResolvedValueOnce({ rows: [row(5_001, 500)] });
        const res = await GET(req('u1', 'start=2026-07-01&end=2026-07-02'), params('u1'));
        const text = await res.text();
        expect(mockPoolQuery).toHaveBeenCalledTimes(2);
        expect(mockPoolQuery.mock.calls[0][1][4]).toBe('0'); // 首批游标
        expect(mockPoolQuery.mock.calls[1][1][4]).toBe('5000'); // 续批用最后一行 id
        // 表头 + 5001 行 + 末尾换行
        expect(text.split('\n').length).toBe(5_003);
    });

    it('forwards the exact model filter', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [] });
        await GET(req('u1', 'start=2026-07-01&end=2026-07-02&model=claude-opus-5'), params('u1'));
        expect(mockPoolQuery.mock.calls[0][1][3]).toBe('claude-opus-5');
    });
});
