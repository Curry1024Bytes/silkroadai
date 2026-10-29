/**
 * GET /api/portal/logs — 客户「调用日志」页数据源的 route 测试。
 *
 * Mock:getCurrentUser + queryLogs(+ quotaToCny)。log-display 的折叠 / 脱敏是纯函数,
 * 不 mock,直接跑真逻辑。断言:鉴权、账号未开通、合并倒序、折叠 failover、脱敏 adobe、
 * IDOR 过滤、过滤参数转发、hasMore。
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

const { GET } = await import('@/app/api/portal/logs/route');

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
    quota?: number;
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
        // 默认 gpt-image-2 按 token 计费(model_price=-1);per-张 的行显式传 model_price≥0 的 other
        other: o.other ?? '{"model_price":-1,"model_ratio":0.9285714285714286,"completion_ratio":6}',
        quota: o.quota ?? 100000,
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

const req = (qs = '') => new NextRequest(`https://api.llmroute.club/api/portal/logs${qs}`);
const provisioned = { id: 'u1', newapi_user_id: 100, newapi_username: 'c-x' };

beforeEach(() => vi.clearAllMocks());

describe('GET /api/portal/logs', () => {
    it('未登录 → 401', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        expect((await GET(req())).status).toBe(401);
    });

    it('账号未开通 → 空 rows + account_not_provisioned', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: 'u1', newapi_user_id: null, newapi_username: null });
        const d = (await (await GET(req())).json()) as { error: string; rows: unknown[] };
        expect(d.error).toBe('account_not_provisioned');
        expect(d.rows).toEqual([]);
    });

    it('成功 + 失败合并,按时间倒序', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockResolvedValue({
            items: [
                makeLog({ id: 1, type: 2, created_at: 100, request_id: 'A' }),
                makeLog({ id: 2, type: 5, created_at: 90, request_id: 'B', content: 'boom' }),
            ],
            total: 2,
        });
        const d = (await (await GET(req())).json()) as { rows: Array<{ id: number }> };
        expect(d.rows).toHaveLength(2);
        expect(d.rows[0].id).toBe(1); // 100 > 90
    });

    it('视频退款(type=6):结算退款、配不上的失败退款为负金额行;配上的失败退款并进预扣行(失败 ¥0)', async () => {
        const video = 'doubao-seedance-2-0-mini-260615';
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockResolvedValue({
            items: [
                makeLog({ id: 1, type: 2, created_at: 100, quota: 100000, model_name: video }), // 成功任务的预扣
                makeLog({ id: 3, type: 2, created_at: 110, quota: 100000, model_name: video }), // 失败任务的预扣
                makeLog({
                    id: 4,
                    type: 6,
                    created_at: 140,
                    quota: 5000,
                    model_name: video,
                    other: '{"task_id":"task_1","pre_consumed_quota":100000,"actual_quota":95000}',
                    content: '任务用量表达式结算',
                }),
                makeLog({
                    id: 5,
                    type: 6,
                    created_at: 150,
                    quota: 100000,
                    model_name: video,
                    other: '{"task_id":"task_2"}',
                }),
                // 预扣行不在本页的失败退款
                makeLog({
                    id: 6,
                    type: 6,
                    created_at: 160,
                    quota: 300000,
                    model_name: video,
                    other: '{"task_id":"task_3"}',
                }),
                makeLog({ id: 7, type: 1, created_at: 170, quota: 900000 }), // 充值,不进调用记录
                makeLog({ id: 8, type: 6, user_id: 999, created_at: 180, quota: 100000, model_name: video }), // 别人的
            ],
            total: 7,
        });
        const d = (await (await GET(req())).json()) as {
            rows: Array<{ id: number; type: number; costCny: number; refundKind: string | null; content: string }>;
        };
        expect(d.rows.map((r) => r.id)).toEqual([6, 4, 3, 1]); // id=5 并进了 id=3
        expect(d.rows[0]).toMatchObject({ costCny: -3, refundKind: 'failure' });
        expect(d.rows[0].content).toContain('已自动退还预扣的 ¥3.00');
        expect(d.rows[1]).toMatchObject({ costCny: -0.05, refundKind: 'settlement' });
        expect(d.rows[1].content).toContain('预扣 ¥1.00，实际 ¥0.95');
        expect(d.rows[2]).toMatchObject({ type: 6, costCny: 0, refundKind: null });
        expect(d.rows[2].content).toContain('视频任务未生成成功');
        expect(d.rows[3]).toMatchObject({ type: 2, costCny: 1, refundKind: null, content: '' });
    });

    it('缓存读写:other 有 cache_tokens/cache_creation_tokens → row 带 cacheReadTokens/cacheWriteTokens;缺省 0/0', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockResolvedValue({
            items: [
                makeLog({
                    id: 1,
                    type: 2,
                    created_at: 100,
                    model_name: 'claude-opus-5',
                    // 线上实测形态:prompt_tokens=2 而缓存读 127,885(Anthropic 面 prompt 不含缓存)
                    other: '{"model_price":-1,"cache_ratio":0.1,"cache_tokens":127885,"cache_creation_tokens":178}',
                    prompt_tokens: 2,
                    completion_tokens: 272,
                }),
                makeLog({ id: 2, type: 2, created_at: 90 }),
            ],
            total: 2,
        });
        const d = (await (await GET(req())).json()) as {
            rows: Array<{ cacheReadTokens: number; cacheWriteTokens: number }>;
        };
        expect(d.rows[0]).toMatchObject({ cacheReadTokens: 127_885, cacheWriteTokens: 178 });
        expect(d.rows[1]).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0 });
    });

    it('折叠:failover 失败与成功同 request_id → 失败被藏', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockResolvedValue({
            items: [
                makeLog({ id: 1, type: 2, created_at: 100, request_id: 'SAME' }),
                makeLog({ id: 2, type: 5, created_at: 90, request_id: 'SAME', content: '429 上游负载已饱和' }),
            ],
            total: 2,
        });
        const d = (await (await GET(req())).json()) as { rows: Array<{ id: number }> };
        expect(d.rows).toHaveLength(1);
        expect(d.rows[0].id).toBe(1);
    });

    it('脱敏:adobe 内容拒绝 → 返回内容不含 adobe', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockResolvedValue({
            items: [makeLog({ id: 3, type: 5, request_id: 'X', content: 'adobe content rejected: image_unsafe' })],
            total: 1,
        });
        const d = (await (await GET(req())).json()) as { rows: Array<{ content: string }> };
        expect(d.rows[0].content.toLowerCase()).not.toContain('adobe');
        expect(d.rows[0].content).toContain('安全系统');
    });

    it('perImageBilled 按 other.model_price 计:gpt-image-2 按 token→false;gemini 生图按张→true', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockResolvedValue({
            items: [
                // 按 token(model_price=-1)→ token 是计费依据 → perImageBilled=false(显示 token)
                makeLog({ id: 1, type: 2, model_name: 'gpt-image-2', request_id: 'A', prompt_tokens: 3054 }),
                // 按张(model_price≥0)→ token 是噪声 → perImageBilled=true(显示 "—")
                makeLog({
                    id: 2,
                    type: 2,
                    model_name: 'gemini-3-pro-image-preview',
                    other: '{"model_price":0.06429,"model_ratio":0}',
                    request_id: 'B',
                    prompt_tokens: 1212,
                }),
            ],
            total: 2,
        });
        const d = (await (await GET(req())).json()) as { rows: Array<{ id: number; perImageBilled: boolean }> };
        const byId = Object.fromEntries(d.rows.map((r) => [r.id, r.perImageBilled]));
        expect(byId[1]).toBe(false); // gpt-image-2 按 token → 显示
        expect(byId[2]).toBe(true); // gemini 生图按张 → "—"
    });

    it('IDOR:别人 user_id 的行被过滤掉', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockResolvedValue({
            items: [
                makeLog({ id: 1, type: 2, user_id: 100, request_id: 'A' }),
                makeLog({ id: 2, type: 2, user_id: 999, request_id: 'B' }),
            ],
            total: 2,
        });
        const d = (await (await GET(req())).json()) as { rows: Array<{ id: number }> };
        expect(d.rows).toHaveLength(1);
        expect(d.rows[0].id).toBe(1);
    });

    it('过滤参数转发给 queryLogs(日期 / model / token / request_id / channel / page + type=0)', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockResolvedValue({ items: [], total: 0 });
        await GET(req('?start=1000&end=2000&model=gpt-image-2&token=prod&request_id=ABC123&channel=44&page=3'));
        expect(mockQueryLogs.mock.calls[0][0]).toMatchObject({
            start_timestamp: 1000,
            end_timestamp: 2000,
            model_name: 'gpt-image-2',
            token_name: 'prod',
            request_id: 'ABC123',
            channel: 44,
            page: 3,
            type: 0,
            username: 'c-x',
        });
    });

    it('满页(100 行)→ hasMore true', async () => {
        mockGetCurrentUser.mockResolvedValue(provisioned);
        mockQueryLogs.mockResolvedValue({
            items: Array.from({ length: 100 }, (_, i) => makeLog({ id: i + 1, type: 2, request_id: `R${i}` })),
            total: 100,
        });
        const d = (await (await GET(req())).json()) as { hasMore: boolean };
        expect(d.hasMore).toBe(true);
    });
});
