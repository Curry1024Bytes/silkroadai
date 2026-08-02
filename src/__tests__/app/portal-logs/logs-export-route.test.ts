/**
 * GET /api/portal/logs/export — 调用日志 CSV 导出的 route 测试。
 *
 * Mock:getCurrentUser + queryLogs(+ quotaToCny)。log-display 折叠 / 脱敏跑真逻辑。
 * 断言:鉴权、账号未开通、CSV 头/行/BOM、下载响应头、翻页循环拉全量、触顶截断提示、
 * IDOR 过滤、折叠 failover、CSV 转义 + 公式注入防护、过滤参数转发。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

const mockQueryLogs = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    queryLogs: (...a: unknown[]) => mockQueryLogs(...a),
    quotaToCny: (q: number) => q / 100000, // 简化;测试不深究金额
}));

const { GET } = await import('@/app/api/portal/logs/export/route');

interface LogOpt {
    id?: number;
    user_id?: number;
    type?: number;
    request_id?: string;
    content?: string;
    created_at?: number;
    model_name?: string;
    token_name?: string;
    other?: string;
    prompt_tokens?: number;
    completion_tokens?: number;
}
function makeLog(o: LogOpt = {}) {
    return {
        id: o.id ?? 1,
        user_id: o.user_id ?? 100,
        created_at: o.created_at ?? 1000,
        type: o.type ?? 2,
        content: o.content ?? '',
        username: 'c-x',
        token_name: o.token_name ?? 'k',
        model_name: o.model_name ?? 'gpt-image-2',
        other: o.other ?? '{"model_price":-1,"model_ratio":0.9285714285714286,"completion_ratio":6}',
        quota: 100000,
        prompt_tokens: o.prompt_tokens ?? 0,
        completion_tokens: o.completion_tokens ?? 0,
        use_time: 1,
        is_stream: false,
        channel: 44,
        token_id: 1,
        group: 'default',
        request_id: o.request_id ?? `REQ${o.id ?? 1}`,
    };
}

const req = (qs = '') => new NextRequest(`https://ai.silkroadai.io/api/portal/logs/export${qs}`);
const provisioned = { id: 'u1', newapi_user_id: 100, newapi_username: 'c-x' };
/** 满页 100 行(触发继续翻页)。 */
const fullPage = (offset = 0) => ({
    items: Array.from({ length: 100 }, (_, i) =>
        makeLog({ id: offset + i + 1, type: 2, request_id: `R${offset + i}` }),
    ),
    total: 100,
});

beforeEach(() => vi.clearAllMocks());

describe('GET /api/portal/logs/export', () => {
    it('未登录 → 401', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        expect((await GET(req())).status).toBe(401);
    });

    it('账号未开通 → 400 account_not_provisioned', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: 'u1', newapi_user_id: null, newapi_username: null });
        const res = await GET(req());
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe('account_not_provisioned');
    });

    it('CSV:BOM + 表头 + 成功/失败行倒序 + 下载响应头', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockResolvedValue({
            items: [
                makeLog({ id: 1, type: 2, created_at: 100, request_id: 'A', model_name: 'gpt-5.5' }),
                makeLog({ id: 2, type: 5, created_at: 90, request_id: 'B', content: 'boom' }),
            ],
            total: 2,
        });
        const res = await GET(req());
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/csv');
        expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="silkroadai-logs-\d{12}\.csv"/);
        // BOM 在字节层(EF BB BF);res.text() 按 fetch 规范解码时会剥掉它,故查原始字节。
        const bytes = new Uint8Array(await res.arrayBuffer());
        expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
        const text = new TextDecoder().decode(bytes);
        const lines = text
            .replace(/^\ufeff/, '')
            .trimEnd()
            .split('\r\n');
        expect(lines[0]).toContain('时间(北京)');
        expect(lines[0]).toContain('缓存读 Tokens');
        expect(lines[0]).toContain('缓存写 Tokens');
        expect(lines[0]).toContain('消耗(元)');
        expect(lines).toHaveLength(3); // 表头 + 2 行
        expect(lines[1]).toContain('gpt-5.5'); // created_at 100 > 90 → 靠前
        expect(lines[1]).toContain('成功');
        expect(lines[2]).toContain('失败');
        expect(lines[2]).toContain('boom');
    });

    it('时间列是北京时间(unix 0 → 1970-01-01 08:00:00)', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockResolvedValue({ items: [makeLog({ id: 1, type: 2, created_at: 0 })], total: 1 });
        const text = await (await GET(req())).text();
        expect(text).toContain('1970-01-01 08:00:00');
    });

    it('翻页循环:满页继续拉,不满页停(100 + 30 → 调 2 次,130 行全导)', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockResolvedValueOnce(fullPage(0)).mockResolvedValueOnce({
            items: Array.from({ length: 30 }, (_, i) => makeLog({ id: 101 + i, type: 2, request_id: `S${i}` })),
            total: 30,
        });
        const text = await (await GET(req())).text();
        expect(mockQueryLogs).toHaveBeenCalledTimes(2);
        expect(mockQueryLogs.mock.calls[0][0]).toMatchObject({ page: 1, page_size: 100 });
        expect(mockQueryLogs.mock.calls[1][0]).toMatchObject({ page: 2, page_size: 100 });
        expect(text.trimEnd().split('\r\n')).toHaveLength(131); // 表头 + 130
    });

    it('触顶(100 页全满)→ 停止翻页 + 截断提示行 + X-Export-Truncated', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockImplementation(({ page }: { page: number }) => Promise.resolve(fullPage((page - 1) * 100)));
        const res = await GET(req());
        expect(mockQueryLogs).toHaveBeenCalledTimes(100);
        expect(res.headers.get('x-export-truncated')).toBe('1');
        const text = await res.text();
        expect(text).toContain('已达单次导出上限 10000 条');
    });

    it('IDOR:别人 user_id 的行不出现在 CSV', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockResolvedValue({
            items: [
                makeLog({ id: 1, type: 2, user_id: 100, request_id: 'MINE' }),
                makeLog({ id: 2, type: 2, user_id: 999, request_id: 'THEIRS' }),
            ],
            total: 2,
        });
        const text = await (await GET(req())).text();
        expect(text).toContain('MINE');
        expect(text).not.toContain('THEIRS');
    });

    it('折叠:failover 失败与成功同 request_id → 失败不导出', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockResolvedValue({
            items: [
                makeLog({ id: 1, type: 2, created_at: 100, request_id: 'SAME' }),
                makeLog({ id: 2, type: 5, created_at: 90, request_id: 'SAME', content: '429 上游负载已饱和' }),
            ],
            total: 2,
        });
        const text = await (await GET(req())).text();
        expect(text.trimEnd().split('\r\n')).toHaveLength(2); // 表头 + 1
        expect(text).not.toContain('失败');
    });

    it('CSV 转义:含逗号/引号的字段加引号;=`+`开头防公式注入', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockResolvedValue({
            items: [
                makeLog({
                    id: 1,
                    type: 5,
                    request_id: 'X',
                    content: '=HYPERLINK("http://evil"), say "hi"',
                }),
            ],
            total: 1,
        });
        const text = await (await GET(req())).text();
        // 公式注入 → 前置 ';整体含逗号/引号 → 引号包裹 + "" 转义
        expect(text).toContain(`"'=HYPERLINK(""http://evil""), say ""hi"""`);
    });

    it('过滤参数转发给 queryLogs(与日志页同一套,type=0)', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockResolvedValue({ items: [], total: 0 });
        await GET(req('?start=1000&end=2000&model=gpt-image-2&token=prod&request_id=ABC123&channel=44'));
        expect(mockQueryLogs.mock.calls[0][0]).toMatchObject({
            start_timestamp: 1000,
            end_timestamp: 2000,
            model_name: 'gpt-image-2',
            token_name: 'prod',
            request_id: 'ABC123',
            channel: 44,
            type: 0,
            username: 'c-x',
        });
    });

    it('queryLogs 抛错 → 502 fetch_failed', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockRejectedValue(new Error('down'));
        const res = await GET(req());
        expect(res.status).toBe(502);
        expect(((await res.json()) as { error: string }).error).toBe('fetch_failed');
    });

    it('非法参数(channel 非数字)→ 400', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        expect((await GET(req('?channel=abc'))).status).toBe(400);
    });
});
