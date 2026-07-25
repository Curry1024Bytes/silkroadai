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
const { resolveAssetRefs } = vi.hoisted(() => ({ resolveAssetRefs: vi.fn() }));
vi.mock('../assets', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../assets')>();
    return { ...mod, resolveAssetRefs };
});
import { AssetError } from '../assets';

import { handleEnterpriseV1, isEnterpriseFlavor } from '../proxy';

const CUSTOMER = { userId: 'u1', tenantId: null, keyId: 'k1', region: 'cn', upstreamKey: 'sk-upstream-u1' };

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
    resolveAssetRefs.mockImplementation((body: Record<string, unknown>) => Promise.resolve(body));
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
    it('GET /models → 9 个归一短名(国内 3 + global 3 + promax 3)', async () => {
        const res = await handleEnterpriseV1(req('GET', '/v1/models'), '/models');
        const j = (await res.json()) as { data: Array<{ id: string }> };
        expect(res.status).toBe(200);
        expect(j.data.map((m) => m.id)).toEqual([
            'seedance-2-0',
            'seedance-2-0-fast',
            'seedance-2-0-mini',
            'seedance-2-0-global',
            'seedance-2-0-global-fast',
            'seedance-2-0-global-mini',
            'seedance-2-0-promax',
            'seedance-2-0-promax-fast',
            'seedance-2-0-promax-mini',
        ]);
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

    it('P3 素材引用:resolveAssetRefs 替换后的 body 才发上游', async () => {
        const substituted = {
            model: 'seedance2.0-pro-720p-ref',
            prompt: '一只猫',
            images: ['https://r2/asset-1.png'],
        };
        resolveAssetRefs.mockResolvedValue(substituted);
        submitVideoWithKey.mockResolvedValue(NextResponse.json({ id: 'cgt-e3', status: 'queued' }));
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'seedance2.0-pro-720p-ref',
                prompt: '一只猫',
                images: ['asset-20260719120000-aaaaaa'],
            }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(resolveAssetRefs).toHaveBeenCalledWith(
            expect.objectContaining({ images: ['asset-20260719120000-aaaaaa'] }),
            'u1',
        );
        expect(submitVideoWithKey).toHaveBeenCalledWith(substituted, 'Bearer sk-upstream-u1');
    });

    it('P3 素材引用非本人/不存在 → 400,不打上游', async () => {
        resolveAssetRefs.mockRejectedValue(new AssetError('AssetNotFound', '素材不存在: asset-x', 400));
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance2.0-pro-720p-ref', prompt: 'x', images: ['x'] }),
            '/video/generations',
        );
        expect(res.status).toBe(400);
        expect(submitVideoWithKey).not.toHaveBeenCalled();
    });
});

describe('归一短名(2026-07-20)', () => {
    beforeEach(() => {
        submitVideoWithKey.mockResolvedValue(NextResponse.json({ id: 'cgt-u1', task_id: 'cgt-u1', status: 'queued' }));
    });

    it('seedance-2-0 默认 720p 文生:适配器收长名,任务行与响应回显短名', async () => {
        submitVideoWithKey.mockResolvedValue(
            NextResponse.json({ id: 'cgt-u1', task_id: 'cgt-u1', model: 'seedance2.0-pro-720p', status: 'queued' }),
        );
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0', prompt: '一只猫' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-pro-720p' }),
            'Bearer sk-upstream-u1',
        );
        expect(db.seedanceVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ model: 'seedance-2-0', resolution: '720p' }),
        });
        expect(((await res.json()) as { model: string }).model).toBe('seedance-2-0');
    });

    it('global 短名(2026-07-23):鉴权带 region=global,适配器收 global 长名,回显短名', async () => {
        resolveEnterpriseCustomer.mockResolvedValue({ ok: true, customer: { ...CUSTOMER, region: 'global' } });
        submitVideoWithKey.mockResolvedValue(
            NextResponse.json({
                id: 'cgt-g1',
                task_id: 'cgt-g1',
                model: 'seedance2.0-global-mini-720p',
                status: 'queued',
            }),
        );
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0-global-mini', prompt: '一只猫' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(resolveEnterpriseCustomer).toHaveBeenCalledWith(expect.any(String), 'global');
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-global-mini-720p' }),
            'Bearer sk-upstream-u1',
        );
        expect(db.seedanceVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ model: 'seedance-2-0-global-mini', resolution: '720p' }),
        });
        expect(((await res.json()) as { model: string }).model).toBe('seedance-2-0-global-mini');
    });

    it('global 任务轮询:cn key → 403 region_mismatch;global key → pollVideoWithKey 带 global', async () => {
        const gTask = {
            id: 'cgt-g1',
            user_id: 'u1',
            tier: 'enterprise-portal',
            model: 'seedance-2-0-global',
            tokens: null,
            status: 'queued',
        };
        db.seedanceVideoTask.findUnique.mockResolvedValue(gTask);
        // cn key(默认 CUSTOMER)→ 403
        let res = await handleEnterpriseV1(req('GET', '/v1/video/generations/cgt-g1'), '/video/generations/cgt-g1');
        expect(res.status).toBe(403);
        expect(pollVideoWithKey).not.toHaveBeenCalled();
        // global key → 透传轮询,base 走海外
        resolveEnterpriseCustomer.mockResolvedValue({ ok: true, customer: { ...CUSTOMER, region: 'global' } });
        pollVideoWithKey.mockResolvedValue(NextResponse.json({ id: 'cgt-g1', status: 'in_progress', progress: 50 }));
        res = await handleEnterpriseV1(req('GET', '/v1/video/generations/cgt-g1'), '/video/generations/cgt-g1');
        expect(res.status).toBe(200);
        expect(pollVideoWithKey).toHaveBeenCalledWith('cgt-g1', 'Bearer sk-upstream-u1', 'global');
    });

    it('promax 短名:鉴权 region=promax,长名 seedance2.0-promax-mini-720p;1080p → 400(仅 720p)', async () => {
        resolveEnterpriseCustomer.mockResolvedValue({ ok: true, customer: { ...CUSTOMER, region: 'promax' } });
        submitVideoWithKey.mockImplementation(() =>
            Promise.resolve(NextResponse.json({ id: 'cgt-pm1', task_id: 'cgt-pm1', status: 'queued' })),
        );
        let res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0-promax-mini', prompt: '一只猫' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(resolveEnterpriseCustomer).toHaveBeenCalledWith(expect.any(String), 'promax');
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-promax-mini-720p' }),
            'Bearer sk-upstream-u1',
        );
        // fast/mini 仅 720p:1080p → 400
        res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'seedance-2-0-promax-mini',
                prompt: 'x',
                resolution: '1080p',
            }),
            '/video/generations',
        );
        expect(res.status).toBe(400);
        // promax(pro)4k 放行
        submitVideoWithKey.mockClear();
        res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0-promax', prompt: 'x', resolution: '4k' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-promax-4k' }),
            'Bearer sk-upstream-u1',
        );
    });

    it('resolution 参数选档 + 带参考图自动加 -ref:mini@1080p+images → seedance2.0-mini-1080p-ref', async () => {
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'seedance-2-0-mini',
                resolution: '1080p',
                prompt: 'x',
                images: ['https://cdn/x.png'],
            }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-mini-1080p-ref' }),
            'Bearer sk-upstream-u1',
        );
        expect(db.seedanceVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ model: 'seedance-2-0-mini', resolution: '1080p' }),
        });
    });

    it('大小写不敏感(Seedance-2-0-Fast)+ first_frame 也触发 ref', async () => {
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'Seedance-2-0-Fast',
                prompt: 'x',
                first_frame: 'https://cdn/f.png',
            }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-fast-720p-ref' }),
            'Bearer sk-upstream-u1',
        );
    });

    it('4k 仅 pro:seedance-2-0@4k 通过,fast/mini@4k → 400 不打上游', async () => {
        let res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0', resolution: '4k', prompt: 'x' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenLastCalledWith(
            expect.objectContaining({ model: 'seedance2.0-pro-4k' }),
            'Bearer sk-upstream-u1',
        );
        submitVideoWithKey.mockClear();
        res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0-fast', resolution: '4k', prompt: 'x' }),
            '/video/generations',
        );
        expect(res.status).toBe(400);
        expect(submitVideoWithKey).not.toHaveBeenCalled();
    });

    it('非法 resolution → 400;旧长名仍兼容', async () => {
        const bad = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0', resolution: '2k', prompt: 'x' }),
            '/video/generations',
        );
        expect(bad.status).toBe(400);
        const legacy = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance2.0-fast-1080p', prompt: 'x' }),
            '/video/generations',
        );
        expect(legacy.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenLastCalledWith(
            expect.objectContaining({ model: 'seedance2.0-fast-1080p' }),
            'Bearer sk-upstream-u1',
        );
    });

    it('素材引用(asset→URL)也触发 ref 识别(替换在识别之前)', async () => {
        resolveAssetRefs.mockResolvedValue({
            model: 'seedance-2-0',
            prompt: 'x',
            images: ['https://r2/asset-1.png'],
        });
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'seedance-2-0',
                prompt: 'x',
                images: ['asset-20260719120000-aaaaaa'],
            }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-pro-720p-ref' }),
            'Bearer sk-upstream-u1',
        );
    });
});

describe('轮询', () => {
    const task = {
        id: 'cgt-e1',
        user_id: 'u1',
        tier: 'enterprise-portal',
        model: 'seedance-2-0',
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
        expect(pollVideoWithKey).toHaveBeenCalledWith('cgt-e1', 'Bearer sk-upstream-u1', 'cn');
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
        pollVideoWithKey.mockResolvedValue(
            NextResponse.json({ id: 'cgt-e1', status: 'failed', fail_reason: 'sensitive content' }),
        );
        await handleEnterpriseV1(req('GET', '/v1/video/generations/cgt-e1'), '/video/generations/cgt-e1');
        expect(db.seedanceVideoTask.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: 'failed', fail_reason: 'sensitive content' } }),
        );
        expect(chargeEnterpriseVideoTask).not.toHaveBeenCalled();
    });
});
