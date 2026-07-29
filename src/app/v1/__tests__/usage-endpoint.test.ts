/**
 * GET /v1/usage — 逐请求用量 + 实际扣费端点(sk- 鉴权机读版)测试。
 *
 * Mock:prisma.newApiToken.findUnique + queryLogs。quota-units / log-display 是纯函数,
 * 跑真逻辑(金额断言用真 quotaToCny/quotaToRealUsd 算期望值,不写死汇率)。
 * 断言:鉴权 401、未开通 503、参数 400、行映射(¥/$、duration_ms、billing 口径、脱敏)、
 * IDOR 过滤、key_only、type 映射、request_id 单查命中/未命中 404、上游故障 503、has_more。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockTokenFindUnique = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: { newApiToken: { findUnique: (...a: unknown[]) => mockTokenFindUnique(...a) } },
}));

const mockQueryLogs = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    queryLogs: (...a: unknown[]) => mockQueryLogs(...a),
}));

import { handleUsageQuery } from '../[...path]/usage';
import { quotaToCny, quotaToRealUsd } from '@/lib/newapi/quota-units';

const req = (qs = '', auth: string | null = 'Bearer sk-abc') =>
    new NextRequest(`https://ai.silkroadai.io/v1/usage${qs}`, {
        headers: auth ? { authorization: auth } : {},
    });

const activeToken = {
    status: 'active',
    newapi_token_id: 55,
    user: { newapi_user_id: 100, newapi_username: 'c-x' },
};

interface LogOpt {
    id?: number;
    user_id?: number;
    type?: number;
    request_id?: string;
    content?: string;
    created_at?: number;
    model_name?: string;
    token_id?: number;
    other?: string;
    quota?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    use_time?: number;
    is_stream?: boolean;
}
function makeLog(o: LogOpt = {}) {
    return {
        id: o.id ?? 1,
        user_id: o.user_id ?? 100,
        created_at: o.created_at ?? 1000,
        type: o.type ?? 2,
        content: o.content ?? '',
        username: 'c-x',
        token_name: 'prod-key',
        model_name: o.model_name ?? 'claude-opus-5',
        other: o.other ?? '{"model_price":-1}',
        quota: o.quota ?? 100000,
        prompt_tokens: o.prompt_tokens ?? 120,
        completion_tokens: o.completion_tokens ?? 30,
        use_time: o.use_time ?? 3,
        is_stream: o.is_stream ?? true,
        channel: 2,
        token_id: o.token_id ?? 55,
        group: 'default',
        request_id: o.request_id ?? `REQ${o.id ?? 1}`,
    };
}

interface Row {
    request_id: string;
    created_at: number;
    type: string;
    model: string;
    is_stream: boolean;
    duration_ms: number;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    billing: string;
    cost_cny: number;
    cost_usd: number;
    quota: number;
    content: string;
}
interface Envelope {
    object: string;
    data: Row[];
    page: number;
    page_size: number;
    has_more: boolean;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockTokenFindUnique.mockResolvedValue(activeToken);
    mockQueryLogs.mockResolvedValue({ items: [], total: 0 });
});

describe('GET /v1/usage — 鉴权', () => {
    it('无 Authorization → 401', async () => {
        expect((await handleUsageQuery(req('', null))).status).toBe(401);
    });

    it('未知 key → 401', async () => {
        mockTokenFindUnique.mockResolvedValue(null);
        expect((await handleUsageQuery(req())).status).toBe(401);
    });

    it('撤销 key → 401', async () => {
        mockTokenFindUnique.mockResolvedValue({ ...activeToken, status: 'disabled' });
        expect((await handleUsageQuery(req())).status).toBe(401);
    });

    it('sk- 前缀剥掉后查 DB(存的是无前缀值)', async () => {
        await handleUsageQuery(req());
        expect(mockTokenFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { newapi_token_value: 'abc' } }),
        );
    });

    it('账号未开通(newapi_user_id null)→ 503', async () => {
        mockTokenFindUnique.mockResolvedValue({
            ...activeToken,
            user: { newapi_user_id: null, newapi_username: null },
        });
        expect((await handleUsageQuery(req())).status).toBe(503);
    });
});

describe('GET /v1/usage — 参数校验', () => {
    it('page_size=0 → 400', async () => {
        expect((await handleUsageQuery(req('?page_size=0'))).status).toBe(400);
    });

    it('page_size>100(new-api 硬钳)→ 400', async () => {
        expect((await handleUsageQuery(req('?page_size=101'))).status).toBe(400);
    });

    it('type 非法值 → 400', async () => {
        expect((await handleUsageQuery(req('?type=bogus'))).status).toBe(400);
    });

    it('request_id 带非字母数字 → 400', async () => {
        expect((await handleUsageQuery(req('?request_id=abc%20def'))).status).toBe(400);
    });
});

describe('GET /v1/usage — 查询转发', () => {
    it('默认:username+user_id 双过滤、type=2、page 1 / page_size 50', async () => {
        await handleUsageQuery(req());
        expect(mockQueryLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                username: 'c-x',
                user_id: 100,
                type: 2,
                page: 1,
                page_size: 50,
            }),
        );
    });

    it('start_time/end_time/model/page 透传', async () => {
        await handleUsageQuery(req('?start_time=1700000000&end_time=1700003600&model=claude-opus-5&page=3'));
        expect(mockQueryLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                start_timestamp: 1700000000,
                end_timestamp: 1700003600,
                model_name: 'claude-opus-5',
                page: 3,
            }),
        );
    });

    it('type=refund → new-api type 6;type=error → 5;type=all → 0', async () => {
        await handleUsageQuery(req('?type=refund'));
        expect(mockQueryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ type: 6 }));
        await handleUsageQuery(req('?type=error'));
        expect(mockQueryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ type: 5 }));
        await handleUsageQuery(req('?type=all'));
        expect(mockQueryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ type: 0 }));
    });

    it('queryLogs 抛错 → 503(不泄内部错误)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockQueryLogs.mockRejectedValue(new Error('ECONNREFUSED'));
        const res = await handleUsageQuery(req());
        expect(res.status).toBe(503);
        const body = (await res.json()) as { error: { message: string } };
        expect(body.error.message).not.toContain('ECONNREFUSED');
        warn.mockRestore();
    });
});

describe('GET /v1/usage — 行映射', () => {
    it('happy path:¥/$、duration_ms、total_tokens、billing=per_token', async () => {
        mockQueryLogs.mockResolvedValue({ items: [makeLog({ quota: 123456 })], total: 1 });
        const res = await handleUsageQuery(req());
        expect(res.status).toBe(200);
        const body = (await res.json()) as Envelope;
        expect(body.object).toBe('list');
        expect(body.data).toHaveLength(1);
        const row = body.data[0];
        expect(row.request_id).toBe('REQ1');
        expect(row.type).toBe('consume');
        expect(row.model).toBe('claude-opus-5');
        expect(row.is_stream).toBe(true);
        expect(row.duration_ms).toBe(3000); // use_time 是秒 → ms
        expect(row.usage).toEqual({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });
        expect(row.billing).toBe('per_token'); // model_price=-1 → 按 token
        expect(row.quota).toBe(123456);
        expect(row.cost_cny).toBe(Number(quotaToCny(123456).toFixed(6)));
        expect(row.cost_usd).toBe(Number(quotaToRealUsd(123456).toFixed(6)));
    });

    it('按张计费生图(model_price≥0)→ billing=per_call', async () => {
        mockQueryLogs.mockResolvedValue({
            items: [makeLog({ model_name: 'gemini-3-pro-image-preview', other: '{"model_price":0.5}' })],
            total: 1,
        });
        const body = (await (await handleUsageQuery(req())).json()) as Envelope;
        expect(body.data[0].billing).toBe('per_call');
    });

    it('错误行 content 脱敏(不含上游来源)', async () => {
        mockQueryLogs.mockResolvedValue({
            items: [makeLog({ type: 5, content: 'adobe content rejected: image_unsafe' })],
            total: 1,
        });
        const body = (await (await handleUsageQuery(req('?type=error'))).json()) as Envelope;
        expect(body.data[0].type).toBe('error');
        expect(body.data[0].content.toLowerCase()).not.toContain('adobe');
    });

    it('按 created_at 倒序返回', async () => {
        mockQueryLogs.mockResolvedValue({
            items: [
                makeLog({ id: 1, created_at: 100, request_id: 'OLD' }),
                makeLog({ id: 2, created_at: 200, request_id: 'NEW' }),
            ],
            total: 2,
        });
        const body = (await (await handleUsageQuery(req())).json()) as Envelope;
        expect(body.data.map((r) => r.request_id)).toEqual(['NEW', 'OLD']);
    });
});

describe('GET /v1/usage — 过滤防线', () => {
    it('IDOR:别人 user_id 的行被过滤(即使上游忽略 filter)', async () => {
        mockQueryLogs.mockResolvedValue({
            items: [makeLog({ id: 1, user_id: 100 }), makeLog({ id: 2, user_id: 999, request_id: 'THEIRS' })],
            total: 2,
        });
        const body = (await (await handleUsageQuery(req())).json()) as Envelope;
        expect(body.data).toHaveLength(1);
        expect(body.data[0].request_id).toBe('REQ1');
    });

    it('type=all 时充值/管理行(1/3/4)不出参', async () => {
        mockQueryLogs.mockResolvedValue({
            items: [makeLog({ id: 1, type: 2 }), makeLog({ id: 2, type: 1 }), makeLog({ id: 3, type: 3 })],
            total: 3,
        });
        const body = (await (await handleUsageQuery(req('?type=all'))).json()) as Envelope;
        expect(body.data).toHaveLength(1);
    });

    it('key_only=true → 只留本 key(token_id 匹配)的行', async () => {
        mockQueryLogs.mockResolvedValue({
            items: [makeLog({ id: 1, token_id: 55 }), makeLog({ id: 2, token_id: 77, request_id: 'OTHERKEY' })],
            total: 2,
        });
        const body = (await (await handleUsageQuery(req('?key_only=true'))).json()) as Envelope;
        expect(body.data).toHaveLength(1);
        expect(body.data[0].request_id).toBe('REQ1');
    });
});

describe('GET /v1/usage — request_id 单查', () => {
    it('命中 → 返回该行', async () => {
        mockQueryLogs.mockResolvedValue({ items: [makeLog({ request_id: 'ABC123' })], total: 1 });
        const res = await handleUsageQuery(req('?request_id=ABC123'));
        expect(res.status).toBe(200);
        const body = (await res.json()) as Envelope;
        expect(body.data[0].request_id).toBe('ABC123');
        expect(mockQueryLogs).toHaveBeenCalledWith(expect.objectContaining({ request_id: 'ABC123' }));
    });

    it('未命中 → 404 + 提示账可能还没落、可重试', async () => {
        mockQueryLogs.mockResolvedValue({ items: [], total: 0 });
        const res = await handleUsageQuery(req('?request_id=NOTYET'));
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { message: string } };
        expect(body.error.message).toContain('retry');
    });
});

describe('GET /v1/usage — 翻页', () => {
    it('拿满一页 → has_more=true;不满 → false', async () => {
        mockQueryLogs.mockResolvedValue({
            items: Array.from({ length: 2 }, (_, i) => makeLog({ id: i + 1, request_id: `R${i}` })),
            total: 10,
        });
        const full = (await (await handleUsageQuery(req('?page_size=2'))).json()) as Envelope;
        expect(full.has_more).toBe(true);

        const partial = (await (await handleUsageQuery(req('?page_size=50'))).json()) as Envelope;
        expect(partial.has_more).toBe(false);
    });
});
