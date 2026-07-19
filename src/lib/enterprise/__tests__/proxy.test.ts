/**
 * 独立门户 /v1 处理器单测:分发白名单 / 鉴权 / 余额门 / 任务落库(fail closed)/ 轮询 IDOR + 扣费。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
    db,
    resolveEnterpriseCustomer,
    submitVideoWithKey,
    pollVideoWithKey,
    estimateEnterpriseCostCny,
    chargeEnterpriseVideoTask,
} = vi.hoisted(() => ({
    db: {
        seedanceVideoTask: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
        account: { findUnique: vi.fn() },
    },
    resolveEnterpriseCustomer: vi.fn(),
    submitVideoWithKey: vi.fn(),
    pollVideoWithKey: vi.fn(),
    estimateEnterpriseCostCny: vi.fn(),
    chargeEnterpriseVideoTask: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('../keys', () => ({ resolveEnterpriseCustomer }));
vi.mock('@/lib/seedance/cn-adapter', async (importOriginal) => {
    const mod = await importOriginal<typeof import('@/lib/seedance/cn-adapter')>();
    return { ...mod, submitVideoWithKey, pollVideoWithKey };
});
vi.mock('../billing', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../billing')>();
    return { ...mod, estimateEnterpriseCostCny, chargeEnterpriseVideoTask };
});

import { handleEnterpriseV1, isEnterpriseFlavor } from '../proxy';

const CUSTOMER = { userId: 'u1', tenantId: null, keyId: 'k1', upstreamKey: 'sk-upstream-u1' };

function req(method: string, url: string, body?: unknown): NextRequest {
    return new NextRequest(`http://128.241.232.23${url}`, {
        method,
        headers: { authorization: 'Bearer sk-ent-' + 'a'.repeat(48), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    resolveEnterpriseCustomer.mockResolvedValue({ ok: true, customer: CUSTOMER });
    db.account.findUnique.mockResolvedValue({ balance_cny: '100' });
    estimateEnterpriseCostCny.mockResolvedValue(4.26);
    db.seedanceVideoTask.create.mockResolvedValue({});
    db.seedanceVideoTask.update.mockResolvedValue({});
});

describe('isEnterpriseFlavor', () => {
    it('只在 PORTAL_FLAVOR=seedance-enterprise 时为 true', () => {
        delete process.env.PORTAL_FLAVOR;
        expect(isEnterpriseFlavor()).toBe(false);
        process.env.PORTAL_FLAVOR = 'seedance-enterprise';
        expect(isEnterpriseFlavor()).toBe(true);
        delete process.env.PORTAL_FLAVOR;
    });
});

describe('分发白名单', () => {
    it('GET /models → 6 档模型', async () => {
        const res = await handleEnterpriseV1(req('GET', '/v1/models'), '/models');
        const j = (await res.json()) as { data: Array<{ id: string }> };
        expect(res.status).toBe(200);
        expect(j.data.map((m) => m.id)).toContain('seedance2.0-pro-720p');
        expect(j.data).toHaveLength(6);
    });

    it('白名单外路径(/chat/completions 等)→ 404', async () => {
        for (const [method, path] of [
            ['POST', '/chat/completions'],
            ['POST', '/images/generations'],
            ['GET', '/balance'],
        ] as const) {
            const res = await handleEnterpriseV1(req(method, `/v1${path}`, method === 'GET' ? undefined : {}), path);
            expect(res.status).toBe(404);
        }
    });
});

describe('提交', () => {
    const goodBody = { model: 'seedance2.0-pro-720p', prompt: '一只猫' };

    it('key 无效 → 401 透传 resolve 结果', async () => {
        resolveEnterpriseCustomer.mockResolvedValue({
            ok: false,
            status: 401,
            code: 'invalid_api_key',
            message: 'invalid or inactive API key',
        });
        const res = await handleEnterpriseV1(req('POST', '/v1/video/generations', goodBody), '/video/generations');
        expect(res.status).toBe(401);
        expect(submitVideoWithKey).not.toHaveBeenCalled();
    });

    it('未知模型 → 400,不打上游', async () => {
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'gpt-5.5', prompt: 'x' }),
            '/video/generations',
        );
        expect(res.status).toBe(400);
        expect(submitVideoWithKey).not.toHaveBeenCalled();
    });

    it('余额不足 → 402,不打上游', async () => {
        db.account.findUnique.mockResolvedValue({ balance_cny: '1.00' });
        estimateEnterpriseCostCny.mockResolvedValue(4.26);
        const res = await handleEnterpriseV1(req('POST', '/v1/video/generations', goodBody), '/video/generations');
        expect(res.status).toBe(402);
        expect(submitVideoWithKey).not.toHaveBeenCalled();
    });

    it('无 Account 行 = 余额 0 → 402', async () => {
        db.account.findUnique.mockResolvedValue(null);
        const res = await handleEnterpriseV1(req('POST', '/v1/video/generations', goodBody), '/video/generations');
        expect(res.status).toBe(402);
    });

    it('happy:用【客户独立上游 key】直调核心,任务落库 tier=enterprise-portal', async () => {
        submitVideoWithKey.mockResolvedValue(NextResponse.json({ id: 'cgt-e1', task_id: 'cgt-e1', status: 'queued' }));
        const res = await handleEnterpriseV1(req('POST', '/v1/video/generations', goodBody), '/video/generations');
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-pro-720p' }),
            'Bearer sk-upstream-u1',
        );
        expect(db.seedanceVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                id: 'cgt-e1',
                user_id: 'u1',
                newapi_user_id: null,
                tier: 'enterprise-portal',
                resolution: '720p',
                has_video: false,
            }),
        });
    });

    it('上游失败 → 状态/体透传,不落任务', async () => {
        submitVideoWithKey.mockResolvedValue(
            NextResponse.json({ error: { message: '账户余额不足5元' } }, { status: 403 }),
        );
        const res = await handleEnterpriseV1(req('POST', '/v1/video/generations', goodBody), '/video/generations');
        expect(res.status).toBe(403);
        expect(db.seedanceVideoTask.create).not.toHaveBeenCalled();
    });

    it('任务落库失败 → 503 fail closed(防生成了收不到钱)', async () => {
        submitVideoWithKey.mockResolvedValue(NextResponse.json({ id: 'cgt-e2', status: 'queued' }));
        db.seedanceVideoTask.create.mockRejectedValue(new Error('db down'));
        const res = await handleEnterpriseV1(req('POST', '/v1/video/generations', goodBody), '/video/generations');
        expect(res.status).toBe(503);
    });
});

describe('轮询', () => {
    const task = {
        id: 'cgt-e1',
        user_id: 'u1',
        tier: 'enterprise-portal',
        tokens: null,
        status: 'queued',
    };

    it('任务不存在 / 非本人 / 非 enterprise tier → 404(IDOR + 与 seedance-cn 渠道任务隔离)', async () => {
        for (const t of [null, { ...task, user_id: 'other' }, { ...task, tier: 'seedance-cn-enterprise' }]) {
            db.seedanceVideoTask.findUnique.mockResolvedValue(t);
            const res = await handleEnterpriseV1(
                req('GET', '/v1/video/generations/cgt-e1'),
                '/video/generations/cgt-e1',
            );
            expect(res.status).toBe(404);
        }
        expect(pollVideoWithKey).not.toHaveBeenCalled();
    });

    it('完成 → 写 tokens + 幂等扣费,响应透传', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        pollVideoWithKey.mockResolvedValue(
            NextResponse.json({
                id: 'cgt-e1',
                status: 'completed',
                video_url: 'https://volcvideo.com/x.mp4',
                usage: { completion_tokens: 108872 },
            }),
        );
        chargeEnterpriseVideoTask.mockResolvedValue({ outcome: 'charged', costCny: 4.26 });
        const res = await handleEnterpriseV1(req('GET', '/v1/video/generations/cgt-e1'), '/video/generations/cgt-e1');
        expect(res.status).toBe(200);
        expect(pollVideoWithKey).toHaveBeenCalledWith('cgt-e1', 'Bearer sk-upstream-u1');
        expect(db.seedanceVideoTask.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { tokens: BigInt(108872), status: 'completed' } }),
        );
        expect(chargeEnterpriseVideoTask).toHaveBeenCalledWith('cgt-e1');
        const j = (await res.json()) as { video_url?: string };
        expect(j.video_url).toContain('volcvideo');
    });

    it('未完成 → 不写 tokens 不扣费', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        pollVideoWithKey.mockResolvedValue(NextResponse.json({ id: 'cgt-e1', status: 'in_progress' }));
        const res = await handleEnterpriseV1(req('GET', '/v1/video/generations/cgt-e1'), '/video/generations/cgt-e1');
        expect(res.status).toBe(200);
        expect(chargeEnterpriseVideoTask).not.toHaveBeenCalled();
    });

    it('失败 → 标 failed 不计费', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        pollVideoWithKey.mockResolvedValue(NextResponse.json({ id: 'cgt-e1', status: 'failed' }));
        await handleEnterpriseV1(req('GET', '/v1/video/generations/cgt-e1'), '/video/generations/cgt-e1');
        expect(db.seedanceVideoTask.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: 'failed' } }),
        );
        expect(chargeEnterpriseVideoTask).not.toHaveBeenCalled();
    });
});
