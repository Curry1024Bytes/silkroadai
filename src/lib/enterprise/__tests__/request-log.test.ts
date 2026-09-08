/**
 * 企业请求日志采集单测:脱媒/截断、poll 落行判定、fire-and-forget 写入(含失败不抛)、
 * 筛选 where 构造(列表页与导出共用)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const { db } = vi.hoisted(() => ({
    db: { enterpriseRequestLog: { create: vi.fn() } },
}));
vi.mock('@/lib/db', () => ({ prisma: db }));

import {
    buildReqlogWhere,
    newRequestLogCtx,
    reqlogRetentionDays,
    sanitizeRequestBody,
    shouldLogPoll,
    writeRequestLog,
    type RequestLogCtx,
} from '../request-log';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    vi.clearAllMocks();
    db.enterpriseRequestLog.create.mockResolvedValue({});
});
afterEach(() => {
    delete process.env.ENTERPRISE_REQLOG_POLL_ALL;
    delete process.env.ENTERPRISE_REQLOG_RETENTION_DAYS;
});

describe('sanitizeRequestBody', () => {
    it('data URL 替换成占位符(媒体字节不落库)', () => {
        const raw = JSON.stringify({
            model: 'seedance-2-0',
            image: `data:image/png;base64,${'A'.repeat(100_000)}`,
        });
        const out = sanitizeRequestBody(raw);
        expect(out).toContain('seedance-2-0');
        expect(out).not.toContain('AAAA');
        expect(out).toContain('[data-url image/png');
        expect(out.length).toBeLessThan(1000);
    });

    it('超长字符串截断并标注总长', () => {
        const raw = JSON.stringify({ prompt: 'x'.repeat(10_000) });
        const out = sanitizeRequestBody(raw);
        expect(out.length).toBeLessThan(3000);
        expect(out).toContain('[10000 chars total]');
    });

    it('嵌套结构(content 数组)里的 data URL 也被脱掉', () => {
        const raw = JSON.stringify({
            content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${'B'.repeat(5000)}` } }],
        });
        const out = sanitizeRequestBody(raw);
        expect(out).not.toContain('BBBB');
        expect(out).toContain('image/jpeg');
    });

    it('非 JSON 原样留前缀(排障要看客户到底发了什么)', () => {
        expect(sanitizeRequestBody('not-json-at-all')).toBe('not-json-at-all');
    });

    it('整体超 32KB 硬截', () => {
        const raw = JSON.stringify({ items: Array.from({ length: 100 }, (_, i) => ({ i, s: 'y'.repeat(1000) })) });
        const out = sanitizeRequestBody(raw);
        expect(out.length).toBeLessThanOrEqual(32 * 1024 + 20);
        expect(out.endsWith('…[truncated]')).toBe(true);
    });
});

describe('shouldLogPoll', () => {
    const base = (over: Partial<RequestLogCtx>): RequestLogCtx => ({
        kind: 'poll',
        startedAt: Date.now(),
        ...over,
    });

    it('终态迁移(queued→completed)→ 记', () => {
        expect(shouldLogPoll(base({ statusBefore: 'queued', statusAfter: 'completed' }), 200)).toBe(true);
    });
    it('终态迁移(queued→failed)→ 记', () => {
        expect(shouldLogPoll(base({ statusBefore: 'queued', statusAfter: 'failed' }), 200)).toBe(true);
    });
    it('例行轮询(queued→in_progress,库里不写 in_progress)→ 不记', () => {
        expect(shouldLogPoll(base({ statusBefore: 'queued', statusAfter: 'in_progress' }), 200)).toBe(false);
    });
    it('已完成任务的重复轮询 → 不记', () => {
        expect(shouldLogPoll(base({ statusBefore: 'completed', statusAfter: 'completed' }), 200)).toBe(false);
    });
    it('上游真报错(非缓存)→ 记', () => {
        expect(shouldLogPoll(base({ statusBefore: 'queued', upstreamStatus: 502, cacheHit: false }), 200)).toBe(true);
    });
    it('缓存重放的上游错 → 不记(TTL 内同一份错记一次就够)', () => {
        expect(shouldLogPoll(base({ statusBefore: 'queued', upstreamStatus: 502, cacheHit: true }), 200)).toBe(false);
    });
    it('没打到上游就被拒(401/404)→ 记', () => {
        expect(shouldLogPoll(base({}), 401)).toBe(true);
        expect(shouldLogPoll(base({ statusBefore: null }), 404)).toBe(true);
    });
    it('ENTERPRISE_REQLOG_POLL_ALL=1 → 全量', () => {
        process.env.ENTERPRISE_REQLOG_POLL_ALL = '1';
        expect(shouldLogPoll(base({ statusBefore: 'queued', statusAfter: 'in_progress' }), 200)).toBe(true);
    });
});

describe('writeRequestLog', () => {
    it('落行:归属/耗时/上游信息全到位,4xx 响应提取 error code/message', async () => {
        const ctx = newRequestLogCtx('submit', 'v1');
        ctx.userId = 'u1';
        ctx.keyId = 'k1';
        ctx.region = 'cn';
        ctx.model = 'seedance-2-0';
        ctx.taskId = 'cgt-1';
        ctx.upstreamStatus = 200;
        ctx.upstreamMs = 123;
        const res = NextResponse.json(
            { error: { code: 'insufficient_balance', message: '余额不足', type: 'invalid_request_error' } },
            { status: 402 },
        );
        writeRequestLog(ctx, res);
        await flush();
        expect(db.enterpriseRequestLog.create).toHaveBeenCalledTimes(1);
        const data = db.enterpriseRequestLog.create.mock.calls[0][0].data;
        expect(data).toMatchObject({
            kind: 'submit',
            format: 'v1',
            user_id: 'u1',
            key_id: 'k1',
            region: 'cn',
            model: 'seedance-2-0',
            task_id: 'cgt-1',
            http_status: 402,
            upstream_status: 200,
            upstream_ms: 123,
            error_code: 'insufficient_balance',
            error_message: '余额不足',
        });
        expect(typeof data.duration_ms).toBe('number');
    });

    it('outcome:显式(reconcile 动作)优先,否则由终态迁移推导', async () => {
        const a = newRequestLogCtx('reconcile');
        a.outcome = 'back_charged';
        writeRequestLog(a);
        const b = newRequestLogCtx('poll');
        b.statusBefore = 'queued';
        b.statusAfter = 'completed';
        writeRequestLog(b);
        await flush();
        expect(db.enterpriseRequestLog.create.mock.calls[0][0].data.outcome).toBe('back_charged');
        expect(db.enterpriseRequestLog.create.mock.calls[1][0].data.outcome).toBe('completed');
    });

    it('DB 写失败绝不抛(fire-and-forget 红线)', async () => {
        db.enterpriseRequestLog.create.mockRejectedValue(new Error('db down'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(() => writeRequestLog(newRequestLogCtx('submit', 'v1'))).not.toThrow();
        await flush();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('响应体不是 JSON 时不炸,error 字段留空', async () => {
        const res = new NextResponse('<html>bad gateway</html>', { status: 502 });
        writeRequestLog(newRequestLogCtx('poll', 'ark'), res);
        await flush();
        const data = db.enterpriseRequestLog.create.mock.calls[0][0].data;
        expect(data.http_status).toBe(502);
        expect(data.error_code).toBeNull();
    });
});

describe('buildReqlogWhere', () => {
    it('全空 → 空 where', () => {
        expect(buildReqlogWhere({})).toEqual({});
    });
    it('日期 / 客户 / 渠道 / 类型 / 结果 / 检索全组合', () => {
        const w = buildReqlogWhere({
            from: '2026-09-01',
            to: '2026-09-03',
            user: '123e4567-e89b-12d3-a456-426614174000',
            region: 'volc',
            kind: 'submit',
            model: 'seedance',
            result: '4xx',
            q: 'cgt-123',
        });
        expect(w.user_id).toBe('123e4567-e89b-12d3-a456-426614174000');
        expect(w.region).toBe('volc');
        expect(w.kind).toBe('submit');
        expect(w.model).toEqual({ contains: 'seedance' });
        expect(w.http_status).toEqual({ gte: 400, lt: 500 });
        expect(w.OR).toHaveLength(4);
        expect(w.created_at).toBeDefined();
    });
    it('非法值(伪 uuid / 未知 region / 未知 result)全部忽略', () => {
        const w = buildReqlogWhere({ user: 'not-a-uuid', region: 'mars', kind: 'hack', result: 'weird' });
        expect(w).toEqual({});
    });
    it('upstream_err 按上游 status 过滤', () => {
        expect(buildReqlogWhere({ result: 'upstream_err' }).upstream_status).toEqual({ gte: 400 });
    });
});

describe('reqlogRetentionDays', () => {
    it('默认 60,env 可覆盖,非法值回落', () => {
        expect(reqlogRetentionDays()).toBe(60);
        process.env.ENTERPRISE_REQLOG_RETENTION_DAYS = '30';
        expect(reqlogRetentionDays()).toBe(30);
        process.env.ENTERPRISE_REQLOG_RETENTION_DAYS = '-5';
        expect(reqlogRetentionDays()).toBe(60);
        process.env.ENTERPRISE_REQLOG_RETENTION_DAYS = 'abc';
        expect(reqlogRetentionDays()).toBe(60);
    });
});

describe('asset_action(P2 2026-09-04)', () => {
    it('kind=asset_action 进筛选白名单;q 也命中 resource_id', () => {
        expect(buildReqlogWhere({ kind: 'asset_action' }).kind).toBe('asset_action');
        const w = buildReqlogWhere({ q: 'asset-2026' });
        expect(w.OR).toContainEqual({ resource_id: { contains: 'asset-2026' } });
        expect(w.OR).toHaveLength(4);
    });

    it('action / resource_id 落列', async () => {
        const ctx = newRequestLogCtx('asset_action', 'platform');
        ctx.action = 'CreateAsset';
        ctx.resourceId = 'asset-20260904000000-abc123';
        writeRequestLog(ctx);
        await flush();
        const data = db.enterpriseRequestLog.create.mock.calls[0][0].data;
        expect(data).toMatchObject({
            kind: 'asset_action',
            format: 'platform',
            action: 'CreateAsset',
            resource_id: 'asset-20260904000000-abc123',
        });
    });

    it('火山 envelope 错误形({ResponseMetadata:{Error:{Code,Message}}})也能提取 error 列', async () => {
        const res = NextResponse.json(
            { ResponseMetadata: { RequestId: 'x', Error: { Code: 'AssetNotFound', Message: '素材不存在: a1' } } },
            { status: 404 },
        );
        writeRequestLog(newRequestLogCtx('asset_action'), res);
        await flush();
        const data = db.enterpriseRequestLog.create.mock.calls[0][0].data;
        expect(data.error_code).toBe('AssetNotFound');
        expect(data.error_message).toBe('素材不存在: a1');
    });
});
